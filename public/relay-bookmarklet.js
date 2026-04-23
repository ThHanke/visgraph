/**
 * VisGraph Relay Bookmarklet — full readable source
 *
 * Injected into an AI chat tab.  It:
 *   1. Opens (or reuses) the relay popup window (relay.html).
 *   2. Watches the page for new assistant messages via MutationObserver.
 *   3. Extracts MCP JSON-RPC 2.0 tool calls from backtick-wrapped inline code.
 *   4. Forwards parsed tool calls to the relay popup via postMessage.
 *   5. Receives results back and injects JSON-RPC responses into the chat input.
 *
 * Message formats:
 *   To popup:   { type: 'vg-call', tool, params, requestId, isLast }
 *   From popup: { type: 'vg-result', requestId, result, summary?, svg? }
 */

(function () {
  'use strict';

  var RELAY_URL    = '__RELAY_URL__';
  var RELAY_ORIGIN = '__RELAY_ORIGIN__';
  var POPUP_NAME   = 'vg-relay';
  var POPUP_OPTS   = 'width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes';
  var DEBOUNCE_MS  = 800;

  /* ── Kill any previous instance ───────────────────────────────────────── */
  // Disconnect old MutationObserver so it stops enqueuing calls.
  if (window.__vgRelayObserver) {
    try { window.__vgRelayObserver.disconnect(); } catch (_) {}
    window.__vgRelayObserver = null;
  }
  // Clear old popup-closed watcher.
  if (window.__vgRelayWatcher) {
    clearInterval(window.__vgRelayWatcher);
    window.__vgRelayWatcher = null;
  }

  /* ── Instance ID — deactivates old message listeners ──────────────────── */
  // Every click stamps a new ID.  The message listener checks at runtime and
  // ignores messages if a newer instance has taken over.
  var instanceId = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  window.__vgRelayInstanceId = instanceId;
  window.__vgRelayActive = true;

  /* ── Popup management ──────────────────────────────────────────────────── */
  function openPopup() {
    if (!window.__vgRelayPopup || window.__vgRelayPopup.closed) {
      window.__vgRelayPopup = window.open(RELAY_URL, POPUP_NAME, POPUP_OPTS);
    }
    return window.__vgRelayPopup;
  }

  /* ── Inject keyframe (once per page load) ─────────────────────────────── */
  if (!document.getElementById('vg-relay-style')) {
    var style = document.createElement('style');
    style.id = 'vg-relay-style';
    style.textContent = '@keyframes vg-pulse{0%,100%{outline:2px solid #3fb950}50%{outline:4px solid #f0883e}}';
    document.head.appendChild(style);
  }

  /* ── "Relay Active" badge ──────────────────────────────────────────────── */
  function showBadge() {
    var existing = document.getElementById('vg-relay-badge');
    if (existing) { existing.style.display = 'flex'; return; }

    var badge = document.createElement('div');
    badge.id = 'vg-relay-badge';
    badge.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
      'background:#0d1117', 'color:#3fb950', 'border:1px solid #3fb950',
      'border-radius:6px', 'padding:6px 10px', 'font:13px/1.4 monospace',
      'display:flex', 'align-items:center', 'gap:8px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)', 'cursor:pointer',
    ].join(';');
    badge.title = 'Click to reopen relay popup';

    var span = document.createElement('span');
    span.textContent = '🟢 VisGraph Relay Active';

    var x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'cursor:pointer;color:#8b949e;font-size:15px;line-height:1';
    x.title = 'Close relay';
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      badge.style.display = 'none';
      var p = window.__vgRelayPopup;
      if (p && !p.closed) p.close();
      window.__vgRelayPopup = null;
    });

    badge.addEventListener('click', function () {
      var p = openPopup();
      if (!p) {
        showToast('Popup blocked — allow popups for this site', false);
        badge.style.animation = 'vg-pulse 0.6s ease 3';
      }
    });
    badge.appendChild(span);
    badge.appendChild(x);
    document.body.appendChild(badge);
  }

  /* ── Toast ─────────────────────────────────────────────────────────────── */
  function showToast(msg, ok) {
    var t = document.createElement('div');
    t.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:12px', 'z-index:2147483647',
      'background:#0d1117',
      'color:' + (ok ? '#3fb950' : '#f85149'),
      'border:1px solid ' + (ok ? '#3fb950' : '#f85149'),
      'border-radius:6px', 'padding:8px 12px', 'font:12px monospace',
      'max-width:340px', 'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');
    t.textContent = (ok ? '✓ ' : '✗ ') + msg.slice(0, 120);
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
  }

  /* ── Open popup + badge ────────────────────────────────────────────────── */
  (function () {
    var popup = openPopup();
    showBadge();
    if (!popup) {
      showToast('Popup blocked — allow popups for this site', false);
      var b = document.getElementById('vg-relay-badge');
      if (b) b.style.animation = 'vg-pulse 0.6s ease 3';
    }
  })();

  /* ── Popup-closed watcher ──────────────────────────────────────────────── */
  (function () {
    var watcher = setInterval(function () {
      if (window.__vgRelayInstanceId !== instanceId) { clearInterval(watcher); return; }
      var p = window.__vgRelayPopup;
      if (p && p.closed) {
        clearInterval(watcher);
        window.__vgRelayWatcher = null;
        window.__vgRelayPopup = null;
        var badge = document.getElementById('vg-relay-badge');
        if (badge) badge.style.display = 'none';
      }
    }, 500);
    window.__vgRelayWatcher = watcher;
  })();

  /* ── Find the chat input ───────────────────────────────────────────────── */
  function findInput() {
    // OpenWebUI uses id="chat-input"
    var byId = document.getElementById('chat-input');
    if (byId) {
      var r0 = byId.getBoundingClientRect();
      if (r0.width > 0 && r0.height > 0) return byId;
    }
    var candidates = Array.from(document.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""]'
    )).filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Exclude CodeMirror editors
      var p = el;
      while (p && p !== document.body) {
        if (p.classList && (p.classList.contains('cm-editor') || p.classList.contains('cm-content'))) return false;
        p = p.parentElement;
      }
      return true;
    });
    if (!candidates.length) return null;
    var textareas = candidates.filter(function (e) { return e.tagName === 'TEXTAREA'; });
    var pool = textareas.length ? textareas : candidates;
    return pool.reduce(function (best, el) {
      return el.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? el : best;
    });
  }

  /* ── Submit the chat input ─────────────────────────────────────────────── */
  function submitInput(inputEl) {
    var foundBtn = false;

    // 1. Direct id — OpenWebUI's known send button
    var directBtn = document.getElementById('send-message-button');
    if (directBtn && !directBtn.disabled) { directBtn.click(); foundBtn = true; }

    // 2. Climb parent tree for other UIs
    if (!foundBtn) {
      var cur = inputEl.parentElement;
      while (cur && cur !== document.body) {
        var btns = Array.from(cur.querySelectorAll('button'));
        var sendBtn = btns.find(function (b) {
          if (b.disabled) return false;
          var lbl = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
          return b.type === 'submit' || lbl.includes('send') || lbl.includes('senden') || lbl.includes('submit');
        });
        if (sendBtn) { sendBtn.click(); foundBtn = true; break; }
        cur = cur.parentElement;
      }
    }

    // 3. requestSubmit() on the form — fires Svelte's on:submit handler even if
    //    the send button is still disabled (Svelte render hasn't flushed yet)
    if (!foundBtn) {
      var form = inputEl.closest('form') ||
                 (directBtn && directBtn.closest('form'));
      if (form) {
        try { form.requestSubmit(); foundBtn = true; } catch (_) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          foundBtn = true;
        }
      }
    }

    // 4. Enter keydown — textarea UIs only (TipTap: Enter = new paragraph)
    if (inputEl.tagName === 'TEXTAREA' || !foundBtn) {
      ['keydown', 'keyup'].forEach(function (type) {
        inputEl.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      });
    }
  }

  /* ── Inject result into chat input and auto-submit ─────────────────────── */
  var injectInProgress = false;

  function injectResult(text) {
    if (injectInProgress) return false;
    injectInProgress = true;

    var el = findInput();
    if (!el) {
      injectInProgress = false;
      showToast('Could not find chat input', false);
      return false;
    }

    // Wait until the send button is enabled (Svelte/TipTap state flushed) then submit.
    // Poll up to 3 s in 50 ms steps; fall through to requestSubmit() on timeout.
    function doSubmit() {
      var deadline = Date.now() + 3000;
      (function poll() {
        var directBtn = document.getElementById('send-message-button');
        var btnEnabled = directBtn && !directBtn.disabled;
        if (!btnEnabled) {
          // Also check tree-climbed send button
          var cur = el.parentElement;
          while (cur && cur !== document.body && !btnEnabled) {
            var found = Array.from(cur.querySelectorAll('button')).find(function (b) {
              if (b.disabled) return false;
              var lbl = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
              return b.type === 'submit' || lbl.includes('send') || lbl.includes('senden') || lbl.includes('submit');
            });
            if (found) btnEnabled = true;
            cur = cur.parentElement;
          }
        }
        if (btnEnabled || Date.now() >= deadline) {
          submitInput(el);
          injectInProgress = false;
        } else {
          setTimeout(poll, 50);
        }
      })();
    }

    if (el.tagName === 'TEXTAREA') {
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? el.value + '\n' : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      doSubmit();
    } else {
      // ProseMirror / TipTap contenteditable (OpenWebUI, ChatGPT…)
      //
      // Three-path strategy, most reliable first:
      //
      // Path 1: Direct ProseMirror view dispatch via element.pmViewDesc.view.
      //   TipTap attaches the ProseMirror EditorView to the DOM element.
      //   Dispatching a transaction through it updates both PM state and Svelte
      //   store atomically — no DOM reconciliation, no race conditions.
      //
      // Path 2: Synthetic beforeinput(insertFromPaste) with DataTransfer.
      //   ProseMirror handles this through its beforeinput handler, reading
      //   event.dataTransfer.  Falls back to this if Path 1 isn't available.
      //
      // Path 3: beforeinput(insertText) with data field — last resort.
      //
      // Focus first, defer 50 ms so ProseMirror has an active selection.
      var live = findInput() || el;
      live.focus();
      el = live;

      setTimeout(function () {
        var target = findInput() || el;
        target.focus();
        var dispatched = false;

        // ── Path 1: TipTap / ProseMirror dispatch ───────────────────────
        // Strategies (most reliable first):
        //   a) tiptap.commands.setContent — full TipTap pipeline, fires onTransaction
        //      → onChange → Svelte prompt update → send button enables
        //   b) pmView.dispatch (raw PM transaction) — fallback for older TipTap
        //   c) own-property scan for EditorView-shaped objects (minified builds)
        try {
          var tiptap = target.editor;

          // (a) TipTap high-level API — preferred; goes through full callback chain
          if (tiptap && tiptap.commands && typeof tiptap.commands.setContent === 'function') {
            try {
              tiptap.commands.focus();
              // setContent(content, emitUpdate) — emitUpdate=true fires onTransaction
              tiptap.commands.setContent(text, true);
              dispatched = (tiptap.state || tiptap.view.state).doc.textContent.length > 0;
            } catch (_) {}
          }

          // (b) raw PM dispatch — works when tiptap.commands unavailable
          if (!dispatched) {
            var pmView = null;
            if (tiptap && tiptap.view && typeof tiptap.view.dispatch === 'function') {
              pmView = tiptap.view;
            }
            if (!pmView) {
              var desc = target.pmViewDesc;
              if (desc && desc.view && typeof desc.view.dispatch === 'function') pmView = desc.view;
            }
            if (!pmView) {
              var ownKeys = Object.keys(target);
              for (var oi = 0; oi < ownKeys.length; oi++) {
                try {
                  var ov = target[ownKeys[oi]];
                  if (ov && typeof ov === 'object' && typeof ov.dispatch === 'function' &&
                      ov.state && typeof ov.state.tr === 'object') { pmView = ov; break; }
                } catch (_) {}
              }
            }
            if (pmView) {
              var state = pmView.state;
              var docSize = state.doc.content.size;
              var endPos = docSize > 2 ? docSize - 1 : 1;
              var pmTr = state.tr.insertText(text, 1, endPos);
              pmView.dispatch(pmTr);
              dispatched = pmView.state.doc.textContent.length > 0;
            }
          }
        } catch (_) {}

        // ── Path 2: beforeinput insertFromPaste with DataTransfer ───────
        if (!dispatched) {
          try {
            var dt = new DataTransfer();
            dt.setData('text/plain', text);
            target.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertFromPaste',
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
            }));
            dispatched = true;
          } catch (_) {}
        }

        // ── Path 3: beforeinput insertText ──────────────────────────────
        if (!dispatched) {
          try {
            target.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: text,
              bubbles: true,
              cancelable: true,
            }));
          } catch (_) {}
        }

        // Belt-and-suspenders: fire input so Svelte bindings notice any change
        target.dispatchEvent(new Event('input', { bubbles: true }));
        el = target;
        doSubmit();
      }, 50);
    }

    return true;
  }

  /* ── Compact result summary ────────────────────────────────────────────── */
  function briefData(data) {
    if (!data) return 'ok';
    if (typeof data === 'string') return data.slice(0, 80);
    if (data.iri) return data.iri;
    if (data.loaded !== undefined) {
      var brief = String(data.loaded);
      if (data.newEntitiesAvailable && data.newEntitiesAvailable.length)
        brief += ' — ' + data.newEntitiesAvailable.length + ' new entities available';
      return brief;
    }
    if (data.entities) return data.entities.length + ' entities';
    if (data.links) return data.links.length + ' links';
    if (data.results) {
      var onCanvas = data.results.filter(function (r) { return r.onCanvas; });
      return data.results.length + ' results' + (onCanvas.length ? ', ' + onCanvas.length + ' on canvas' : '');
    }
    if (data.completions) return data.completions.length + ' completions';
    if (data.nodeCount !== undefined) return data.nodeCount + ' nodes, ' + data.linkCount + ' links';
    if (data.added) return 's=' + (data.added.s || '') + ' p=' + (data.added.p || '') + ' o=' + (data.added.o || '');
    if (data.removed !== undefined) return typeof data.removed === 'string' ? 'removed ' + data.removed : JSON.stringify(data.removed);
    if (data.inferredTriples !== undefined) return data.inferredTriples + ' triples inferred';
    if (data.content !== undefined) return typeof data.content === 'string' ? data.content : '(' + (data.content.length || 0) + ' chars)';
    if (data.expanded !== undefined) return data.expanded + ' nodes expanded';
    return JSON.stringify(data).slice(0, 80);
  }

  /* ── Format and inject combined batch result ───────────────────────────── */
  function injectCombinedResult(results, finalSummary, finalSvg) {
    var allOk = results.every(function (r) { return r.ok; });
    var lines = ['[VisGraph — ' + results.length + ' tool' + (results.length !== 1 ? 's' : '') + (allOk ? ' ✓' : ' (some failed)') + ']'];
    results.forEach(function (r) {
      var resp;
      if (r.ok) {
        resp = JSON.stringify({
          jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
          result: { content: [{ type: 'text', text: briefData(r.result && r.result.data) }] },
        });
      } else {
        var err = (r.result && r.result.error) || 'failed';
        resp = JSON.stringify({
          jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
          error: { code: -32000, message: String(err), data: { tool: r.tool } },
        });
      }
      lines.push('`' + resp + '`');
    });
    if (finalSummary) { lines.push(''); lines.push(finalSummary); }
    if (finalSvg && typeof finalSvg === 'string') { lines.push(''); lines.push('Current graph (SVG):'); lines.push(finalSvg); }
    injectResult(lines.join('\n'));
    showToast('Done: ' + results.length + ' tool' + (results.length !== 1 ? 's' : ''), allOk);
  }

  /* ── Batch queue state ─────────────────────────────────────────────────── */
  var callQueue        = [];
  var batchResults     = [];
  var isProcessing     = false;
  var pendingTool      = null;
  var pendingMcpId     = null;
  var pendingRequestId = null;
  var lastSummary      = null;
  var callTimeoutTimer = null;
  var knownSessionId   = null;
  var lateResult       = null;
  var CALL_TIMEOUT_MS  = 30000;

  function resetCallTimeout() {
    clearTimeout(callTimeoutTimer);
    callTimeoutTimer = setTimeout(function () {
      if (!isProcessing) return;
      var timedOutTool      = pendingTool    || '?';
      var timedOutId        = pendingMcpId;
      var timedOutRequestId = pendingRequestId;
      isProcessing     = false;
      pendingTool      = null;
      pendingMcpId     = null;
      pendingRequestId = null;
      lateResult = { requestId: timedOutRequestId, tool: timedOutTool, mcpId: timedOutId };
      var results = batchResults.slice(); batchResults = [];
      var summary = lastSummary; lastSummary = null;
      callQueue = [];
      var resp = JSON.stringify({
        jsonrpc: '2.0', id: timedOutId != null ? timedOutId : null,
        error: { code: -32000, message: timedOutTool + ' did not respond within ' + (CALL_TIMEOUT_MS / 1000) + ' s. A follow-up result will be injected automatically.', data: { tool: timedOutTool, lateResult: true } },
      });
      results.push({ tool: timedOutTool, mcpId: timedOutId, ok: false, result: { success: false, error: 'timeout' } });
      var lines = ['[VisGraph — ⏱ ' + timedOutTool + ' timed out]'];
      results.forEach(function (r) {
        var rr = (r.tool === timedOutTool && !r.ok) ? resp : r.ok
          ? JSON.stringify({ jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null, result: { content: [{ type: 'text', text: briefData(r.result && r.result.data) }] } })
          : JSON.stringify({ jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null, error: { code: -32000, message: String((r.result && r.result.error) || 'failed'), data: { tool: r.tool } } });
        lines.push('`' + rr + '`');
      });
      if (summary) { lines.push(''); lines.push(summary); }
      injectResult(lines.join('\n'));
      showToast('⏱ ' + timedOutTool + ' timed out', false);
    }, CALL_TIMEOUT_MS);
  }

  /* ── Result listener (popup → chat tab) ───────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (window.__vgRelayInstanceId !== instanceId) return; // stale instance
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;

    if (data && data.type === 'vg-ping') {
      if (data.sessionId) {
        if (knownSessionId && knownSessionId !== data.sessionId) {
          showToast('VisGraph reloaded — graph data was lost', false);
          clearTimeout(callTimeoutTimer);
          isProcessing = false; pendingTool = null; pendingMcpId = null; pendingRequestId = null;
          batchResults = []; callQueue = []; lastSummary = null; lateResult = null;
        }
        knownSessionId = data.sessionId;
      }
      resetCallTimeout();
      return;
    }

    if (!data || data.type !== 'vg-result') return;

    // Late result after timeout
    if (!isProcessing && lateResult && data.requestId && data.requestId === lateResult.requestId) {
      var lr = lateResult; lateResult = null;
      clearTimeout(callTimeoutTimer);
      var lok = !!(data.result && data.result.success !== false);
      var lresp = lok
        ? JSON.stringify({ jsonrpc: '2.0', id: lr.mcpId != null ? lr.mcpId : null, result: { content: [{ type: 'text', text: briefData(data.result && data.result.data) }] } })
        : JSON.stringify({ jsonrpc: '2.0', id: lr.mcpId != null ? lr.mcpId : null, error: { code: -32000, message: String((data.result && data.result.error) || 'failed'), data: { tool: lr.tool } } });
      var ll = ['[VisGraph — late result for ' + lr.tool + (lok ? ' ✓' : ' ✗') + ']', '`' + lresp + '`'];
      if (data.summary) { ll.push(''); ll.push(data.summary); }
      if (data.svg) { ll.push(''); ll.push('Current graph (SVG):'); ll.push(data.svg); }
      injectResult(ll.join('\n'));
      showToast('Late result: ' + lr.tool, lok);
      return;
    }

    clearTimeout(callTimeoutTimer);
    lateResult = null;
    var ok = !!(data.result && data.result.success !== false);
    batchResults.push({ tool: pendingTool || '?', mcpId: pendingMcpId, ok: ok, result: data.result });
    if (data.summary) lastSummary = data.summary;
    isProcessing = false; pendingTool = null; pendingMcpId = null; pendingRequestId = null;

    if (callQueue.length > 0) {
      processNextInQueue();
    } else {
      var results = batchResults.slice(); var summary = lastSummary;
      batchResults = []; lastSummary = null;
      injectCombinedResult(results, summary, data.svg);
    }
  });

  /* ── RDF prefix expansion ──────────────────────────────────────────────── */
  var KNOWN_PREFIXES = {
    'rdf:': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'rdfs:': 'http://www.w3.org/2000/01/rdf-schema#',
    'owl:': 'http://www.w3.org/2002/07/owl#',
    'xsd:': 'http://www.w3.org/2001/XMLSchema#',
    'foaf:': 'http://xmlns.com/foaf/0.1/',
    'skos:': 'http://www.w3.org/2004/02/skos/core#',
    'dc:': 'http://purl.org/dc/elements/1.1/',
    'dcterms:': 'http://purl.org/dc/terms/',
    'schema:': 'https://schema.org/',
    'ex:': 'http://example.org/',
  };
  function expandPrefix(val) {
    for (var p in KNOWN_PREFIXES) {
      if (val.indexOf(p) === 0) return KNOWN_PREFIXES[p] + val.slice(p.length);
    }
    return val;
  }

  /* ── Tool-call parser ──────────────────────────────────────────────────── */
  var dispatchedSigs = new Set();

  function validateMcpRequest(obj) {
    if (!obj || obj.jsonrpc !== '2.0') return false;
    if (obj.method !== 'tools/call') return false;
    if (!obj.params || typeof obj.params.name !== 'string') return false;
    return true;
  }

  function extractJsonObjects(text) {
    var objects = [], i = 0, n = text.length;
    while (i < n) {
      var start = text.indexOf('{', i);
      if (start === -1) break;
      var depth = 0, inStr = false, complete = false;
      for (var j = start; j < n; j++) {
        var c = text[j];
        if (inStr) {
          if (c === '\\') { j++; continue; }
          if (c === '"') inStr = false;
        } else {
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') {
            if (--depth === 0) { objects.push(text.slice(start, j + 1)); i = j + 1; complete = true; break; }
          }
        }
      }
      if (!complete) break;
    }
    return objects;
  }

  function extractAllToolCalls(text, seen) {
    var calls = [];
    var objects = extractJsonObjects(text);
    for (var i = 0; i < objects.length; i++) {
      var req;
      try { req = JSON.parse(objects[i]); } catch (e) { continue; }
      if (!validateMcpRequest(req)) continue;
      var tool = req.params.name;
      var params = req.params.arguments || {};
      for (var k in params) {
        if (typeof params[k] === 'string') params[k] = expandPrefix(params[k]);
      }
      var mcpId = req.id != null ? req.id : null;
      var sig = tool + ':' + JSON.stringify(params) + ':' + mcpId;
      if (!seen.has(sig)) { seen.add(sig); calls.push({ tool: tool, params: params, mcpId: mcpId }); }
    }
    return calls;
  }

  /* ── Streaming-idle detection ──────────────────────────────────────────── */
  function isAiStreaming() {
    var inp = findInput();
    if (inp) {
      // Textarea-specific: disabled during generation
      if (inp.tagName === 'TEXTAREA' && inp.disabled) return true;
      if (inp.getAttribute('aria-disabled') === 'true') return true;
      // aria-busy on any ancestor signals generation in progress
      var el = inp.parentElement;
      while (el && el !== document.body) {
        if (el.getAttribute('aria-busy') === 'true') return true;
        el = el.parentElement;
      }
      // NOTE: we intentionally do NOT check the send button's disabled state here.
      // TipTap/ProseMirror UIs disable the send button when the editor is empty,
      // which is the normal idle state — not a streaming indicator.
    }
    return false;
  }

  function waitForIdle(container, callback) {
    var MAX_WAIT_MS = 30000, POLL_MS = 200, STABLE_TICKS = 3;
    var elapsed = 0, lastLen = -1, stableCount = 0;
    function poll() {
      elapsed += POLL_MS;
      var len = (container.innerText || container.textContent || '').length;
      if (len !== lastLen) { lastLen = len; stableCount = 0; } else { stableCount++; }
      if ((!isAiStreaming() && stableCount >= STABLE_TICKS) || elapsed >= MAX_WAIT_MS) callback();
      else setTimeout(poll, POLL_MS);
    }
    setTimeout(poll, POLL_MS);
  }

  var drainTimer = null;
  function scheduleDrain(container) {
    clearTimeout(drainTimer);
    drainTimer = setTimeout(function () {
      waitForIdle(container, function () { if (!isProcessing) processNextInQueue(); });
    }, DEBOUNCE_MS);
  }

  function parseAndEnqueue(el) {
    if (!el) return;
    var text = el.innerText || el.textContent || '';
    var calls = extractAllToolCalls(text, dispatchedSigs);
    if (calls.length === 0) return;
    callQueue = callQueue.concat(calls);
    scheduleDrain(el);
  }

  function processNextInQueue() {
    if (isProcessing || callQueue.length === 0) return;
    isProcessing = true;
    var item = callQueue.shift();
    var isLast = callQueue.length === 0;
    var popup = window.__vgRelayPopup;
    if (!popup || popup.closed) popup = openPopup();
    if (!popup) {
      showToast('Relay popup could not open', false);
      isProcessing = false; callQueue = []; batchResults = []; lastSummary = null;
      return;
    }
    pendingTool = item.tool;
    pendingMcpId = item.mcpId != null ? item.mcpId : null;
    lateResult = null;
    var requestId = 'rq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    pendingRequestId = requestId;
    setTimeout(function () {
      try { popup.postMessage({ type: 'vg-call', tool: item.tool, params: item.params, requestId: requestId, isLast: isLast }, RELAY_ORIGIN); resetCallTimeout(); }
      catch (e) { console.warn('[vg-relay] postMessage failed:', e); isProcessing = false; }
    }, 200);
  }

  /* ── MutationObserver ──────────────────────────────────────────────────── */
  var debounceTimer = null;
  var pendingNodes = new Set();

  function flushPending() {
    pendingNodes.forEach(function (node) { parseAndEnqueue(node); });
    pendingNodes.clear();
  }

  function collectAncestors(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    // Ignore mutations inside editable elements (user typing / our inject)
    var check = el;
    while (check && check !== document.body) {
      if (check.tagName === 'TEXTAREA' || check.contentEditable === 'true') return;
      check = check.parentElement;
    }
    // Stop at the NEAREST block element — do not climb to large chat-stream
    // containers that also contain user messages with example tool calls.
    // MCP tool calls are always in a single <code> block; the nearest p/code/div
    // is sufficient to find them.
    while (el && el !== document.body) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'p' || tag === 'li' || tag === 'pre' || tag === 'code' ||
          tag === 'div' || tag === 'section' || tag === 'article') {
        pendingNodes.add(el);
        return;
      }
      el = el.parentElement;
    }
    if (el === document.body) pendingNodes.add(document.body);
  }

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (n) { collectAncestors(n); });
      if (m.type === 'characterData') collectAncestors(m.target);
    });
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
  });

  // Pre-seed dispatchedSigs with all tool calls already visible on the page
  // BEFORE starting the observer, so newly-arriving AI messages are not seeded.
  // This prevents system-prompt examples (id:0 etc.) from being dispatched.
  extractAllToolCalls(document.body.innerText || document.body.textContent || '', dispatchedSigs);

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__vgRelayObserver = observer;

})();
