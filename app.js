(() => {
  const $ = (selector) => document.querySelector(selector);
  const stateUrl = "/api/state";
  let state = null;
  let selected = null;
  let edits = new Map();
  let timers = new Map();
  let saving = new Map();
  let lastSignature = "";
  let viewMode = "raw";
  let saveError = false;
  const renderedEditors = new Set();
  const pencil = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11.1-11.1a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.7 7.3 3 3"/></svg>';
  const rewindIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-4 4 4 4"/><path d="M5 11h10a5 5 0 0 1 0 10h-2"/></svg>';
  const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.4 6.6"/><path d="M20 5v6h-6"/></svg>';
  const approveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';

  function label(entry) {
    return entry.side === "gray" ? "Agent" : "Request";
  }

  function toolNames(names) {
    const counts = new Map();
    names.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
    return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(", ");
  }

  function description(entry) {
    try {
      const obj = JSON.parse(entry.current_text);
      if (entry.side === "gray") {
        const calls = (obj.output || []).filter((x) => x.type === "function_call");
        return calls.length ? `Tool call${calls.length > 1 ? "s" : ""} · ${toolNames(calls.map((x) => x.name))}` : "Agent response";
      }
      const input = obj.input || [];
      const outputs = [];
      for (let i = input.length - 1; input[i]?.type === "function_call_output"; i--) outputs.unshift(input[i]);
      if (!outputs.length) return "Request";
      const names = new Map(input.filter((x) => x.type === "function_call").map((x) => [x.call_id, x.name]));
      return `Tool response${outputs.length > 1 ? "s" : ""} · ${toolNames(outputs.map((x) => names.get(x.call_id) || "tool"))}`;
    } catch { return "Edited JSON"; }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  function toolResultText(raw) {
    let value;
    try { value = JSON.parse(raw); }
    catch { return String(raw ?? ""); }
    if (!value || typeof value !== "object") return String(value);
    return Object.entries(value).filter(([, part]) => part !== "").map(([key, part]) =>
      `${key}: ${typeof part === "string" ? part : JSON.stringify(part, null, 2)}`
    ).join("\n");
  }

  function messageContent(entry) {
    let value;
    try { value = JSON.parse(edits.get(entry.id) ?? entry.current_text); }
    catch { return {text: "", tool: false}; }
    const input = value.input || [];
    let start = input.length - 1;
    while (start > 0 && input[start]?.type === "function_call_output" && input[start - 1]?.type === "function_call_output") start--;
    const items = entry.side === "gray" ? value.output || [] : input.slice(start);
    const text = items.flatMap((item) => {
      if (item.type === "function_call") return [`${item.name}(${item.arguments || ""})`];
      if (item.type === "function_call_output") return [toolResultText(item.output)];
      const content = item.content;
      if (typeof content === "string") return [content];
      if (Array.isArray(content)) return content.filter((part) =>
        part.type === "input_text" || part.type === "output_text" || part.type === "text"
      ).map((part) => part.text || "");
      return [];
    }).join("\n\n");
    return {text, tool: items.some((item) => item.type === "function_call" || item.type === "function_call_output")};
  }

  function editableParts(entry) {
    const raw = edits.get(entry.id) ?? entry.current_text;
    let value;
    try { value = JSON.parse(raw); }
    catch { return [{path: null, label: "JSON", value: raw}]; }
    const key = entry.side === "gray" ? "output" : "input";
    const items = value[key] || [];
    let indices = items.map((_, index) => index);
    if (entry.side === "blue") {
      let start = items.length;
      while (start > 0 && items[start - 1]?.type === "function_call_output") start--;
      indices = start < items.length ? indices.slice(start) : [items.findLastIndex((item) => item.role === "user")];
    }
    const names = new Map((value.input || []).filter((item) => item.type === "function_call")
      .map((item) => [item.call_id, item.name]));
    const parts = [];
    for (const index of indices) {
      const item = items[index];
      if (!item) continue;
      if (typeof item.arguments === "string") parts.push({path: [key, index, "arguments"], label: `${item.name || "Tool"} arguments`, value: item.arguments});
      if (typeof item.output === "string") parts.push({path: [key, index, "output"], label: `${names.get(item.call_id) || "Tool"} result`, value: item.output});
      if (typeof item.content === "string") parts.push({path: [key, index, "content"], label: "Message", value: item.content});
      if (Array.isArray(item.content)) item.content.forEach((content, partIndex) => {
        if (typeof content.text === "string") parts.push({path: [key, index, "content", partIndex, "text"], label: "Message", value: content.text});
      });
    }
    return parts.length ? parts : [{path: null, label: "JSON", value: raw}];
  }

  function showPreview(el, entry) {
    const content = messageContent(entry);
    el.classList.toggle("tool-output", content.tool);
    el.textContent = content.text;
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function showNotice(message, error = false) {
    const el = $("#notice");
    el.textContent = message;
    el.hidden = !message;
    el.classList.toggle("error", error);
  }

  function updateSaveStatus() {
    const last = state?.entries.at(-1);
    const status = state?.busy ? "Approved request is being sent." :
      saveError ? "Local save failed. Changes have not been sent." :
      saving.size ? "Saving edits locally. Changes have not been sent." :
      edits.size ? "Unsaved edits in this browser. Changes have not been sent." :
      state?.error ? "Last send failed. Review the error below." :
      last?.status === "stale" ? "Gray edits saved locally. Refresh the blue draft." :
      last?.side === "blue" && last.status === "draft" ? "All edits saved locally. Draft has not been sent." :
      "All edits saved locally.";
    $("#save-status").textContent = status;
  }

  function updateModelName() {
    const blue = [...(state?.entries || [])].reverse().find((entry) => entry.side === "blue");
    let request;
    try { request = JSON.parse(edits.get(blue?.id) ?? blue?.current_text); }
    catch {
      try { request = JSON.parse(blue?.current_text); }
      catch { request = null; }
    }
    const model = typeof request?.model === "string" ? request.model : "";
    const program = typeof request?.access_programs?.cyber === "string" ? request.access_programs.cyber : "";
    $("#model-name").textContent = [model, program].filter(Boolean).join(" · ");
  }

  function isEditable(entry) {
    if (state.busy) return false;
    return renderedEditors.has(entry.id) && (entry.side === "gray" || entry.status !== "stale");
  }

  function button(text, title, action, klass = "") {
    return `<button class="${klass}" type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" data-action="${action}">${text}</button>`;
  }

  function render() {
    if (!state) return;
    const focused = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement : null;
    const focusedId = focused ? Number(focused.dataset.id) : null;
    const focusedPath = focused?.dataset.editorPath ?? null;
    const selection = focused ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const editorScroll = [...$("#stream").querySelectorAll("textarea[data-id]")].map((el) =>
      ({id: Number(el.dataset.id), path: el.dataset.editorPath ?? null, top: el.scrollTop, left: el.scrollLeft}));
    const editorAt = (id, path) => [...document.querySelectorAll(`#m-${id} textarea`)]
      .find((el) => (el.dataset.editorPath ?? null) === path);
    const entries = state.entries;
    const last = entries.at(-1);
    for (const id of renderedEditors) if (!entries.some((entry) => entry.id === id)) renderedEditors.delete(id);
    showNotice(state.error || "", !!state.error);
    updateSaveStatus();
    updateModelName();
    $("#jump").innerHTML = `<option value="">Go to message</option>` + entries.map((entry, index) =>
      `<option value="${entry.id}">#${index + 1} ${escapeHtml(description(entry))}</option>`).join("");
    $("#jump").value = selected || "";
    $("#stream").innerHTML = entries.map((entry, index) => {
      const editable = isEditable(entry);
      const editing = editable && viewMode === "rendered" && renderedEditors.has(entry.id);
      const controls = entry.side === "blue" && ["draft", "stale"].includes(entry.status) ?
        `${entry.status === "draft" ? button(approveIcon, "Approve and send", "approve", "approve") : ""}${index > 0 ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") : ""}` :
        entry === last && entry.side === "gray" ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") :
        index < entries.length - 1 ? button(rewindIcon, "Delete later messages and return here", "rewind") : "";
      const pen = !state.busy && (entry.side === "gray" || entry.status !== "stale") ?
        button(pencil, renderedEditors.has(entry.id) ? "Done editing" : "Edit message", "edit", "edit") : "";
      const taps = controls || pen ? `<div class="tapback">${controls}${pen}</div>` : "";
      const editors = editing ? `<div class="render-editors">${editableParts(entry).map((part) =>
        `<label class="render-editor"><span>${escapeHtml(part.label)}</span><textarea spellcheck="false" data-id="${entry.id}" data-editor-path="${escapeHtml(part.path ? JSON.stringify(part.path) : "")}"></textarea></label>`
      ).join("")}</div>` : "";
      return `<article class="message ${entry.side} ${entry.id === selected ? "selected" : ""} ${editing ? "editing" : ""}" id="m-${entry.id}" data-id="${entry.id}">
        <div class="message-head">#${index + 1} · ${escapeHtml(description(entry))}</div>
        <div class="bubble">${taps}${viewMode === "raw" ? `<textarea class="raw-editor" spellcheck="false" aria-label="${escapeHtml(label(entry))} JSON" data-id="${entry.id}" ${editable ? "" : "readonly"}></textarea>` : `<div class="message-text ${viewMode}" data-id="${entry.id}"></div>${editors}`}</div>
      </article>`;
    }).join("") + (state.busy?.kind === "target" ?
      `<article class="message gray pending"><div class="bubble"><span class="pending-text">Pending response from provider.</span></div></article>` :
      last?.side === "gray" ?
        `<article class="message blue pending"><div class="bubble"><span class="pending-text">Pending a response from your agent.</span><p class="pending-advice">If it stalls, send: “Read review_room/data/session.json and POST a full draft to /api/codex-draft. Do not call the target.”</p></div></article>` : "");
    entries.forEach((entry) => {
      const el = $(`#m-${entry.id} ${viewMode === "raw" ? ".raw-editor" : ".message-text"}`);
      if (el) {
        if (viewMode === "raw") el.value = edits.get(entry.id) ?? entry.current_text;
        else {
          const content = messageContent(entry);
          if (viewMode === "cleaned") el.textContent = content.text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
          else showPreview(el, entry);
        }
      }
      if (viewMode === "rendered" && renderedEditors.has(entry.id)) {
        const fields = $(`#m-${entry.id}`).querySelectorAll(".render-editor textarea");
        editableParts(entry).forEach((part, index) => { if (fields[index]) fields[index].value = part.value; });
      }
    });
    if (focusedId) {
      const el = editorAt(focusedId, focusedPath);
      if (el && !el.readOnly) {
        el.focus({preventScroll: true});
        el.setSelectionRange(...selection);
      }
    }
    for (const scroll of editorScroll) {
      const el = editorAt(scroll.id, scroll.path);
      if (el) {
        el.scrollTop = scroll.top;
        el.scrollLeft = scroll.left;
      }
    }
  }

  async function refresh(force = false, preservePosition = false) {
    try {
      const response = await fetch(stateUrl, {cache: "no-store"});
      const next = await response.json();
      const signature = JSON.stringify(next.entries.map((e) => [e.id, e.revision, e.status])) + JSON.stringify(next.busy) + next.error;
      state = next;
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      if (document.activeElement?.tagName === "TEXTAREA" && !force && !next.busy) return;
      const scroller = $("#stream");
      const previousScrollTop = scroller.scrollTop;
      const wasBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;
      render();
      if (preservePosition) scroller.scrollTop = previousScrollTop;
      else if (selected) $(`#m-${selected}`)?.scrollIntoView({block: "nearest"});
      else if (wasBottom) scroller.scrollTop = scroller.scrollHeight;
    } catch (error) { showNotice(error.message, true); }
  }

  function jump(id) {
    selected = Number(id) || null;
    $("#stream").querySelectorAll(".message").forEach((el) => el.classList.toggle("selected", Number(el.dataset.id) === selected));
    $("#jump").value = selected || "";
    if (selected) {
      location.hash = `m-${selected}`;
      $(`#m-${selected}`)?.scrollIntoView({behavior: "smooth", block: "center"});
    }
  }

  function captureViewAnchor(scroller) {
    const box = scroller.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    const messages = [...scroller.querySelectorAll(".message[data-id]")];
    const visible = messages.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    });
    const anchor = visible.find((el) => Number(el.dataset.id) === selected) ||
      visible.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top <= middle && rect.bottom >= middle;
      }) || visible.at(-1) || messages.at(-1);
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    const point = Math.max(rect.top, Math.min(middle, rect.bottom));
    return {id: anchor.id, fraction: (point - rect.top) / rect.height, point};
  }

  async function saveEdit(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (saving.has(id)) await saving.get(id);
    if (!edits.has(id)) return;
    const raw = edits.get(id);
    const entry = state.entries.find((x) => x.id === id);
    if (!entry || entry.current_text === raw) { edits.delete(id); updateSaveStatus(); return; }
    try {
      const work = api("/api/edit", {id, text: raw});
      saving.set(id, work);
      updateSaveStatus();
      await work;
      if (edits.get(id) === raw) edits.delete(id);
      saveError = false;
      await refresh(true, true);
    } catch (error) {
      saveError = true;
      showNotice(error.message, true);
      throw error;
    } finally { saving.delete(id); updateSaveStatus(); }
  }

  async function action(name, id) {
    const last = state.entries.at(-1);
    try {
      if (name === "edit") {
        if (renderedEditors.has(id)) {
          await saveEdit(id);
          renderedEditors.delete(id);
        } else {
          for (const openId of [...renderedEditors]) {
            await saveEdit(openId);
            renderedEditors.delete(openId);
          }
          renderedEditors.add(id);
        }
        if (viewMode === "cleaned") {
          viewMode = "rendered";
          $("#view-mode").dataset.mode = viewMode;
          $("#view-mode").querySelectorAll("[data-view]").forEach((button) =>
            button.setAttribute("aria-pressed", String(button.dataset.view === viewMode)));
        }
        await refresh(true, true);
        if (renderedEditors.has(id)) $(`#m-${id} textarea`)?.focus({preventScroll: true});
        return;
      } else if (name === "refresh-draft") {
        for (const editedId of [...edits.keys()]) {
          if (editedId !== id || last.side !== "blue") await saveEdit(editedId);
        }
        if (last.side === "blue") {
          clearTimeout(timers.get(id));
          timers.delete(id);
          edits.delete(id);
        }
        await Promise.allSettled([...saving.values()]);
        await api("/api/refresh-draft", {id});
        renderedEditors.delete(id);
        saveError = false;
        await refresh(true, true);
        return;
      } else if (name === "rewind") {
        const index = state.entries.findIndex((entry) => entry.id === id);
        if (index < 0 || index === state.entries.length - 1) return;
        const count = state.entries.length - index - 1;
        const detail = state.entries[index].side === "blue" ? " The selected request will become a draft again." : "";
        if (!confirm(`Delete ${count} later message${count === 1 ? "" : "s"} and return to #${index + 1}?${detail}`)) return;
        timers.forEach(clearTimeout);
        timers.clear();
        await Promise.allSettled([...saving.values()]);
        await api("/api/rewind", {id});
        edits.clear();
        renderedEditors.clear();
        saveError = false;
      } else if (name === "approve") {
        if ((edits.size || saving.size || timers.size) &&
            !confirm("Edits are not saved locally yet. Finish saving, then send the current blue JSON?")) return;
        clearTimeout(timers.get(last.id));
        timers.delete(last.id);
        if (saving.has(last.id)) await saving.get(last.id);
        const hadEarlierEdits = [...edits.keys()].some((editedId) => editedId !== last.id);
        for (const editedId of [...edits.keys()]) {
          if (editedId !== last.id) await saveEdit(editedId);
        }
        if (hadEarlierEdits) throw Error("Earlier edits changed the draft. Review it before sending.");
        if (state.entries.at(-1)?.id !== last.id || state.entries.at(-1)?.status !== "draft")
          throw Error("The agent response changed. Review a new draft before sending.");
        const draftText = edits.get(last.id) ?? state.entries.at(-1).current_text;
        await api("/api/approve", {id: last.id, text: draftText});
        edits.delete(last.id);
        saveError = false;
        selected = null;
        history.replaceState(null, "", location.pathname);
      }
      await refresh(true);
      if (name !== "approve") {
        const newest = state.entries.at(-1);
        if (newest) jump(newest.id);
      }
    } catch (error) { showNotice(error.message, true); }
  }

  document.addEventListener("input", (event) => {
    if (event.target.tagName !== "TEXTAREA") return;
    const id = Number(event.target.dataset.id);
    let raw = event.target.value;
    if (event.target.hasAttribute("data-editor-path") && event.target.dataset.editorPath) {
      const value = JSON.parse(edits.get(id) ?? state.entries.find((entry) => entry.id === id).current_text);
      const path = JSON.parse(event.target.dataset.editorPath);
      let node = value;
      for (const key of path.slice(0, -1)) node = node[key];
      node[path.at(-1)] = event.target.value;
      raw = JSON.stringify(value, null, 2);
    }
    edits.set(id, raw);
    if (viewMode === "rendered") {
      const entry = state.entries.find((item) => item.id === id);
      const preview = $(`#m-${id} .message-text`);
      if (entry && preview) showPreview(preview, entry);
    }
    saveError = false;
    updateSaveStatus();
    updateModelName();
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => saveEdit(id).catch(() => {}), 900));
  });
  document.addEventListener("blur", (event) => {
    if (event.target.tagName === "TEXTAREA") saveEdit(Number(event.target.dataset.id)).catch(() => {});
  }, true);
  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    action(btn.dataset.action, Number(btn.closest(".message")?.dataset.id || state.entries.at(-1).id));
  });
  $("#jump").addEventListener("change", (event) => jump(event.target.value));
  $("#view-mode").addEventListener("click", (event) => {
    const choice = event.target.closest("[data-view]");
    if (!choice || choice.dataset.view === viewMode) return;
    const scroller = $("#stream");
    const anchor = captureViewAnchor(scroller);
    viewMode = choice.dataset.view;
    $("#view-mode").dataset.mode = viewMode;
    $("#view-mode").querySelectorAll("[data-view]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.view === viewMode)));
    render();
    if (anchor) {
      const rect = document.getElementById(anchor.id).getBoundingClientRect();
      scroller.scrollTop += rect.top + anchor.fraction * rect.height - anchor.point;
    }
  });
  refresh(true).then(() => {
    const fromHash = Number(location.hash.replace("#m-", ""));
    if (fromHash) jump(fromHash);
  });
  setInterval(() => refresh(), 1100);
})();
