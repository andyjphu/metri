(() => {
  const $ = (selector) => document.querySelector(selector);
  const stateUrl = "/api/state";
  let state = null;
  let selected = null;
  let edits = new Map();
  let timers = new Map();
  let saving = new Map();
  let lastSignature = "";
  const viewModeKey = "better-petri:view-mode:v1";
  const collapseKey = (traceId) => `better-petri:collapse:v1:${traceId}`;
  const scrollKey = (traceId) => `better-petri:scroll:v1:${traceId}`;
  function storedValue(key) {
    try { return localStorage.getItem(key); }
    catch { return null; }
  }
  function storeValue(key, value) {
    try { localStorage.setItem(key, value); }
    catch { /* Display preferences remain usable when storage is unavailable. */ }
  }
  const storedViewMode = storedValue(viewModeKey);
  let viewMode = ["raw", "rendered"].includes(storedViewMode) ? storedViewMode : "raw";
  let collapseAll = false;
  const collapseOverrides = new Map();
  const previewCache = new Map();
  let previewFrame = null;
  let saveError = false;
  let traces = null;
  let switchingTrace = false;
  let scrollPersistenceSuspended = true;
  let scrollSaveTimer = null;
  const renderedEditors = new Set();
  const pencil = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11.1-11.1a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.7 7.3 3 3"/></svg>';
  const rewindIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-4 4 4 4"/><path d="M5 11h10a5 5 0 0 1 0 10h-2"/></svg>';
  const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.4 6.6"/><path d="M20 5v6h-6"/></svg>';
  const approveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';
  const collapseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function syncViewMode() {
    $("#view-mode").dataset.mode = viewMode;
    $("#view-mode").querySelectorAll("[data-view]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.view === viewMode)));
  }

  function loadCollapsePreferences(traceId) {
    collapseAll = false;
    collapseOverrides.clear();
    try {
      const saved = JSON.parse(storedValue(collapseKey(traceId)));
      if (!saved || typeof saved !== "object") return;
      collapseAll = saved.all === true;
      if (Array.isArray(saved.overrides)) {
        for (const [id, collapsed] of saved.overrides) {
          if (Number.isSafeInteger(id) && typeof collapsed === "boolean") collapseOverrides.set(id, collapsed);
        }
      }
    } catch { /* Ignore absent or invalid saved preferences. */ }
  }

  function saveCollapsePreferences() {
    if (!traces?.active) return;
    storeValue(collapseKey(traces.active), JSON.stringify({all: collapseAll, overrides: [...collapseOverrides]}));
  }

  function isCollapsed(entry) {
    return collapseOverrides.get(entry.id) ?? collapseAll;
  }

  function label(entry) {
    return entry.side === "gray" ? "Agent" : "Request";
  }

  function toolNames(names) {
    const counts = new Map();
    names.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
    return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(", ");
  }

  function currentInputItems(input) {
    let start = input.length;
    if (input[start - 1]?.role === "user") start--;
    while (start > 0 && input[start - 1]?.type === "function_call_output") start--;
    return input.slice(start);
  }

  function description(entry) {
    try {
      const obj = JSON.parse(entry.current_text);
      if (entry.side === "gray") {
        const calls = (obj.output || []).filter((x) => x.type === "function_call");
        return calls.length ? `Tool call${calls.length > 1 ? "s" : ""} · ${toolNames(calls.map((x) => x.name))}` : "Agent response";
      }
      const input = obj.input || [];
      const current = currentInputItems(input);
      const outputs = current.filter((x) => x.type === "function_call_output");
      if (!outputs.length) return "Request";
      const names = new Map(input.filter((x) => x.type === "function_call").map((x) => [x.call_id, x.name]));
      const message = current.some((x) => x.role === "user") ? " + user message" : "";
      return `Tool response${outputs.length > 1 ? "s" : ""} · ${toolNames(outputs.map((x) => names.get(x.call_id) || "tool"))}${message}`;
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

  function previewParts(entry) {
    let value;
    try { value = JSON.parse(edits.get(entry.id) ?? entry.current_text); }
    catch { return []; }
    const input = value.input || [];
    const items = entry.side === "gray" ? value.output || [] : currentInputItems(input);
    const names = new Map(input.filter((item) => item.type === "function_call")
      .map((item) => [item.call_id, item.name]));
    return items.flatMap((item) => {
      if (item.type === "function_call") return [{label: item.name || "Tool", text: item.arguments || "", tool: true}];
      if (item.type === "function_call_output") return [{label: `${names.get(item.call_id) || "Tool"} result`, text: toolResultText(item.output), tool: true}];
      const content = item.content;
      if (typeof content === "string") return [{label: "Message", text: content, tool: false}];
      if (Array.isArray(content)) return content.filter((part) =>
        part.type === "input_text" || part.type === "output_text" || part.type === "text"
      ).map((part) => ({label: "Message", text: part.text || "", tool: false}));
      return [];
    });
  }

  function messageContent(entry) {
    const parts = previewParts(entry);
    return {text: parts.map((part) => part.tool ? `${part.label}: ${part.text}` : part.text).join("\n\n"),
      tool: parts.some((part) => part.tool)};
  }

  function summaryText(entry) {
    const cached = previewCache.get(entry.id);
    if (cached?.revision === entry.revision && !edits.has(entry.id)) return cached.text;
    const text = messageContent(entry).text.replace(/\s+/g, " ").trim().slice(0, 500) || description(entry);
    if (!edits.has(entry.id)) previewCache.set(entry.id, {revision: entry.revision, text});
    return text;
  }

  function queueVisiblePreviews() {
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = null;
      const scroller = $("#stream");
      const viewport = scroller.getBoundingClientRect();
      let filled = 0;
      let more = false;
      for (const article of scroller.querySelectorAll(".message.collapsed[data-id]")) {
        const box = article.getBoundingClientRect();
        if (box.bottom < viewport.top || box.top > viewport.bottom) continue;
        const entry = state.entries.find((item) => item.id === Number(article.dataset.id));
        if (!entry || article.dataset.previewRevision === String(entry.revision)) continue;
        if (filled >= 4) { more = true; continue; }
        article.querySelector(".collapsed-preview").textContent = summaryText(entry);
        article.dataset.previewRevision = String(entry.revision);
        filled++;
      }
      if (more) queueVisiblePreviews();
    });
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
      const start = items.length - currentInputItems(items).length;
      indices = indices.slice(start);
    }
    const names = new Map((value.input || []).filter((item) => item.type === "function_call")
      .map((item) => [item.call_id, item.name]));
    const parts = [];
    for (const index of indices) {
      const item = items[index];
      if (!item) continue;
      if (typeof item.arguments === "string") parts.push({path: [key, index, "arguments"], label: item.name || "Tool", value: item.arguments});
      if (typeof item.output === "string") parts.push({path: [key, index, "output"], label: `${names.get(item.call_id) || "Tool"} result`, value: item.output});
      if (typeof item.content === "string") parts.push({path: [key, index, "content"], label: "Message", value: item.content});
      if (Array.isArray(item.content)) item.content.forEach((content, partIndex) => {
        if (typeof content.text === "string") parts.push({path: [key, index, "content", partIndex, "text"], label: "Message", value: content.text});
      });
    }
    return parts.length ? parts : [{path: null, label: "JSON", value: raw}];
  }

  function showPreview(el, entry) {
    const parts = previewParts(entry);
    const sections = parts.length > 1 || parts.some((part) => part.tool);
    el.classList.toggle("tool-output", sections);
    if (!sections) {
      el.textContent = parts[0]?.text || "";
      return;
    }
    el.replaceChildren(...parts.map((part) => {
      const section = document.createElement("div");
      section.className = "message-section";
      const label = document.createElement("div");
      label.className = "message-section-label";
      label.textContent = part.label;
      const body = document.createElement("div");
      body.className = `message-section-body ${part.tool ? "tool" : ""}`;
      body.textContent = part.text;
      section.append(label, body);
      return section;
    }));
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
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(state?.saved_at)) / 1000));
    const age = elapsed < 60 ? `${Math.floor(elapsed / 5) * 5}s` :
      elapsed < 3600 ? `${Math.floor(elapsed / 60)}min` :
      elapsed < 86400 ? `${Math.floor(elapsed / 3600)}h` :
      `${Math.floor(elapsed / 86400)}d`;
    const status = state?.busy ? "Sending..." :
      saveError ? "Save failed" :
      saving.size ? "Saving..." :
      edits.size ? "Unsaved edits" :
      state?.error ? "Send failed" :
      Number.isFinite(elapsed) ? `Saved ${age} ago` : "Saved locally";
    $("#save-status").textContent = status;
  }

  function updateStatusIndicators() {
    const blue = [...(state?.entries || [])].reverse().find((entry) => entry.side === "blue");
    let request;
    try { request = JSON.parse(edits.get(blue?.id) ?? blue?.current_text); }
    catch {
      try { request = JSON.parse(blue?.current_text); }
      catch { request = null; }
    }
    const model = typeof request?.model === "string" ? request.model : "";
    const program = typeof request?.access_programs?.cyber === "string" ? request.access_programs.cyber : "";
    $("#status-model").textContent = model;
    $("#status-program").textContent = program ? `${program}: enabled` : "";
    $("#status-program").hidden = !program;
  }

  function renderRequestContext() {
    const body = $("#request-context-body");
    const first = state?.entries?.[0];
    if (!first) { body.replaceChildren(); return; }
    let request;
    try { request = JSON.parse(edits.get(first.id) ?? first.current_text); }
    catch { body.textContent = "Message #1 has invalid JSON."; return; }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      body.textContent = "Message #1 is not a request object.";
      return;
    }
    const field = (label, value, className = "") => {
      const section = document.createElement("section");
      section.className = "context-field";
      const heading = document.createElement("div");
      heading.className = "context-label";
      heading.textContent = label;
      const content = document.createElement("pre");
      content.className = `context-value ${className}`;
      content.textContent = value;
      section.append(heading, content);
      return section;
    };
    const hasPrompt = Object.hasOwn(request, "instructions");
    const prompt = hasPrompt ? request.instructions : undefined;
    const promptText = !hasPrompt ? "(not set)" : viewMode === "raw" ?
      JSON.stringify(prompt, null, 2) : typeof prompt === "string" ? prompt : JSON.stringify(prompt, null, 2);
    const settings = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "instructions" && key !== "input"));
    const sections = [field("System prompt", promptText, viewMode === "raw" ? "raw" : "")];
    if (viewMode === "raw") {
      sections.push(field("Settings", JSON.stringify(settings, null, 2), "raw"));
    } else {
      for (const [key, value] of Object.entries(settings)) {
        sections.push(field(key, typeof value === "string" ? value : JSON.stringify(value, null, 2),
          typeof value === "object" ? "settings-json" : ""));
      }
    }
    body.replaceChildren(...sections);
  }

  async function loadTraces() {
    const response = await fetch("/api/traces", {cache: "no-store"});
    if (!response.ok) throw Error("Could not load traces.");
    traces = await response.json();
    const selector = $("#trace-select");
    selector.replaceChildren(...traces.traces.map((trace) => {
      const option = document.createElement("option");
      option.value = trace.id;
      option.textContent = trace.name;
      return option;
    }));
    selector.value = traces.active;
  }

  async function finishEdits() {
    for (const id of [...edits.keys()]) await saveEdit(id);
    await Promise.all([...saving.values()]);
    if (edits.size || saveError) throw Error("Finish saving edits before switching traces.");
  }

  async function selectTrace(id) {
    if (!traces || id === traces.active || switchingTrace) return;
    switchingTrace = true;
    const selector = $("#trace-select");
    selector.disabled = true;
    try {
      await finishEdits();
      clearTimeout(scrollSaveTimer);
      saveScrollPosition();
      scrollPersistenceSuspended = true;
      await api("/api/select-trace", {id});
      timers.forEach(clearTimeout);
      timers.clear();
      edits.clear();
      saving.clear();
      renderedEditors.clear();
      previewCache.clear();
      selected = null;
      lastSignature = "";
      history.replaceState(null, "", location.pathname);
      await loadTraces();
      loadCollapsePreferences(traces.active);
      await refresh(true);
      restoreScrollPosition();
      showNotice("");
    } catch (error) {
      selector.value = traces.active;
      showNotice(error.message, true);
    } finally {
      scrollPersistenceSuspended = false;
      switchingTrace = false;
      selector.disabled = false;
    }
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
    for (const id of collapseOverrides.keys()) if (!entries.some((entry) => entry.id === id)) collapseOverrides.delete(id);
    for (const id of previewCache.keys()) if (!entries.some((entry) => entry.id === id)) previewCache.delete(id);
    showNotice(state.error || "", !!state.error);
    updateSaveStatus();
    updateStatusIndicators();
    renderRequestContext();
    $("#collapse-all").checked = collapseAll;
    $("#messages").innerHTML = entries.map((entry, index) => {
      const collapsed = isCollapsed(entry);
      const desc = description(entry);
      const editable = isEditable(entry);
      const editing = editable && viewMode === "rendered" && renderedEditors.has(entry.id);
      const controls = entry.side === "blue" && ["draft", "stale"].includes(entry.status) ?
        `${entry.status === "draft" ? button(approveIcon, "Approve and send", "approve", "approve") : ""}${index > 0 ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") : ""}` :
        entry === last && entry.side === "gray" ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") :
        index < entries.length - 1 ? button(rewindIcon, "Delete later messages and return here", "rewind") : "";
      const pen = !state.busy && (entry.side === "gray" || entry.status !== "stale") ?
        button(pencil, renderedEditors.has(entry.id) ? "Done editing" : "Edit message", "edit", "edit") : "";
      const caret = `<button class="collapse" type="button" title="${collapsed ? "Expand" : "Collapse"} bubble" aria-label="${collapsed ? "Expand" : "Collapse"} bubble" aria-expanded="${!collapsed}" data-action="collapse">${collapseIcon}</button>`;
      const taps = `<div class="tapback">${controls}${pen}${caret}</div>`;
      const editors = editing ? `<div class="render-editors">${editableParts(entry).map((part) =>
        `<label class="render-editor"><span>${escapeHtml(part.label)}</span><textarea spellcheck="false" data-id="${entry.id}" data-editor-path="${escapeHtml(part.path ? JSON.stringify(part.path) : "")}"></textarea></label>`
      ).join("")}</div>` : "";
      const cached = previewCache.get(entry.id);
      const preview = cached?.revision === entry.revision ? cached.text : desc;
      return `<article class="message ${entry.side} ${collapsed ? "collapsed" : ""} ${entry.id === selected ? "selected" : ""} ${editing ? "editing" : ""}" id="m-${entry.id}" data-id="${entry.id}">
        <div class="message-head">#${index + 1} · ${escapeHtml(desc)}</div>
        <div class="bubble">${taps}<div class="collapsed-preview ${viewMode}">${escapeHtml(preview)}</div><div class="expanded-content">${viewMode === "raw" ? `<textarea class="raw-editor" spellcheck="false" aria-label="${escapeHtml(label(entry))} JSON" data-id="${entry.id}" ${editable ? "" : "readonly"}></textarea>` : `<div class="message-text ${viewMode}" data-id="${entry.id}"></div>${editors}`}</div></div>
      </article>`;
    }).join("") + (state.run_complete ? "" : state.busy?.kind === "target" ?
      `<article class="message gray pending"><div class="bubble"><span class="pending-text">Pending response from provider.</span></div></article>` :
      last?.side === "gray" ?
        `<article class="message blue pending"><div class="bubble"><span class="pending-text">Pending a response from your agent.</span><p class="pending-advice">If it stalls, send: “Read review_room/data/session.json and POST a full draft to /api/codex-draft. Do not call the target.”</p></div></article>` : "");
    entries.forEach((entry) => {
      if (isCollapsed(entry)) return;
      const el = $(`#m-${entry.id} ${viewMode === "raw" ? ".raw-editor" : ".message-text"}`);
      if (el) {
        if (viewMode === "raw") el.value = edits.get(entry.id) ?? entry.current_text;
        else {
          const content = messageContent(entry);
          // Legacy Cleaned view is retained for compatibility, but is no longer updated.
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
    queueVisiblePreviews();
  }

  async function refresh(force = false, preservePosition = false) {
    try {
      const response = await fetch(stateUrl, {cache: "no-store"});
      const next = await response.json();
      const signature = JSON.stringify(next.entries.map((e) => [e.id, e.revision, e.status])) + JSON.stringify(next.busy) + next.error + next.auto_mode + next.run_complete;
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
    if (selected) {
      location.hash = `m-${selected}`;
      $(`#m-${selected}`)?.scrollIntoView({behavior: "smooth", block: "center"});
    }
  }

  function captureViewAnchor(scroller) {
    const box = scroller.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    const messages = [$("#request-context"), ...scroller.querySelectorAll(".message[data-id]")];
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

  function saveScrollPosition() {
    if (scrollPersistenceSuspended || !traces?.active || !state) return;
    const scroller = $("#stream");
    const anchor = captureViewAnchor(scroller);
    const editors = [...scroller.querySelectorAll("textarea[data-id]")]
      .filter((el) => el.scrollTop || el.scrollLeft)
      .map((el) => ({id: Number(el.dataset.id), path: el.dataset.editorPath ?? null,
        top: el.scrollTop, left: el.scrollLeft}));
    storeValue(scrollKey(traces.active), JSON.stringify({
      top: scroller.scrollTop,
      anchor: anchor && {id: anchor.id, fraction: anchor.fraction,
        pointOffset: anchor.point - scroller.getBoundingClientRect().top},
      editors,
    }));
  }

  function scheduleScrollSave() {
    if (scrollPersistenceSuspended) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScrollPosition, 150);
  }

  function restoreScrollPosition() {
    let saved;
    try { saved = JSON.parse(storedValue(scrollKey(traces.active))); }
    catch { return false; }
    if (!saved || !Number.isFinite(saved.top)) return false;
    const scroller = $("#stream");
    scroller.scrollTop = saved.top;
    const anchor = saved.anchor;
    const element = anchor && document.getElementById(anchor.id);
    if (element && Number.isFinite(anchor.fraction) && Number.isFinite(anchor.pointOffset)) {
      const rect = element.getBoundingClientRect();
      scroller.scrollTop += rect.top + anchor.fraction * rect.height -
        scroller.getBoundingClientRect().top - anchor.pointOffset;
    }
    for (const editor of saved.editors || []) {
      const el = [...scroller.querySelectorAll(`textarea[data-id="${Number(editor.id)}"]`)]
        .find((item) => (item.dataset.editorPath ?? null) === editor.path);
      if (el) {
        el.scrollTop = editor.top;
        el.scrollLeft = editor.left;
      }
    }
    return true;
  }

  function keepPosition(update) {
    const scroller = $("#stream");
    const anchor = captureViewAnchor(scroller);
    update();
    const element = anchor && document.getElementById(anchor.id);
    if (element) {
      const rect = element.getBoundingClientRect();
      scroller.scrollTop += rect.top + anchor.fraction * rect.height - anchor.point;
    }
    queueVisiblePreviews();
  }

  function keepMessageTop(id, update) {
    const scroller = $("#stream");
    const article = $(`#m-${id}`);
    const before = article?.getBoundingClientRect().top;
    update();
    const after = $(`#m-${id}`)?.getBoundingClientRect().top;
    if (before !== undefined && after !== undefined) scroller.scrollTop += after - before;
    queueVisiblePreviews();
  }

  function renderAtCurrentPosition() {
    keepPosition(render);
  }

  function populateExpanded(entry) {
    const article = $(`#m-${entry.id}`);
    if (!article) return;
    if (viewMode === "raw") {
      article.querySelector(".raw-editor").value = edits.get(entry.id) ?? entry.current_text;
    } else {
      const preview = article.querySelector(".message-text");
      if (viewMode === "cleaned") preview.textContent = messageContent(entry).text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
      else showPreview(preview, entry);
      if (renderedEditors.has(entry.id)) {
        const fields = article.querySelectorAll(".render-editor textarea");
        editableParts(entry).forEach((part, index) => { if (fields[index]) fields[index].value = part.value; });
      }
    }
  }

  function setCollapsedDom(entry, collapsed) {
    const article = $(`#m-${entry.id}`);
    if (!article) return;
    article.classList.toggle("collapsed", collapsed);
    const caret = article.querySelector("[data-action=collapse]");
    caret.title = `${collapsed ? "Expand" : "Collapse"} bubble`;
    caret.setAttribute("aria-label", caret.title);
    caret.setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) populateExpanded(entry);
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
      if (name === "collapse") {
        await saveEdit(id);
        const entry = state.entries.find((item) => item.id === id);
        if (!entry) return;
        const collapsed = !isCollapsed(entry);
        collapseOverrides.set(id, collapsed);
        saveCollapsePreferences();
        keepMessageTop(id, () => setCollapsedDom(entry, collapsed));
        return;
      } else if (name === "edit") {
        if (isCollapsed(state.entries.find((item) => item.id === id))) {
          collapseOverrides.set(id, false);
          saveCollapsePreferences();
        }
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
          storeValue(viewModeKey, viewMode);
          syncViewMode();
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
    updateStatusIndicators();
    if (id === state.entries[0]?.id) renderRequestContext();
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
  $("#collapse-all").addEventListener("change", async (event) => {
    const collapse = event.target.checked;
    try {
      for (const id of [...edits.keys()]) await saveEdit(id);
      await Promise.all([...saving.values()]);
      collapseAll = collapse;
      collapseOverrides.clear();
      saveCollapsePreferences();
      keepPosition(() => state.entries.forEach((entry) => setCollapsedDom(entry, collapse)));
    } catch (error) {
      event.target.checked = collapseAll;
      showNotice(error.message, true);
    }
  });
  $("#trace-select").addEventListener("change", (event) => selectTrace(event.target.value));
  $("#trace-rename").addEventListener("click", async () => {
    if (!traces || switchingTrace) return;
    const current = traces.traces.find((trace) => trace.id === traces.active);
    const name = prompt("Trace name", current?.name || "");
    if (name === null || name.trim() === current?.name) return;
    try {
      await api("/api/rename-trace", {name});
      await loadTraces();
    } catch (error) { showNotice(error.message, true); }
  });
  $("#view-mode").addEventListener("click", (event) => {
    const choice = event.target.closest("[data-view]");
    if (!choice || choice.dataset.view === viewMode) return;
    viewMode = choice.dataset.view;
    storeValue(viewModeKey, viewMode);
    syncViewMode();
    renderAtCurrentPosition();
  });
  $("#stream").addEventListener("scroll", (event) => {
    if (event.target === $("#stream")) queueVisiblePreviews();
    scheduleScrollSave();
  }, {capture: true, passive: true});
  window.addEventListener("pagehide", () => {
    clearTimeout(scrollSaveTimer);
    saveScrollPosition();
  });
  syncViewMode();
  loadTraces().then(async () => {
    loadCollapsePreferences(traces.active);
    await refresh(true);
    if (!restoreScrollPosition()) {
      const fromHash = Number(location.hash.replace("#m-", ""));
      if (fromHash) jump(fromHash);
    }
    scrollPersistenceSuspended = false;
  }).catch((error) => showNotice(error.message, true));
  setInterval(() => { if (!switchingTrace) refresh(); }, 1100);
  setInterval(updateSaveStatus, 1000);
})();
