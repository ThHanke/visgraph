/**
 * Ontosphere Relay Bookmarklet — full readable source
 *
 * Injected into an AI chat tab.  It:
 *   1. Opens (or reuses) the relay popup window (relay.html).
 *   2. Polls the page every 500 ms for new complete JSON-RPC tool calls.
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

  var RELAY_URL             = '__RELAY_URL__';
  var RELAY_ORIGIN          = '__RELAY_ORIGIN__';
  var ANNOTATION_GUARD_MS   = 0; // updated live via vg-ping from relay.html
  var POPUP_NAME   = 'vg-relay';
  var POPUP_OPTS   = 'width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes';

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
    var shortOrigin = RELAY_ORIGIN.replace(/^https?:\/\//, '');
    span.textContent = '🟢 Ontosphere Relay - ' + shortOrigin;

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
          var cls = (b.className || '').toLowerCase();
          return b.type === 'submit' || lbl.includes('send') || lbl.includes('senden') ||
                 lbl.includes('submit') || cls.includes('send') || cls.includes('submit');
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

    // 4. Enter keydown — textarea UIs only, or when no button found.
    // TipTap (OWUI) maps Enter → new paragraph, NOT submit. Button click is
    // the correct submit path. Only fall back to Enter for non-TipTap UIs.
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

    if (el.tagName === 'TEXTAREA') {
      // Textarea path (FhGenie et al.).
      // Set value via native setter so React/framework state updates, then
      // retry submit every 500ms until the textarea is cleared (= accepted)
      // or a 10s deadline. injectInProgress stays true until confirmed.
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? el.value + '\n' : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      var submitDeadline = Date.now() + 10000;
      setTimeout(function retrySubmit() {
        if (!el.value.trim()) { injectInProgress = false; return; } // cleared = accepted
        if (Date.now() >= submitDeadline) { injectInProgress = false; return; }
        submitInput(el);
        setTimeout(function checkCleared() {
          if (!el.value.trim() || Date.now() >= submitDeadline) { injectInProgress = false; return; }
          setTimeout(retrySubmit, 500);
        }, 400);
      }, 50);
    } else {
      // Contenteditable — TipTap/OWUI or plain ProseMirror (e.g. ChatGPT).
      el.focus();
      waitForStreamEnd(5000, function () {
        setTimeout(function () {
          var target = findInput() || el;
          var t = target.editor;
          var tiptap = (t && t.commands && typeof t.commands.setContent === 'function') ? t : null;

          // ── Clear + insert ──────────────────────────────────────────────────
          // TipTap: use its API to clear, then focus its underlying PM view.
          // Plain ProseMirror / generic CE: selectAll replaces on insertText.
          var domEl;
          if (tiptap) {
            tiptap.commands.focus();
            // Clear via TipTap API so OWUI's reactive layer sees the right event chain.
            // pasteText() / setContent() bypass the DOM event pipeline and cause OWUI
            // to leak the message UUID into the outgoing request context.
            tiptap.commands.clearContent(false);
            domEl = tiptap.view.dom;
          } else {
            target.focus();
            document.execCommand('selectAll', false);
            domEl = target;
          }
          domEl.focus();
          var inserted = document.execCommand('insertText', false, text);
          if (!inserted) {
            // execCommand blocked (sandboxed iframe, etc.)
            if (tiptap) {
              if (typeof tiptap.view.pasteText === 'function') {
                tiptap.view.pasteText(text);
              } else {
                var htmlEscaped = text
                  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                tiptap.commands.setContent('<code>' + htmlEscaped + '</code>', false);
              }
            } else {
              // Dispatch beforeinput so ProseMirror can handle it; textContent as last resort.
              var bievt = new InputEvent('beforeinput', {
                inputType: 'insertText', data: text, bubbles: true, cancelable: true,
              });
              domEl.dispatchEvent(bievt);
              if (!(domEl.innerText || domEl.textContent || '').trim()) {
                domEl.textContent = text;
                domEl.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          }

          // ── Shared retry + submit loop ──────────────────────────────────────
          // execCommand triggers ProseMirror reconciliation via MutationObserver
          // (microtask). Retry must run after that, or isEmpty is still true.
          // Works for TipTap (isEmpty API) and plain CE (innerText fallback).
          var deadline = Date.now() + 10000;
          setTimeout(function retry() {
            var inp = findInput() || target;
            var tp = inp.editor || tiptap;
            var isEmpty = (tp && tp.isEmpty !== undefined) ? tp.isEmpty
              : !(tp && tp.getText ? tp.getText().trim() : (inp.innerText || inp.textContent || '').trim());
            if (isEmpty) { injectInProgress = false; return; }
            if (Date.now() >= deadline) { injectInProgress = false; return; }
            var btn = findSendButton(inp);
            if (btn && !btn.disabled) {
              btn.click();
              // One click is enough — retrying risks a double-send in queued UIs.
              setTimeout(function () { injectInProgress = false; }, 600);
              return;
            }
            setTimeout(retry, 400);
          }, 100);
        }, ANNOTATION_GUARD_MS);
      });
    }

    return true;
  }

  /* ── Compact result summary ────────────────────────────────────────────── */
  function briefData(data) {
    if (!data) return 'ok';
    if (typeof data === 'string') return data;
    if (data.content !== undefined) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
    return JSON.stringify(data);
  }

  /* ── Format and inject combined batch result ───────────────────────────── */
  function injectCombinedResult(results) {
    var allOk = results.every(function (r) { return r.ok; });
    var lines = ['[Ontosphere — ' + results.length + ' tool' + (results.length !== 1 ? 's' : '') + (allOk ? ' ✓' : ' (some failed)') + ']'];
    results.forEach(function (r) {
      if (r.ok) {
        lines.push('`' + JSON.stringify({
          jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
          result: { content: [{ type: 'text', text: briefData(r.result && r.result.data) }] },
        }) + '`');
      } else {
        var err = (r.result && r.result.error) || 'failed';
        lines.push('`' + JSON.stringify({
          jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
          error: { code: -32000, message: String(err), data: { tool: r.tool } },
        }) + '`');
      }
    });
    var lastSummary = results[results.length - 1] && results[results.length - 1].summary;
    if (lastSummary) { lines.push(''); lines.push(lastSummary); }
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
      
      callQueue = [];
      var resp = JSON.stringify({
        jsonrpc: '2.0', id: timedOutId != null ? timedOutId : null,
        error: { code: -32000, message: timedOutTool + ' did not respond within ' + (CALL_TIMEOUT_MS / 1000) + ' s. A follow-up result will be injected automatically.', data: { tool: timedOutTool, lateResult: true } },
      });
      results.push({ tool: timedOutTool, mcpId: timedOutId, ok: false, result: { success: false, error: 'timeout' } });
      var timeoutLines = ['[Ontosphere — ⏱ ' + timedOutTool + ' timed out]'];
      results.forEach(function (r) {
        var rr = (r.tool === timedOutTool && !r.ok) ? resp : r.ok
          ? JSON.stringify({ jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null, result: { content: [{ type: 'text', text: briefData(r.result && r.result.data) }] } })
          : JSON.stringify({ jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null, error: { code: -32000, message: String((r.result && r.result.error) || 'failed'), data: { tool: r.tool } } });
        timeoutLines.push('`' + rr + '`');
      });
      var lastSumT = results[results.length - 1] && results[results.length - 1].summary;
      if (lastSumT) { timeoutLines.push(''); timeoutLines.push(lastSumT); }
      injectResult(timeoutLines.join('\n'));
      showToast('⏱ ' + timedOutTool + ' timed out', false);
    }, CALL_TIMEOUT_MS);
  }

  /* ── Result listener (popup → chat tab) ───────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (window.__vgRelayInstanceId !== instanceId) return; // stale instance
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;

    if (data && data.type === 'vg-ping') {
      if (typeof data.annotationGuardMs === 'number') {
        ANNOTATION_GUARD_MS = data.annotationGuardMs;
      }
      if (data.sessionId) {
        if (knownSessionId && knownSessionId !== data.sessionId) {
          showToast('Ontosphere reloaded — graph data was lost', false);
          clearTimeout(callTimeoutTimer);
          isProcessing = false; pendingTool = null; pendingMcpId = null; pendingRequestId = null;
          batchResults = []; callQueue = []; lateResult = null;
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
      var lateLines = ['[Ontosphere — late result for ' + lr.tool + (lok ? ' ✓' : ' ✗') + ']', '`' + lresp + '`'];
      if (data.summary) { lateLines.push(''); lateLines.push(data.summary); }
      injectResult(lateLines.join('\n'));
      showToast('Late result: ' + lr.tool, lok);
      return;
    }

    clearTimeout(callTimeoutTimer);
    lateResult = null;
    var ok = !!(data.result && data.result.success !== false);
    batchResults.push({ tool: pendingTool || '?', mcpId: pendingMcpId, ok: ok, result: data.result, summary: data.summary });
    isProcessing = false; pendingTool = null; pendingMcpId = null; pendingRequestId = null;

    if (callQueue.length > 0) {
      processNextInQueue();
    } else {
      var results = batchResults.slice();
      batchResults = [];
      injectCombinedResult(results);
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
  // Single IRI param (e.g. iri:"ex:Alice") → plain full IRI string, no brackets.
  function expandPrefix(val) {
    for (var p in KNOWN_PREFIXES) {
      if (val.indexOf(p) === 0) return KNOWN_PREFIXES[p] + val.slice(p.length);
    }
    return val;
  }

  // Turtle / SPARQL blob: replace every prefix:local with <full-iri>.
  // Angle brackets are required for full IRIs in both Turtle and SPARQL syntax.
  function expandPrefixesInContent(text) {
    var result = text;
    for (var p in KNOWN_PREFIXES) {
      var escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(
        new RegExp(escaped + '([A-Za-z0-9_\\-.]+)', 'g'),
        '<' + KNOWN_PREFIXES[p] + '$1>',
      );
    }
    return result;
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
        if (typeof params[k] === 'string') {
          params[k] = /[\s\n]/.test(params[k])
            ? expandPrefixesInContent(params[k])  // Turtle/SPARQL: wrap in <...>
            : expandPrefix(params[k]);             // single IRI: plain string
        }
      }
      var mcpId = req.id != null ? req.id : null;
      var sig = tool + ':' + JSON.stringify(params) + ':' + mcpId;
      if (!seen.has(sig)) { seen.add(sig); calls.push({ tool: tool, params: params, mcpId: mcpId }); }
    }
    return calls;
  }

  /* ── Streaming-idle detection ──────────────────────────────────────────── */
  // Primary signal: find the send/submit button and read its state.
  // A visible, enabled send button (not showing a stop icon) = AI is idle.
  // Absent, disabled-with-content, or replaced by a stop icon = generating.
  // Fallback signals cover UIs where no send button is discoverable.
  function findSendButton(inp) {
    var direct = document.getElementById('send-message-button');
    if (direct) return direct;
    var cur = inp && inp.parentElement;
    while (cur && cur !== document.body) {
      var found = null;
      var candidates = cur.querySelectorAll('button');
      for (var ci = 0; ci < candidates.length; ci++) {
        var cb = candidates[ci];
        var lbl = (cb.getAttribute('aria-label') || cb.title || cb.textContent || '').toLowerCase();
        var cls = (cb.className || '').toLowerCase();
        if (cb.type === 'submit' || lbl.includes('send') || lbl.includes('senden') ||
            lbl.includes('submit') || cls.includes('send') || cls.includes('submit')) {
          found = cb; break;
        }
      }
      if (found) return found;
      cur = cur.parentElement;
    }
    return null;
  }

  function isAiStreaming() {
    var inp = findInput();
    var sendBtn = findSendButton(inp);

    if (sendBtn) {
      // Enabled = idle; disabled + has content = generating (OWUI pattern).
      // OWUI during generation: send button is replaced by a stop button, so
      // findSendButton() returns null and the fallback signals below handle it.
      if (!sendBtn.disabled) return false;
      if (inp) {
        var content = inp.tagName === 'TEXTAREA'
          ? inp.value
          : (inp.innerText || inp.textContent || '');
        if (content.trim().length > 0) return true;
      }
      return false;
    }

    // Fallback for UIs without a discoverable send button
    if (inp) {
      if (inp.tagName === 'TEXTAREA' && inp.disabled) return true;
      if (inp.getAttribute('aria-disabled') === 'true') return true;
      var el = inp.parentElement;
      while (el && el !== document.body) {
        if (el.getAttribute('aria-busy') === 'true') return true;
        el = el.parentElement;
      }
    }

    return false;
  }

  /* ── Generic "wait for AI to stop generating" before injecting ────────── */
  // Requires isAiStreaming() to be false for 2 consecutive polls (600 ms) before
  // calling back. One false reading is not enough — OWUI briefly re-enables the
  // send button mid-annotation before generation is truly complete, which would
  // cause early injection and the UUID-echo bug.
  function waitForStreamEnd(maxMs, callback) {
    var deadline = Date.now() + maxMs;
    var idleStreak = 0;
    function poll() {
      if (Date.now() >= deadline) { callback(); return; }
      if (isAiStreaming()) {
        idleStreak = 0;
        setTimeout(poll, 300);
      } else if (++idleStreak >= 2) {
        callback();
      } else {
        setTimeout(poll, 300);
      }
    }
    poll();
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
      isProcessing = false; callQueue = []; batchResults = [];
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

  /* ── Dispatch poll ─────────────────────────────────────────────────────── */
  // Scans full page text every 500 ms. Dispatches immediately on any new
  // complete, valid MCP call. JSON structural completeness (validateMcpRequest)
  // is the signal — partial JSON fails JSON.parse and is ignored. No stability
  // window needed. dispatchedSigs deduplication handles repeats.
  var idlePollTimer = null;

  function idlePoll() {
    if (window.__vgRelayInstanceId !== instanceId) return; // stale instance
    if (!isProcessing && callQueue.length === 0) {
      var text = document.body.innerText || document.body.textContent || '';
      var calls = extractAllToolCalls(text, dispatchedSigs);
      if (calls.length > 0) {
        callQueue = callQueue.concat(calls);
        processNextInQueue();
      }
    }
    idlePollTimer = setTimeout(idlePoll, 500);
  }

  // Pre-seed: mark all calls currently visible on the page as already dispatched.
  extractAllToolCalls(document.body.innerText || document.body.textContent || '', dispatchedSigs);

  idlePoll();
  window.__vgRelayObserver = { disconnect: function () { clearTimeout(idlePollTimer); idlePollTimer = null; } };

})();
