(() => {
  const $ = (selector) => document.querySelector(selector);
  const stateUrl = "/api/state";
  let state = null;
  let selected = null;
  let edits = new Map();
  let timers = new Map();
  let saving = new Map();
  let lastSignature = "";
  const viewModeKey = "metri:view-mode:v1";
  const collapseKey = (traceId) => `metri:collapse:v1:${traceId}`;
  const scrollKey = (traceId) => `metri:scroll:v1:${traceId}`;
  const swapModelKey = "metri:swap-model:v1";
  const defaultModelKey = "metri:default-model:v1";
  function storedValue(key) {
    try {
      const current = localStorage.getItem(key);
      if (current !== null) return current;
      const old = localStorage.getItem(key.replace(/^metri:/, "better-petri:"));
      if (old !== null) localStorage.setItem(key, old);
      return old;
    }
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
  let modelCatalog = null;
  let switchingTrace = false;
  let traceRenameId = null;
  let changingAuto = false;
  let changingDraftSource = false;
  let changingAutoGenerate = false;
  let sendingId = null;
  let editMutationPending = false;
  let scrollPersistenceSuspended = true;
  let scrollSaveTimer = null;
  let railPoints = [];
  let railSignature = "";
  let railFrame = null;
  let messageSearch = null;
  let messageMatches = [];
  const renderedEditors = new Set();
  const pencil = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11.1-11.1a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.7 7.3 3 3"/></svg>';
  const rewindIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-4 4 4 4"/><path d="M5 11h10a5 5 0 0 1 0 10h-2"/></svg>';
  const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.4 6.6"/><path d="M20 5v6h-6"/></svg>';
  const swapIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/></svg>';
  const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/></svg>';
  const approveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';
  const discardIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>';
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
      if (item.type === "reasoning") return (item.content || []).filter((part) => part.type === "reasoning_text")
        .map((part) => ({label: "Reasoning", text: part.text || "", tool: true}));
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
        if (typeof content.text === "string") parts.push({path: [key, index, "content", partIndex, "text"],
          label: item.type === "reasoning" ? "Reasoning" : "Message", value: content.text});
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
      state?.pending_edit ? "Edit pending" :
      edits.size ? "Unsaved edits" :
      state?.error ? "Send failed" :
      Number.isFinite(elapsed) ? `Saved ${age} ago` : "Saved locally";
    $("#save-status").textContent = status;
  }

  function renderModelCatalog() {
    if (!modelCatalog) return;
    $("#default-model-options").innerHTML = modelCatalog.models.map((option) =>
      `<button class="default-model-option" type="button" data-model-id="${escapeHtml(option.id)}" aria-pressed="${option.id === modelCatalog.default}"><span>${escapeHtml(option.model)}</span><small>${escapeHtml(option.description)}</small>${option.detail ? `<small>${escapeHtml(option.detail)}</small>` : ""}</button>`
    ).join("");
  }

  async function loadModelCatalog() {
    const response = await fetch("/api/models", {cache: "no-store"});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Could not load models.");
    modelCatalog = result;
    storeValue(defaultModelKey, result.default);
    renderModelCatalog();
  }

  function updateAutoMode() {
    if (!changingAuto) $("#auto-mode").checked = state?.auto_mode === true;
  }

  function updateDraftSource() {
    if (changingDraftSource) return;
    const source = state?.draft_source === "api" ? "api" : "codex";
    $("#draft-source-control").dataset.mode = source;
    $("#draft-source-control").querySelectorAll("[data-source]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.source === source)));
  }

  function updateAutoGenerate() {
    if (!changingAutoGenerate) $("#auto-generate").checked = state?.auto_generate !== false;
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
    const current = traces.traces.find((trace) => trace.id === traces.active);
    $("#trace-current").textContent = current?.name || "Select trace";
    const rows = traces.traces.map((trace) => {
      const row = document.createElement("div");
      row.className = "trace-row";
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "trace-choice";
      choice.dataset.traceId = trace.id;
      choice.textContent = trace.name;
      choice.setAttribute("aria-current", trace.id === traces.active ? "true" : "false");
      row.append(choice);
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "trace-row-rename";
      rename.setAttribute("aria-label", `Rename ${trace.name}`);
      rename.title = "Rename trace";
      rename.innerHTML = pencil;
      row.append(rename);
      return row;
    });
    $("#trace-menu").replaceChildren(...rows);
  }

  function setTraceMenuOpen(open) {
    $("#trace-menu").hidden = !open;
    $("#trace-select").setAttribute("aria-expanded", String(open));
  }

  async function loadRailPoints() {
    const traceId = traces?.active;
    if (!traceId) return;
    const response = await fetch("/api/rail", {cache: "no-store"});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Could not load conversation map.");
    if (traces?.active !== traceId) return;
    const signature = JSON.stringify(result.points);
    if (signature === railSignature) return;
    railSignature = signature;
    railPoints = result.points;
    scheduleRailLayout();
  }

  function railY(element, scroller) {
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  function updateRailThumb() {
    const scroller = $("#stream");
    const track = $("#rail-track");
    const thumb = $("#rail-thumb");
    const total = Math.max(scroller.scrollHeight, 1);
    const scale = track.clientHeight / total;
    thumb.style.top = `${scroller.scrollTop * scale}px`;
    thumb.style.height = `${Math.min(track.clientHeight, scroller.clientHeight * scale)}px`;
  }

  function layoutRail() {
    railFrame = null;
    if (!state) return;
    const scroller = $("#stream");
    const track = $("#rail-track");
    const scale = track.clientHeight / Math.max(scroller.scrollHeight, 1);
    const segments = document.createDocumentFragment();
    for (const article of scroller.querySelectorAll(".message[data-id]")) {
      const kind = ["agent-tool", "agent-text", "tool-result", "request"]
        .find((name) => article.classList.contains(name));
      if (!kind) continue;
      const segment = document.createElement("span");
      segment.className = `rail-segment ${kind}`;
      segment.style.top = `${railY(article, scroller) * scale}px`;
      segment.style.height = `${article.getBoundingClientRect().height * scale}px`;
      segments.append(segment);
    }
    $("#rail-segments").replaceChildren(segments);
    const points = document.createDocumentFragment();
    for (const point of railPoints) {
      const article = $(`#m-${point.message}`);
      if (!article) continue;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "rail-point";
      dot.dataset.message = point.message;
      dot.setAttribute("aria-label", `Message ${messageNumber(state.entries[point.message - 1], point.message - 1)}: ${point.label}`);
      dot.style.top = `${railY(article, scroller) * scale}px`;
      const label = document.createElement("span");
      label.className = "rail-label";
      label.textContent = point.label;
      dot.append(label);
      points.append(dot);
    }
    $("#rail-points").replaceChildren(points);
    updateRailThumb();
  }

  function scheduleRailLayout() {
    if (railFrame === null) railFrame = requestAnimationFrame(layoutRail);
  }

  function updateMessageSearch(reveal = false) {
    if (!messageSearch) return;
    const article = $(`#m-${messageSearch.id}`);
    if (!article) { messageSearch = null; messageMatches = []; return; }
    article.querySelectorAll("mark.message-search-hit").forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
    messageMatches = [];
    const query = messageSearch.query.toLowerCase();
    if (query) {
      const editors = article.querySelectorAll(".raw-editor, .editing .render-editor textarea");
      if (editors.length) {
        for (const editor of editors) {
          const text = editor.value.toLowerCase();
          let at = 0;
          while ((at = text.indexOf(query, at)) !== -1 && messageMatches.length < 500) {
            messageMatches.push({editor, start: at, end: at + query.length});
            at += Math.max(query.length, 1);
          }
        }
      } else {
        const root = article.querySelector(".message-text");
        if (root) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          for (const node of nodes) {
            if (messageMatches.length >= 500) break;
            const value = node.nodeValue;
            const lower = value.toLowerCase();
            let at = 0;
            let previous = 0;
            const fragment = document.createDocumentFragment();
            while ((at = lower.indexOf(query, at)) !== -1 && messageMatches.length < 500) {
              fragment.append(document.createTextNode(value.slice(previous, at)));
              const mark = document.createElement("mark");
              mark.className = "message-search-hit";
              mark.textContent = value.slice(at, at + query.length);
              fragment.append(mark);
              messageMatches.push({mark});
              previous = at + query.length;
              at = previous;
            }
            if (previous) {
              fragment.append(document.createTextNode(value.slice(previous)));
              node.replaceWith(fragment);
            }
          }
        }
      }
    }
    if (messageSearch.index >= messageMatches.length) messageSearch.index = 0;
    const count = article.querySelector(".message-search-count");
    if (count) count.textContent = query ? `${messageMatches.length ? messageSearch.index + 1 : 0}/${messageMatches.length}${messageMatches.length === 500 ? "+" : ""}` : "";
    messageMatches.forEach((match, index) => match.mark?.classList.toggle("current", index === messageSearch.index));
    if (reveal && messageMatches.length) {
      const match = messageMatches[messageSearch.index];
      if (match.mark) match.mark.scrollIntoView({block: "nearest"});
      else {
        match.editor.focus({preventScroll: true});
        match.editor.setSelectionRange(match.start, match.end);
        const lines = match.editor.value.slice(0, match.start).split("\n").length - 1;
        const lineHeight = Number.parseFloat(getComputedStyle(match.editor).lineHeight) || 18;
        match.editor.scrollTop = Math.max(0, lines * lineHeight - match.editor.clientHeight / 2);
        article.querySelector(".message-search-input")?.focus({preventScroll: true});
      }
    }
  }

  async function finishEdits() {
    if (state?.pending_edit || edits.size) throw Error("Confirm or discard the edit first.");
    if (saveError) throw Error("Finish saving edits before continuing.");
  }

  async function selectTrace(id) {
    if (!traces || id === traces.active || switchingTrace) return;
    switchingTrace = true;
    const selector = $("#trace-select");
    selector.disabled = true;
    setTraceMenuOpen(false);
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
      await loadRailPoints();
      await refresh(true);
      restoreScrollPosition();
      showNotice("");
    } catch (error) {
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

  function messageNumber(entry, index) {
    return `#${index + 1}.${state.version_numbers?.[entry.id] ?? 1}`;
  }

  function messageHeading(entry, index) {
    const slug = state.model_slugs?.[entry.id];
    const manual = entry.versions?.find((version) => version.id === entry.active_version)?.kind === "manual";
    return `${messageNumber(entry, index)}${slug ? ` · ${escapeHtml(slug)}` : ""}${manual ? " · Manual" : ""}`;
  }

  function manualContext() {
    const last = state.entries.at(-1);
    const blue = last.side === "blue" ? last : state.entries.at(-2);
    const request = JSON.parse(blue.current_text);
    const tools = (request.tools || []).filter((tool) => tool?.type === "function" && typeof tool.name === "string");
    const calls = last.side === "gray" ? JSON.parse(last.current_text).output.filter((item) => item?.type === "function_call") : [];
    return {last, request, tools, calls};
  }

  function schemaTemplate(schema) {
    if (schema?.enum?.length) return schema.enum[0];
    if (schema?.type === "object") return Object.fromEntries((schema.required || [])
      .map((key) => [key, schemaTemplate(schema.properties?.[key])]));
    if (schema?.type === "array") return [];
    if (schema?.type === "boolean") return false;
    if (schema?.type === "integer" || schema?.type === "number") return 0;
    return "";
  }

  function updateManualButtons() {
    const dialog = $("#manual-dialog");
    const parts = [...dialog.querySelectorAll(".manual-part")];
    const context = manualContext();
    $("#manual-add-message").disabled = parts.some((part) => part.dataset.kind === "message");
    $("#manual-add-tool").disabled = dialog.dataset.side === "gray" ? !context.tools.length :
      !context.calls.some((call) => !parts.some((part) => part.dataset.kind === "tool" && part.querySelector("select")?.value === call.call_id));
  }

  function addManualPart(kind) {
    const dialog = $("#manual-dialog");
    const context = manualContext();
    const gray = dialog.dataset.side === "gray";
    const part = document.createElement("div");
    part.className = "manual-part";
    part.dataset.kind = kind;
    const title = kind === "message" ? (gray ? "Response" : "User message") : (gray ? "Tool call" : "Tool result");
    const choices = kind !== "tool" ? "" : gray ?
      `<select aria-label="Tool">${context.tools.map((tool) => `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</option>`).join("")}</select>` :
      `<select aria-label="Tool call">${context.calls.map((call) => `<option value="${escapeHtml(call.call_id)}">${escapeHtml(call.name)} · ${escapeHtml(call.call_id)}</option>`).join("")}</select>`;
    part.innerHTML = `<div class="manual-part-head"><span>${title}</span><button type="button" aria-label="Remove ${title.toLowerCase()}" class="manual-remove">×</button></div>${choices}<textarea spellcheck="false" aria-label="${kind === "message" ? title : gray ? "Tool arguments JSON" : "Tool result"}"></textarea>`;
    $("#manual-parts").append(part);
    if (kind === "tool" && gray) {
      const tool = context.tools.find((item) => item.name === part.querySelector("select").value);
      part.querySelector("textarea").value = JSON.stringify(schemaTemplate(tool?.parameters || {type: "object"}), null, 2);
    }
    if (kind === "tool" && !gray) {
      const used = [...dialog.querySelectorAll(".manual-part[data-kind=tool] select")].slice(0, -1).map((item) => item.value);
      part.querySelector("select").value = context.calls.find((call) => !used.includes(call.call_id))?.call_id || "";
    }
    updateManualButtons();
    part.querySelector("textarea").focus();
  }

  async function openManualComposer() {
    await finishEdits();
    const context = manualContext();
    if (state.auto_mode || state.busy || state.run_complete) throw Error("Pause Auto before adding a manual message.");
    const dialog = $("#manual-dialog");
    dialog.dataset.side = context.last.side === "blue" ? "gray" : "blue";
    dialog.dataset.sourceId = context.last.id;
    $("#manual-title").textContent = dialog.dataset.side === "gray" ? "Manual response" : "Manual request";
    $("#manual-add-message").textContent = dialog.dataset.side === "gray" ? "+ Response" : "+ User message";
    $("#manual-add-tool").textContent = dialog.dataset.side === "gray" ? "+ Tool call" : "+ Tool result";
    $("#manual-submit").textContent = dialog.dataset.side === "gray" ? "Create response" : "Create draft";
    $("#manual-parts").replaceChildren();
    $("#manual-error").hidden = true;
    updateManualButtons();
    dialog.showModal();
  }

  function render() {
    if (!state) return;
    const focused = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement : null;
    const searchFocused = document.activeElement?.classList.contains("message-search-input") === true;
    const focusedId = focused ? Number(focused.dataset.id) : null;
    const focusedPath = focused?.dataset.editorPath ?? null;
    const selection = focused ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const editorScroll = [...$("#stream").querySelectorAll("textarea[data-id]")].map((el) =>
      ({id: Number(el.dataset.id), path: el.dataset.editorPath ?? null, top: el.scrollTop, left: el.scrollLeft}));
    const editorAt = (id, path) => [...document.querySelectorAll(`#m-${id} textarea`)]
      .find((el) => (el.dataset.editorPath ?? null) === path);
    const entries = state.entries;
    const last = entries.at(-1);
    const swapIndex = state.busy?.kind === "swap" ?
      entries.findIndex((entry) => entry.id === state.busy.entry_id) : -1;
    const visibleEntries = swapIndex < 0 ? entries : entries.slice(0, swapIndex + 1);
    const auditorByGray = new Map();
    for (const exchange of state.auditor_history || []) {
      const items = auditorByGray.get(exchange.after_gray_id) || [];
      items.push(exchange);
      auditorByGray.set(exchange.after_gray_id, items);
    }
    for (const id of renderedEditors) if (!entries.some((entry) => entry.id === id)) renderedEditors.delete(id);
    for (const id of collapseOverrides.keys()) if (!entries.some((entry) => entry.id === id)) collapseOverrides.delete(id);
    for (const id of previewCache.keys()) if (!entries.some((entry) => entry.id === id)) previewCache.delete(id);
    if (messageSearch && !entries.some((entry) => entry.id === messageSearch.id)) messageSearch = null;
    showNotice(state.error || "", !!state.error);
    updateSaveStatus();
    updateAutoMode();
    updateDraftSource();
    updateAutoGenerate();
    renderRequestContext();
    $("#collapse-all").checked = collapseAll;
    $("#messages").innerHTML = visibleEntries.map((entry, index) => {
      if (index === swapIndex) return `<article class="message gray pending" id="m-${entry.id}" data-id="${entry.id}" aria-live="polite"><div class="bubble"><span class="pending-text">Pending response from provider.</span></div></article>`;
      const collapsed = isCollapsed(entry);
      const desc = description(entry);
      const editable = isEditable(entry);
      const editing = editable && viewMode === "rendered" && renderedEditors.has(entry.id);
      const pending = state.pending_edit?.id === entry.id;
      const blocked = Boolean(state.pending_edit);
      const controls = pending ? `${button(approveIcon, "Confirm edit", "confirm-edit", "approve")}${button(discardIcon, "Discard edit", "discard-edit")}` : blocked ? "" :
        entry.side === "blue" && ["draft", "stale"].includes(entry.status) ?
          `${entry.status === "draft" && !state.busy && sendingId !== entry.id ? button(approveIcon, "Approve and send", "approve", "approve") : ""}${index > 0 ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") : ""}` :
          entry === last && entry.side === "gray" ? button(refreshIcon, "Refresh blue draft", "refresh-draft", "refresh-draft") :
          index < entries.length - 1 ? button(rewindIcon, "Delete later messages and return here", "rewind") : "";
      const pen = !blocked && !state.busy && (entry.side === "gray" || entry.status !== "stale") ?
        button(pencil, "Edit message", "edit", "edit") : "";
      const caret = `<button class="collapse" type="button" title="${collapsed ? "Expand" : "Collapse"} bubble" aria-label="${collapsed ? "Expand" : "Collapse"} bubble" aria-expanded="${!collapsed}" data-action="collapse">${collapseIcon}</button>`;
      const swappable = !blocked && !state.busy && !state.auto_mode;
      const swap = swappable ? button(swapIcon, "Message versions", "swap-model") : "";
      const find = button(searchIcon, "Find in this message", "search-message");
      const taps = `<div class="tapback"><div class="tapback-extra">${controls}${swap}${find}${pen}</div>${caret}</div>`;
      const searchBar = messageSearch?.id === entry.id ?
        `<div class="message-search"><input class="message-search-input" type="search" aria-label="Find in message ${messageNumber(entry, index)}" value="${escapeHtml(messageSearch.query)}" autocomplete="off"><span class="message-search-count"></span><button type="button" data-action="close-search" aria-label="Close message search">×</button></div>` : "";
      const editors = editing ? `<div class="render-editors">${editableParts(entry).map((part) =>
        `<label class="render-editor"><span>${escapeHtml(part.label)}</span><textarea spellcheck="false" data-id="${entry.id}" data-editor-path="${escapeHtml(part.path ? JSON.stringify(part.path) : "")}"></textarea></label>`
      ).join("")}</div>` : "";
      const cached = previewCache.get(entry.id);
      const preview = cached?.revision === entry.revision ? cached.text : desc;
      const railKind = entry.side === "gray" ? (desc.startsWith("Tool call") ? "agent-tool" : "agent-text") :
        desc.startsWith("Tool response") ? "tool-result" : "request";
      const message = `<article class="message ${entry.side} ${railKind} ${collapsed ? "collapsed" : ""} ${entry.id === selected ? "selected" : ""} ${editing ? "editing" : ""} ${pending ? "pending-edit" : ""}" id="m-${entry.id}" data-id="${entry.id}">
        <div class="message-head">${messageHeading(entry, index)} · ${escapeHtml(desc)}</div>
        <div class="bubble">${taps}${searchBar}<div class="collapsed-preview ${viewMode}">${escapeHtml(preview)}</div><div class="expanded-content">${viewMode === "raw" ? `<textarea class="raw-editor" spellcheck="false" aria-label="${escapeHtml(label(entry))} JSON" data-id="${entry.id}" ${editable ? "" : "readonly"}></textarea>` : `<div class="message-text ${viewMode}" data-id="${entry.id}"></div>${editors}`}</div></div>
      </article>`;
      const auditor = (auditorByGray.get(entry.id) || []).map((exchange) => {
        const pendingAnswer = exchange.answer == null && state.auditor_exchange?.at(-1)?.question === exchange.question &&
          state.auditor_exchange?.at(-1)?.answer == null;
        return `<article class="message auditor"><div class="message-head">Auditor question (not shown to any evaluated agents)${pendingAnswer ? " | Pending response from your agent" : ""}</div><div class="bubble"><div class="auditor-part">${escapeHtml(exchange.question)}</div>${exchange.answer == null ? "" : `<div class="auditor-answer"><div class="auditor-part-label">Answer to auditor</div><div class="auditor-part">${escapeHtml(exchange.answer)}</div></div>`}</div></article>`;
      }).join("");
      return message + auditor;
    }).join("") + (state.busy?.kind === "swap" || state.run_complete ? "" : state.busy?.kind === "target" ?
      `<article class="message gray pending"><div class="bubble"><span class="pending-text">Pending response from provider.</span></div></article>` :
      last?.side === "blue" && last.status === "draft" && !state.pending_edit ?
        `<article class="message gray response-add"><div class="add-options"><button type="button" data-action="approve" aria-label="Approve request and generate AI response">+ AI</button><button type="button" data-action="manual-compose" aria-label="Create manual response">+ Manual</button></div></article>` :
      last?.side === "gray" && !state.pending_edit ?
        state.auto_generate === false && !state.draft_pending ?
          `<article class="message blue draft-add"><div class="add-options"><button type="button" data-action="refresh-draft" aria-label="Generate AI request">+ AI</button><button type="button" data-action="manual-compose" aria-label="Create manual request">+ Manual</button></div></article>` :
        state.draft_source === "api" ?
          state.draft_pending ?
            `<article class="message blue pending"><div class="bubble"><span class="pending-text">Generating draft from API.</span></div></article>` :
            state.auditor_exchange?.at(-1)?.answer === null ? "" :
              `<div class="auditor-note">${escapeHtml(state.draft_error || "No API draft pending.")}</div>` :
          `<article class="message blue pending"><div class="bubble"><span class="pending-text">Pending a response from your agent.</span><p class="pending-advice">If it stalls, send: “Read metri/data/session.json and POST a full draft to /api/codex-draft. Do not call the target.”</p></div></article>` : "");
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
        const fields = $(`#m-${entry.id}`)?.querySelectorAll(".render-editor textarea") || [];
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
    updateMessageSearch();
    if (searchFocused) $(`#m-${messageSearch?.id} .message-search-input`)?.focus({preventScroll: true});
    queueVisiblePreviews();
    scheduleRailLayout();
  }

  async function refresh(force = false, preservePosition = false) {
    try {
      const response = await fetch(stateUrl, {cache: "no-store"});
      const next = await response.json();
      if (!force && editMutationPending) return;
      if (state && Date.parse(next.saved_at) < Date.parse(state.saved_at)) return;
      if (!next.pending_edit && edits.size) {
        for (const id of edits.keys()) clearTimeout(timers.get(id));
        timers.clear();
        edits.clear();
        renderedEditors.clear();
        saveError = false;
      }
      const signature = JSON.stringify(next.entries.map((e) => [e.id, e.revision, e.status])) + JSON.stringify(next.version_numbers) + JSON.stringify(next.model_slugs) + JSON.stringify(next.busy) + next.error + next.auto_mode + next.auto_generate + next.run_complete + next.draft_source + next.draft_pending + next.draft_error + JSON.stringify(next.pending_edit) + JSON.stringify(next.auditor_exchange) + JSON.stringify(next.auditor_history);
      state = next;
      if (next.pending_edit && !edits.has(next.pending_edit.id)) {
        edits.set(next.pending_edit.id, next.pending_edit.text);
        renderedEditors.add(next.pending_edit.id);
      }
      updateAutoMode();
      updateDraftSource();
      updateAutoGenerate();
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
      history.replaceState(null, "", `#m-${selected}`);
      $(`#m-${selected}`)?.scrollIntoView({block: "start"});
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
    if (!edits.has(id) || state?.pending_edit?.id !== id) return;
    const raw = edits.get(id);
    try {
      const work = api("/api/stage-edit", {id, text: raw});
      saving.set(id, work);
      updateSaveStatus();
      await work;
      saveError = false;
    } catch (error) {
      saveError = true;
      showNotice(error.message, true);
      throw error;
    } finally { saving.delete(id); updateSaveStatus(); }
  }

  function confirmRewind(number, count) {
    const dialog = $("#rewind-dialog");
    $("#rewind-title").textContent = `Return to ${messageNumber(state.entries[number - 1], number - 1)}?`;
    $("#rewind-detail").textContent = `Delete ${count} later message${count === 1 ? "" : "s"}.`;
    $("#rewind-confirm").textContent = count === 1 ? "Delete message" : "Delete messages";
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "rewind"), {once: true});
      dialog.showModal();
    });
  }

  async function action(name, id) {
    const last = state.entries.at(-1);
    if (name === "approve" && sendingId !== null) return;
    try {
      if (name === "search-message") {
        if (messageSearch?.id === id) {
          messageSearch = null;
          messageMatches = [];
        } else {
          messageSearch = {id, query: "", index: 0};
          if (isCollapsed(state.entries.find((entry) => entry.id === id))) {
            collapseOverrides.set(id, false);
            saveCollapsePreferences();
          }
        }
        await refresh(true, true);
        $(`#m-${id} .message-search-input`)?.focus({preventScroll: true});
        return;
      } else if (name === "close-search") {
        messageSearch = null;
        messageMatches = [];
        await refresh(true, true);
        return;
      } else if (name === "collapse") {
        if (state.pending_edit?.id === id) await saveEdit(id);
        const entry = state.entries.find((item) => item.id === id);
        if (!entry) return;
        const collapsed = !isCollapsed(entry);
        collapseOverrides.set(id, collapsed);
        saveCollapsePreferences();
        keepMessageTop(id, () => setCollapsedDom(entry, collapsed));
        return;
      } else if (name === "edit") {
        editMutationPending = true;
        try {
          await api("/api/start-edit", {id});
          state.pending_edit = {id, text: state.entries.find((entry) => entry.id === id).current_text};
          edits.set(id, state.pending_edit.text);
          if (isCollapsed(state.entries.find((item) => item.id === id))) {
            collapseOverrides.set(id, false);
            saveCollapsePreferences();
          }
          renderedEditors.clear();
          renderedEditors.add(id);
          if (viewMode === "cleaned") {
            viewMode = "rendered";
            storeValue(viewModeKey, viewMode);
            syncViewMode();
          }
          await refresh(true, true);
          if (renderedEditors.has(id)) $(`#m-${id} textarea`)?.focus({preventScroll: true});
        } finally { editMutationPending = false; }
        return;
      } else if (name === "confirm-edit" || name === "discard-edit") {
        editMutationPending = true;
        try {
          if (name === "confirm-edit") {
            await saveEdit(id);
            await api("/api/confirm-edit", {id, text: edits.get(id) ?? state.pending_edit.text});
          } else {
            clearTimeout(timers.get(id));
            timers.delete(id);
            await Promise.allSettled([...saving.values()]);
            await api("/api/discard-edit", {id});
          }
          edits.delete(id);
          state.pending_edit = null;
          renderedEditors.delete(id);
          await refresh(true, true);
        } finally { editMutationPending = false; }
        return;
      } else if (name === "refresh-draft") {
        await finishEdits();
        await api("/api/refresh-draft", {id});
        renderedEditors.delete(id);
        saveError = false;
        await refresh(true, true);
        return;
      } else if (name === "manual-compose") {
        await openManualComposer();
        return;
      } else if (name === "swap-model") {
        await finishEdits();
        const index = state.entries.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        const gray = state.entries[index].side === "gray";
        const [modelResponse, variantResponse] = await Promise.all([
          gray ? fetch("/api/swap-models", {cache: "no-store"}) : Promise.resolve(null),
          fetch(`/api/message-variants?id=${id}`, {cache: "no-store"})
        ]);
        const [modelResult, variantResult] = await Promise.all([modelResponse ? modelResponse.json() : Promise.resolve({models: []}), variantResponse.json()]);
        if (modelResponse && !modelResponse.ok) throw Error(modelResult.error || "Could not load model choices.");
        if (!variantResponse.ok) throw Error(variantResult.error || "Could not load earlier responses.");
        const saved = storedValue(swapModelKey);
        const selectedOption = modelResult.models.some((option) => option.id === saved) ? saved : modelResult.models[0]?.id;
        $("#swap-options").innerHTML = modelResult.models.map((option) =>
          `<label class="swap-option"><input type="radio" name="swap-option" value="${escapeHtml(option.id)}" ${option.id === selectedOption ? "checked" : ""}><span>${escapeHtml(option.label)}</span></label>`
        ).join("");
        $("#swap-variants").innerHTML = variantResult.variants.map((variant) => {
          const when = variant.created_at ? new Date(typeof variant.created_at === "number" ? variant.created_at * 1000 : variant.created_at).toLocaleString() : "";
          const detail = variant.kind === "manual" ? `Manual · ${variant.model}` : when;
          return `<label class="swap-option"><input type="radio" name="swap-variant" value="${escapeHtml(variant.id)}" ${variant.active ? "checked" : ""}><span>#${index + 1}.${variant.number} · ${escapeHtml(variant.model)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</label>`;
        }).join("");
        const dialog = $("#swap-dialog");
        dialog.dataset.id = id;
        dialog.dataset.side = gray ? "gray" : "blue";
        dialog.dataset.mode = "existing";
        $("#swap-title").textContent = "Message versions";
        $("#swap-new").hidden = !gray;
        $("#swap-existing").hidden = false;
        $("#swap-generate").hidden = true;
        $("#swap-submit").textContent = "Use version";
        $("#swap-submit").disabled = true;
        $("#swap-error").hidden = true;
        dialog.showModal();
        return;
      } else if (name === "rewind") {
        await finishEdits();
        const index = state.entries.findIndex((entry) => entry.id === id);
        if (index < 0 || index === state.entries.length - 1) return;
        const count = state.entries.length - index - 1;
        if (!await confirmRewind(index + 1, count)) return;
        timers.forEach(clearTimeout);
        timers.clear();
        await Promise.allSettled([...saving.values()]);
        await api("/api/rewind", {id});
        edits.clear();
        renderedEditors.clear();
        saveError = false;
      } else if (name === "approve") {
        await finishEdits();
        sendingId = last.id;
        $(`#m-${last.id} [data-action=approve]`)?.remove();
        if (state.entries.at(-1)?.id !== last.id || state.entries.at(-1)?.status !== "draft")
          throw Error("The agent response changed. Review a new draft before sending.");
        const draftText = state.entries.at(-1).current_text;
        await api("/api/approve", {id: last.id, text: draftText});
        sendingId = null;
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
    } catch (error) {
      if (name === "approve") {
        sendingId = null;
        await refresh(true, true);
      }
      showNotice(error.message, true);
    }
  }

  document.addEventListener("input", (event) => {
    if (event.target.closest("#manual-dialog")) return;
    if (event.target.classList?.contains("message-search-input")) {
      if (!messageSearch) return;
      messageSearch.query = event.target.value;
      messageSearch.index = 0;
      updateMessageSearch(true);
      return;
    }
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
    if (messageSearch?.id === id) updateMessageSearch();
    if (viewMode === "rendered") {
      const entry = state.entries.find((item) => item.id === id);
      const preview = $(`#m-${id} .message-text`);
      if (entry && preview) showPreview(preview, entry);
    }
    saveError = false;
    updateSaveStatus();
    if (id === state.entries[0]?.id) renderRequestContext();
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => saveEdit(id).catch(() => {}), 900));
  });
  document.addEventListener("blur", (event) => {
    if (event.target.closest("#manual-dialog")) return;
    if (event.target.tagName === "TEXTAREA") saveEdit(Number(event.target.dataset.id)).catch(() => {});
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!event.target.classList?.contains("message-search-input") || !messageSearch) return;
    if (event.key === "Escape") {
      event.preventDefault();
      action("close-search", messageSearch.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!messageMatches.length) return;
      messageSearch.index = (messageSearch.index + (event.shiftKey ? -1 : 1) + messageMatches.length) % messageMatches.length;
      updateMessageSearch(true);
    }
  });
  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    action(btn.dataset.action, Number(btn.closest(".message")?.dataset.id || state.entries.at(-1).id));
  });
  $("#swap-cancel").addEventListener("click", () => $("#swap-dialog").close());
  $("#swap-new").addEventListener("click", () => {
    $("#swap-dialog").dataset.mode = "generate";
    $("#swap-title").textContent = "New response";
    $("#swap-existing").hidden = true;
    $("#swap-generate").hidden = false;
    $("#swap-submit").textContent = "Generate";
    $("#swap-submit").disabled = false;
    $("#swap-error").hidden = true;
    $("#swap-options input:checked")?.focus();
  });
  $("#swap-back").addEventListener("click", () => {
    $("#swap-dialog").dataset.mode = "existing";
    $("#swap-title").textContent = "Message versions";
    $("#swap-existing").hidden = false;
    $("#swap-generate").hidden = true;
    $("#swap-submit").textContent = "Use version";
    $("#swap-submit").disabled = $("#swap-variants input:checked")?.value === "active";
    $("#swap-variants input:checked")?.focus();
  });
  $("#swap-variants").addEventListener("change", () => {
    $("#swap-submit").disabled = $("#swap-variants input:checked")?.value === "active";
  });
  $("#swap-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $("#swap-dialog");
    const submit = $("#swap-submit");
    const error = $("#swap-error");
    const generation = dialog.dataset.mode === "generate";
    const option = $("#swap-options input:checked")?.value;
    const variant = $("#swap-variants input:checked")?.value;
    submit.disabled = true;
    error.hidden = true;
    try {
      await finishEdits();
      if (generation) {
        if (!option) throw Error("Choose a model.");
        await api("/api/swap-model", {id: Number(dialog.dataset.id), option});
        storeValue(swapModelKey, option);
      } else {
        if (!variant || variant === "active") throw Error("Choose another version.");
        await api("/api/select-message-variant", {id: Number(dialog.dataset.id), variant});
      }
      selected = Number(dialog.dataset.id);
      dialog.close();
      await refresh(true, true);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally { submit.disabled = false; }
  });
  $("#manual-cancel").addEventListener("click", () => $("#manual-dialog").close());
  $("#manual-add-message").addEventListener("click", () => addManualPart("message"));
  $("#manual-add-tool").addEventListener("click", () => addManualPart("tool"));
  $("#manual-parts").addEventListener("click", (event) => {
    if (!event.target.closest(".manual-remove")) return;
    event.target.closest(".manual-part").remove();
    updateManualButtons();
  });
  $("#manual-parts").addEventListener("change", (event) => {
    if (event.target.tagName !== "SELECT") return;
    const part = event.target.closest(".manual-part");
    if ($("#manual-dialog").dataset.side === "gray") {
      const tool = manualContext().tools.find((item) => item.name === event.target.value);
      part.querySelector("textarea").value = JSON.stringify(schemaTemplate(tool?.parameters || {type: "object"}), null, 2);
    }
    updateManualButtons();
  });
  $("#manual-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $("#manual-dialog");
    const error = $("#manual-error");
    const submit = $("#manual-submit");
    error.hidden = true;
    submit.disabled = true;
    try {
      await finishEdits();
      const {last, request, calls} = manualContext();
      if (last.id !== Number(dialog.dataset.sourceId) ||
          (dialog.dataset.side === "gray" ? last.side !== "blue" || last.status !== "draft" : last.side !== "gray"))
        throw Error("The conversation changed. Reopen the composer.");
      const parts = [...$("#manual-parts").querySelectorAll(".manual-part")];
      if (!parts.length) throw Error("Add a message or tool item.");
      if (dialog.dataset.side === "gray") {
        const output = parts.map((part) => {
          const value = part.querySelector("textarea").value;
          if (part.dataset.kind === "message") {
            if (!value.trim()) throw Error("Enter response text.");
            return {id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant",
              status: "completed", content: [{type: "output_text", text: value}]};
          }
          let args;
          try { args = JSON.parse(value); }
          catch { throw Error("Tool arguments must be valid JSON."); }
          if (!args || Array.isArray(args) || typeof args !== "object") throw Error("Tool arguments must be a JSON object.");
          return {id: `fc_${crypto.randomUUID().replaceAll("-", "")}`, type: "function_call",
            name: part.querySelector("select").value, status: "completed",
            call_id: `call_${crypto.randomUUID().replaceAll("-", "")}`, arguments: JSON.stringify(args)};
        });
        const response = {id: `resp_manual_${crypto.randomUUID().replaceAll("-", "")}`,
          object: "response", model: request.model, status: "completed", output};
        if (request.access_programs) response.access_programs = structuredClone(request.access_programs);
        await api("/api/manual-response", {id: last.id, response});
      } else {
        const prior = JSON.parse(state.entries.at(-2).current_text);
        const response = JSON.parse(last.current_text);
        const draft = structuredClone(prior);
        draft.input = [...prior.input, ...response.output.filter((item) => !last.revision || item.type !== "reasoning")];
        const used = new Set();
        for (const part of parts) {
          const value = part.querySelector("textarea").value;
          if (part.dataset.kind === "message") {
            if (!value.trim()) throw Error("Enter user message text.");
            draft.input.push({role: "user", content: value});
          } else {
            const callId = part.querySelector("select").value;
            if (!calls.some((call) => call.call_id === callId) || used.has(callId)) throw Error("Choose each tool call once.");
            used.add(callId);
            draft.input.push({type: "function_call_output", call_id: callId, output: value});
          }
        }
        await api("/api/manual-draft", {request: draft});
      }
      dialog.close();
      await refresh(true, true);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally { submit.disabled = false; }
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
  $("#auto-mode").addEventListener("change", async (event) => {
    const input = event.target;
    const enabled = input.checked;
    changingAuto = true;
    input.disabled = true;
    try {
      await finishEdits();
      if (enabled && state?.run_complete) throw Error("This run is complete. Rewind to continue it.");
      if (enabled && state?.entries.at(-1)?.status === "stale")
        throw Error("Refresh the stale blue draft before turning on Auto.");
      const result = await api("/api/auto-mode", {enabled});
      state.auto_mode = result.auto_mode;
      await refresh(true, true);
      const latest = state.entries.at(-1);
      if (enabled && !state.busy && latest?.side === "blue" && latest.status === "draft") {
        await api("/api/auto-send", {id: latest.id, text: latest.current_text});
        await refresh(true, true);
      }
    } catch (error) {
      if (enabled && state?.auto_mode) {
        try {
          await api("/api/auto-mode", {enabled: false});
          state.auto_mode = false;
        } catch { /* Keep the server state visible on the next refresh. */ }
      }
      showNotice(error.message, true);
    } finally {
      changingAuto = false;
      input.disabled = false;
      updateAutoMode();
    }
  });
  $("#auto-generate").addEventListener("change", async (event) => {
    const input = event.target;
    changingAutoGenerate = true;
    input.disabled = true;
    try {
      await finishEdits();
      const result = await api("/api/auto-generate", {enabled: input.checked});
      state.auto_generate = result.auto_generate;
      await refresh(true, true);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      changingAutoGenerate = false;
      input.disabled = false;
      updateAutoGenerate();
    }
  });
  $("#draft-source-control").addEventListener("click", async (event) => {
    const input = event.target.closest("[data-source]");
    if (!input || changingDraftSource || input.dataset.source === state?.draft_source) return;
    changingDraftSource = true;
    $("#draft-source-control").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await finishEdits();
      const result = await api("/api/draft-source", {source: input.dataset.source});
      state.draft_source = result.draft_source;
      await refresh(true, true);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      changingDraftSource = false;
      $("#draft-source-control").querySelectorAll("button").forEach((button) => { button.disabled = false; });
      updateDraftSource();
    }
  });
  const settingsButton = $("#settings-button");
  const settingsPanel = $("#settings-panel");
  $("#default-model-options").addEventListener("click", async (event) => {
    const choice = event.target.closest("[data-model-id]");
    if (!choice || choice.dataset.modelId === modelCatalog?.default) return;
    const buttons = $("#default-model-options").querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      modelCatalog = await api("/api/default-model", {id: choice.dataset.modelId});
      storeValue(defaultModelKey, modelCatalog.default);
      renderModelCatalog();
    } catch (error) {
      showNotice(error.message, true);
      await loadModelCatalog().catch(() => {});
    } finally {
      $("#default-model-options").querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  });
  function setSettingsOpen(open) {
    settingsPanel.hidden = !open;
    settingsButton.setAttribute("aria-expanded", String(open));
  }
  settingsButton.addEventListener("click", () => {
    const opening = settingsPanel.hidden;
    setSettingsOpen(opening);
    if (opening) loadModelCatalog().catch((error) => showNotice(error.message, true));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!settingsPanel.hidden && !event.target.closest(".settings-wrap")) setSettingsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsPanel.hidden) {
      setSettingsOpen(false);
      settingsButton.focus();
    }
  });
  $("#trace-select").addEventListener("click", () => setTraceMenuOpen($("#trace-menu").hidden));
  $("#trace-menu").addEventListener("click", (event) => {
    const rename = event.target.closest(".trace-row-rename");
    if (rename) {
      setTraceMenuOpen(false);
      traceRenameId = rename.closest(".trace-row")?.querySelector(".trace-choice")?.dataset.traceId;
      const current = traces?.traces.find((trace) => trace.id === traceRenameId);
      if (!current || switchingTrace) return;
      $("#trace-rename-input").value = current.name;
      $("#trace-rename-error").hidden = true;
      $("#trace-rename-dialog").showModal();
      $("#trace-rename-input").focus();
      $("#trace-rename-input").select();
      return;
    }
    const choice = event.target.closest(".trace-choice");
    if (choice) {
      setTraceMenuOpen(false);
      selectTrace(choice.dataset.traceId);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!$("#trace-menu").hidden && !event.target.closest(".trace-picker")) setTraceMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#trace-menu").hidden) {
      setTraceMenuOpen(false);
      $("#trace-select").focus();
    }
  });
  $("#trace-rename-cancel").addEventListener("click", () => $("#trace-rename-dialog").close());
  $("#trace-rename-dialog").addEventListener("close", () => { traceRenameId = null; });
  $("#trace-rename-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#trace-rename-input");
    const name = input.value.trim();
    const current = traces?.traces.find((trace) => trace.id === traceRenameId);
    if (!current || switchingTrace) return;
    if (name === current.name) {
      $("#trace-rename-dialog").close();
      return;
    }
    const error = $("#trace-rename-error");
    const save = $("#trace-rename-save");
    save.disabled = true;
    error.hidden = true;
    try {
      await finishEdits();
      await api("/api/rename-trace", {id: traceRenameId, name});
      await loadTraces();
      $("#trace-rename-dialog").close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
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
    updateRailThumb();
    scheduleScrollSave();
  }, {capture: true, passive: true});
  $("#rail-track").addEventListener("click", (event) => {
    const dot = event.target.closest(".rail-point");
    if (dot) { jump(dot.dataset.message); return; }
    const track = $("#rail-track");
    const fraction = Math.max(0, Math.min(1, (event.clientY - track.getBoundingClientRect().top) / track.clientHeight));
    const scroller = $("#stream");
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2;
  });
  const railObserver = new ResizeObserver(scheduleRailLayout);
  railObserver.observe($("#stream"));
  railObserver.observe($("#messages"));
  railObserver.observe($("#request-context"));
  window.addEventListener("pagehide", () => {
    clearTimeout(scrollSaveTimer);
    saveScrollPosition();
  });
  syncViewMode();
  loadTraces().then(async () => {
    await loadModelCatalog().catch((error) => showNotice(error.message, true));
    loadCollapsePreferences(traces.active);
    await loadRailPoints();
    await refresh(true);
    if (!restoreScrollPosition()) {
      const fromHash = Number(location.hash.replace("#m-", ""));
      if (fromHash) jump(fromHash);
    }
    scrollPersistenceSuspended = false;
  }).catch((error) => showNotice(error.message, true));
  setInterval(() => { if (!switchingTrace) refresh(); }, 1100);
  setInterval(() => { if (!switchingTrace) loadRailPoints().catch((error) => showNotice(error.message, true)); }, 10000);
  setInterval(updateSaveStatus, 1000);
})();
