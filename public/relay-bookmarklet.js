/**
 * VisGraph Relay Bookmarklet — full readable source
 *
 * This script is injected into the AI chat tab (ChatGPT, Claude.ai, Gemini, etc.)
 * via a bookmarklet.  It:
 *   1. Opens (or reuses) the relay popup window (relay.html).
 *   2. Watches the page for new assistant messages via MutationObserver.
 *   3. Extracts MCP JSON-RPC 2.0 tool calls from backtick-wrapped inline code.
 *   4. Forwards parsed tool calls to the relay popup via postMessage.
 *   5. Receives results back and injects backtick-wrapped JSON-RPC responses
 *      into the chat input so the AI can read them.
 *
 * The minified `javascript:` URL version of this script is what goes in the
 * draggable bookmarklet anchor (see Unit 5 sidebar).  The full source here is
 * kept readable for maintenance and updates.
 *
 * Message formats (shared with relay.html and the VisGraph app):
 *   To popup:   { type: 'vg-call', tool, params, requestId, isLast }
 *   From popup: { type: 'vg-result', requestId, result, summary?, svg? }
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────────── */
  var RELAY_URL    = '__RELAY_URL__';
  var RELAY_ORIGIN = '__RELAY_ORIGIN__';
  var POPUP_NAME   = 'vg-relay';
  var POPUP_OPTS   = 'width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes';
  var DEBOUNCE_MS  = 800;

  /* ── Popup management ──────────────────────────────────────────────────── */
  function openPopup() {
    if (!window.__vgRelayPopup || window.__vgRelayPopup.closed) {
      window.__vgRelayPopup = window.open(RELAY_URL, POPUP_NAME, POPUP_OPTS);
    }
    return window.__vgRelayPopup;
  }

  /* ── Idempotency guard ─────────────────────────────────────────────────── */
  if (window.__vgRelayActive) {
    // Re-open popup if closed, then re-show badge.
    var existingPopup = openPopup();
    showBadge();
    if (!existingPopup) {
      showToast('Popup blocked — allow popups for this site, then click the badge to retry', false);
      var existingBadge = document.getElementById('vg-relay-badge');
      if (existingBadge) existingBadge.style.animation = 'vg-pulse 0.6s ease 3';
    }
    return;
  }
  window.__vgRelayActive = true;

  /* ── Inject pulse keyframe for blocked-popup feedback ─────────────────── */
  (function () {
    var style = document.createElement('style');
    style.textContent = '@keyframes vg-pulse{0%,100%{outline:2px solid #3fb950}50%{outline:4px solid #f0883e}}';
    document.head.appendChild(style);
  })();

  /* ── "Relay Active" badge ──────────────────────────────────────────────── */
  function showBadge() {
    var existing = document.getElementById('vg-relay-badge');
    if (existing) { existing.style.display = 'flex'; return; }

    var badge = document.createElement('div');
    badge.id = 'vg-relay-badge';
    badge.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:2147483647',
      'background:#0d1117',
      'color:#3fb950',
      'border:1px solid #3fb950',
      'border-radius:6px',
      'padding:6px 10px',
      'font:13px/1.4 monospace',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
      'cursor:pointer',
    ].join(';');
    badge.title = 'Click to reopen relay popup';

    var text = document.createElement('span');
    text.textContent = '\uD83D\uDFE2 VisGraph Relay Active';

    var closeBtn = document.createElement('span');
    closeBtn.textContent = '\u00D7';
    closeBtn.style.cssText = 'cursor:pointer;color:#8b949e;font-size:15px;line-height:1';
    closeBtn.title = 'Close relay';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      badge.style.display = 'none';
      window.__vgRelayActive = false;
      var p = window.__vgRelayPopup;
      if (p && !p.closed) p.close();
      window.__vgRelayPopup = null;
    });

    badge.addEventListener('click', function () {
      var p = openPopup();
      if (!p) {
        showToast('Popup blocked — allow popups for this site, then click the badge to retry', false);
        badge.style.animation = 'vg-pulse 0.6s ease 3';
      }
    });
    badge.appendChild(text);
    badge.appendChild(closeBtn);
    document.body.appendChild(badge);
  }

  /* ── Initial popup open with blocked-popup detection ──────────────────── */
  (function () {
    var popup = openPopup();
    if (!popup) {
      showBadge();
      showToast('Popup blocked — allow popups for this site, then click the badge to retry', false);
      var b = document.getElementById('vg-relay-badge');
      if (b) b.style.animation = 'vg-pulse 0.6s ease 3';
    } else {
      showBadge();
    }
  })();

  /* ── Popup-closed watcher — hide badge when user closes the popup ──────── */
  (function () {
    var watchTimer = setInterval(function () {
      var p = window.__vgRelayPopup;
      if (p && p.closed) {
        clearInterval(watchTimer);
        window.__vgRelayActive = false;
        window.__vgRelayPopup = null;
        var badge = document.getElementById('vg-relay-badge');
        if (badge) badge.style.display = 'none';
      }
    }, 500);
  })();

  /* ── Result toast ──────────────────────────────────────────────────────── */
  function showToast(text, ok) {
    var t = document.createElement('div');
    t.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:12px',
      'z-index:2147483647',
      'background:#0d1117',
      'color:' + (ok ? '#3fb950' : '#f85149'),
      'border:1px solid ' + (ok ? '#3fb950' : '#f85149'),
      'border-radius:6px',
      'padding:8px 12px',
      'font:12px monospace',
      'max-width:340px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');
    t.textContent = (ok ? '✓ ' : '✗ ') + text.slice(0, 120);
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
  }

  /* ── Find the chat input ───────────────────────────────────────────────── */
  function findInput() {
    var candidates = Array.from(document.querySelectorAll(
      'textarea, div[contenteditable="true"]'
    )).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
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
    var cur = inputEl.parentElement;
    while (cur && cur !== document.body) {
      var btns = Array.from(cur.querySelectorAll('button'));
      var sendBtn = btns.find(function (b) {
        if (b.disabled) return false;
        var lbl = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
        return b.type === 'submit' || lbl.includes('send') || lbl.includes('submit');
      });
      if (sendBtn) { sendBtn.click(); return; }
      cur = cur.parentElement;
    }
    ['keydown', 'keyup'].forEach(function (type) {
      inputEl.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  }

  /* ── Inject result into chat input and auto-submit ─────────────────────── */
  // Three-layer fallback for cross-framework compatibility:
  //   1. Clipboard API + paste event (ProseMirror, TipTap, React controlled inputs)
  //   2. DataTransfer synthetic paste (synchronous, no permission needed)
  //   3. Legacy: textarea native setter OR execCommand (last resort)
  function injectResult(text) {
    var el = findInput();
    if (!el) {
      showToast('Could not find chat input', false);
      return false;
    }

    function doSubmit() {
      setTimeout(function () { submitInput(el); }, 500);
    }

    function fallback3() {
      el.focus();
      if (el.tagName === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, (el.value ? el.value + '\n' : '') + text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
      }
      doSubmit();
    }

    function fallback2() {
      try {
        var dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.focus();
        var snapBefore = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        var snapAfter = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
        if (snapAfter !== snapBefore) {
          doSubmit();
        } else {
          fallback3();
        }
      } catch (e) {
        fallback3();
      }
    }

    if (el.tagName === 'TEXTAREA') {
      // For React-controlled textareas the native-setter + input event is the
      // only reliable path — it updates React's internal fiber state so the
      // send button becomes enabled before doSubmit fires.
      // The clipboard/paste approach injects text into the DOM but bypasses
      // React's onChange, leaving the button disabled.
      fallback3();
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        el.focus();
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
        doSubmit();
      }).catch(function () {
        fallback2();
      });
    } else {
      fallback2();
    }

    return true;
  }

  /* ── Compact data summary for success results ──────────────────────────── */
  function briefData(data) {
    if (!data) return 'ok';
    if (typeof data === 'string') return data.slice(0, 80);
    if (data.iri) return data.iri;
    if (data.loaded !== undefined) {
      var brief = String(data.loaded);
      if (data.newEntitiesAvailable && data.newEntitiesAvailable.length) {
        brief += ' — ' + data.newEntitiesAvailable.length + ' new entities available';
      }
      return brief;
    }
    if (data.entities) return data.entities.length + ' entities';
    if (data.links) return data.links.length + ' links';
    if (data.results) {
      var onCanvas = data.results.filter(function (r) { return r.onCanvas; });
      return data.results.length + ' results' + (onCanvas.length ? ', ' + onCanvas.length + ' on canvas (auto-focused)' : '');
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
    // MCP JSON-RPC 2.0 responses — one backtick-wrapped compact JSON per tool call
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
    if (finalSummary) {
      lines.push('');
      lines.push(finalSummary);
    }
    if (finalSvg && typeof finalSvg === 'string') {
      lines.push('');
      lines.push('Current graph (SVG):');
      lines.push(finalSvg);
    }
    var text   = lines.join('\n');
    var toastMsg = 'Done: ' + results.length + ' tool' + (results.length !== 1 ? 's' : '');
    injectResult(text);
    showToast(toastMsg, allOk);
  }

  /* ── Batch queue state ─────────────────────────────────────────────────── */
  var callQueue             = [];
  var batchResults          = [];
  var isProcessing          = false;
  var pendingTool           = null;
  var pendingMcpId          = null;
  var pendingRequestId      = null;  // requestId of the in-flight call
  var lastSummary           = null;
  var callTimeoutTimer      = null;
  var knownSessionId        = null;  // session hash of the current VisGraph page load
  var lateResult            = null;  // { requestId, tool, mcpId } — awaiting late delivery
  var CALL_TIMEOUT_MS       = 30000; // 30 s base; each vg-ping resets it (long ops keep pinging)

  function resetCallTimeout() {
    clearTimeout(callTimeoutTimer);
    callTimeoutTimer = setTimeout(function () {
      if (!isProcessing) return;
      var timedOutTool      = pendingTool    || '?';
      var timedOutId        = pendingMcpId;
      var timedOutRequestId = pendingRequestId;
      isProcessing   = false;
      pendingTool    = null;
      pendingMcpId   = null;
      pendingRequestId = null;

      // Remember this requestId — if the result arrives later we'll inject it
      lateResult = { requestId: timedOutRequestId, tool: timedOutTool, mcpId: timedOutId };

      // Flush any results already collected, plus a timeout notice for the stalled tool
      var results = batchResults.slice();
      batchResults = [];
      var summary  = lastSummary;
      lastSummary  = null;
      callQueue    = [];

      var timeoutLine = '[VisGraph — ⏱ ' + timedOutTool + ' timed out — result may still arrive as a follow-up]';
      var resp = JSON.stringify({
        jsonrpc: '2.0', id: timedOutId != null ? timedOutId : null,
        error: {
          code: -32000,
          message: timedOutTool + ' did not respond within ' + (CALL_TIMEOUT_MS / 1000) + ' s. The tool is likely still running. A follow-up result will be injected automatically when it completes.',
          data: { tool: timedOutTool, lateResult: true },
        },
      });
      results.push({ tool: timedOutTool, mcpId: timedOutId, ok: false, result: { success: false, error: 'timeout' } });

      // Build and inject: previous results (if any) + timeout notice
      var lines = [timeoutLine];
      results.forEach(function (r) {
        var rResp;
        if (r.tool === timedOutTool && !r.ok && r.result && r.result.error === 'timeout') {
          rResp = resp;
        } else if (r.ok) {
          rResp = JSON.stringify({
            jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
            result: { content: [{ type: 'text', text: briefData(r.result && r.result.data) }] },
          });
        } else {
          var err = (r.result && r.result.error) || 'failed';
          rResp = JSON.stringify({
            jsonrpc: '2.0', id: r.mcpId != null ? r.mcpId : null,
            error: { code: -32000, message: String(err), data: { tool: r.tool } },
          });
        }
        lines.push('`' + rResp + '`');
      });
      if (summary) { lines.push(''); lines.push(summary); }
      injectResult(lines.join('\n'));
      showToast('⏱ ' + timedOutTool + ' timed out — awaiting late result', false);
    }, CALL_TIMEOUT_MS);
  }

  /* ── Result listener (popup → AI tab) ─────────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (evt.origin !== RELAY_ORIGIN) {
      var d = evt.data;
      if (d && (d.type === 'vg-result' || d.type === 'vg-ping')) {
        console.warn('[vg-relay] Dropped message from unexpected origin:', evt.origin, '— expected:', RELAY_ORIGIN, 'type:', d.type);
      }
      return;
    }
    var data = evt.data;

    // Heartbeat from popup while a long tool (layout, reasoning) is running
    if (data && data.type === 'vg-ping') {
      if (data.sessionId) {
        if (knownSessionId && knownSessionId !== data.sessionId) {
          // VisGraph reloaded — new session detected
          showToast('VisGraph reloaded — graph data was lost', false);
          clearTimeout(callTimeoutTimer);
          isProcessing   = false;
          pendingTool    = null;
          pendingMcpId   = null;
          pendingRequestId = null;
          batchResults   = [];
          callQueue      = [];
          lastSummary    = null;
          lateResult     = null;
        }
        knownSessionId = data.sessionId;
      }
      resetCallTimeout(); // extend deadline
      return;
    }

    if (!data || data.type !== 'vg-result') return;

    // Late result arriving after a timeout — inject as standalone follow-up
    if (!isProcessing && lateResult && data.requestId && data.requestId === lateResult.requestId) {
      var lr = lateResult;
      lateResult = null;
      clearTimeout(callTimeoutTimer);
      var ok = !!(data.result && data.result.success !== false);
      var lResp;
      if (ok) {
        lResp = JSON.stringify({
          jsonrpc: '2.0', id: lr.mcpId != null ? lr.mcpId : null,
          result: { content: [{ type: 'text', text: briefData(data.result && data.result.data) }] },
        });
      } else {
        var lErr = (data.result && data.result.error) || 'failed';
        lResp = JSON.stringify({
          jsonrpc: '2.0', id: lr.mcpId != null ? lr.mcpId : null,
          error: { code: -32000, message: String(lErr), data: { tool: lr.tool } },
        });
      }
      var lLines = ['[VisGraph — late result for ' + lr.tool + (ok ? ' ✓' : ' ✗') + ']'];
      lLines.push('`' + lResp + '`');
      if (data.summary) { lLines.push(''); lLines.push(data.summary); }
      if (data.svg) { lLines.push(''); lLines.push('Current graph (SVG):'); lLines.push(data.svg); }
      injectResult(lLines.join('\n'));
      showToast('Late result: ' + lr.tool, ok);
      return;
    }

    clearTimeout(callTimeoutTimer);
    lateResult = null; // new result arrived — any previous late-result slot is stale

    var ok = !!(data.result && data.result.success !== false);
    batchResults.push({ tool: pendingTool || '?', mcpId: pendingMcpId, ok: ok, result: data.result });
    if (data.summary) lastSummary = data.summary;
    isProcessing   = false;
    pendingTool    = null;
    pendingMcpId   = null;
    pendingRequestId = null;

    if (callQueue.length > 0) {
      processNextInQueue();
    } else {
      var results = batchResults.slice();
      var summary = lastSummary;
      batchResults = [];
      lastSummary  = null;
      injectCombinedResult(results, summary, data.svg);
    }
  });

  /* ── Common RDF prefix expansion ──────────────────────────────────────── */
  var KNOWN_PREFIXES = {
    'rdf:'     : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'rdfs:'    : 'http://www.w3.org/2000/01/rdf-schema#',
    'owl:'     : 'http://www.w3.org/2002/07/owl#',
    'xsd:'     : 'http://www.w3.org/2001/XMLSchema#',
    'foaf:'    : 'http://xmlns.com/foaf/0.1/',
    'skos:'    : 'http://www.w3.org/2004/02/skos/core#',
    'dc:'      : 'http://purl.org/dc/elements/1.1/',
    'dcterms:' : 'http://purl.org/dc/terms/',
    'schema:'  : 'https://schema.org/',
    'ex:'      : 'http://example.org/',
  };

  function expandPrefix(val) {
    for (var p in KNOWN_PREFIXES) {
      if (val.indexOf(p) === 0) {
        return KNOWN_PREFIXES[p] + val.slice(p.length);
      }
    }
    return val;
  }

  /* ── Tool-call extractor ───────────────────────────────────────────────── */
  //
  // Detects MCP JSON-RPC 2.0 tool calls written as single-backtick inline code:
  //   `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{...}}}`
  //
  // Works on both raw text (backticks present) and rendered HTML where the
  // backtick content lands in <code> element text (no backticks in innerText).
  // Streaming safety: truncated JSON has unbalanced braces → brace scanner skips it.
  // False-positive guard: validateMcpRequest rejects anything not a valid tools/call.

  var dispatchedSigs = new Set();

  function validateMcpRequest(obj) {
    if (!obj || obj.jsonrpc !== '2.0') return false;
    if (obj.method !== 'tools/call') return false;
    if (!obj.params || typeof obj.params.name !== 'string') return false;
    return true;
  }

  // Scan text for balanced top-level {...} JSON objects via brace depth tracking.
  // Handles both raw text (backtick-wrapped) and rendered text (plain JSON in <code>).
  function extractJsonObjects(text) {
    var objects = [];
    var i = 0, n = text.length;
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
      if (!complete) break; // truncated JSON — stop scanning
    }
    return objects;
  }

  function extractAllToolCalls(text) {
    var calls = [];
    var objects = extractJsonObjects(text);
    for (var i = 0; i < objects.length; i++) {
      var req;
      try { req = JSON.parse(objects[i]); } catch (e) { continue; }
      if (!validateMcpRequest(req)) continue;
      var tool = req.params.name;
      var params = req.params.arguments || {};
      // Expand known RDF prefixes in string argument values
      for (var k in params) {
        if (typeof params[k] === 'string') params[k] = expandPrefix(params[k]);
      }
      var sig = tool + ':' + JSON.stringify(params);
      if (!dispatchedSigs.has(sig)) {
        dispatchedSigs.add(sig);
        calls.push({ tool: tool, params: params, mcpId: req.id != null ? req.id : null });
      }
    }
    return calls;
  }

  /* ── Streaming-idle detection ─────────────────────────────────────────── */
  // Checks whether the AI is still generating using HTML-agnostic signals:
  //   1. The chat input is disabled (universal: UIs lock input while AI responds)
  //   2. The send button near the input is disabled (same universal contract)
  //   3. aria-busy="true" on an ancestor (ARIA standard for async content)
  //   4. A visible stop/abort button exists (explicit generation controls)
  // No framework-specific class names needed.

  function isAiStreaming() {
    // ── 1. Input element locked ─────────────────────────────────────────
    var inp = findInput();
    if (inp) {
      if (inp.disabled) return true;
      if (inp.getAttribute('aria-disabled') === 'true') return true;
    }

    // ── 2. Send button disabled ─────────────────────────────────────────
    // Walk up from input to find a submit/send button and check disabled.
    if (inp) {
      var cur = inp.parentElement;
      while (cur && cur !== document.body) {
        var buttons = Array.from(cur.querySelectorAll('button'));
        var sendBtn = buttons.find(function (b) {
          var lbl = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
          return b.type === 'submit' || lbl.includes('send') || lbl.includes('senden') || lbl.includes('submit');
        });
        if (sendBtn) {
          if (sendBtn.disabled) return true;
          break; // found but not disabled → not streaming by this signal
        }
        cur = cur.parentElement;
      }
    }

    // ── 3. aria-busy on any ancestor of the input ───────────────────────
    if (inp) {
      var el = inp.parentElement;
      while (el && el !== document.body) {
        if (el.getAttribute('aria-busy') === 'true') return true;
        el = el.parentElement;
      }
    }

    return false;
  }

  /**
   * Wait until the AI appears idle (streaming indicators gone AND the
   * container text has stopped growing), then call callback.
   * Falls back after MAX_WAIT_MS regardless.
   */
  function waitForIdle(container, callback) {
    var MAX_WAIT_MS  = 30000;
    var POLL_MS      = 200;
    var STABLE_TICKS = 3;   // text must be same length for 3 polls (600 ms)
    var elapsed      = 0;
    var lastLen      = -1;
    var stableCount  = 0;

    function poll() {
      elapsed += POLL_MS;
      var len = (container.innerText || container.textContent || '').length;

      if (len !== lastLen) {
        lastLen     = len;
        stableCount = 0;
      } else {
        stableCount++;
      }

      var streaming = isAiStreaming();
      var stable    = stableCount >= STABLE_TICKS;

      if ((!streaming && stable) || elapsed >= MAX_WAIT_MS) {
        callback();
      } else {
        setTimeout(poll, POLL_MS);
      }
    }

    setTimeout(poll, POLL_MS);
  }

  var drainTimer = null;

  function scheduleDrain(container) {
    clearTimeout(drainTimer);
    drainTimer = setTimeout(function () {
      waitForIdle(container, function () {
        if (!isProcessing) processNextInQueue();
      });
    }, DEBOUNCE_MS);
  }

  function parseAndEnqueue(el) {
    if (!el) return;
    var text = el.innerText || el.textContent || '';
    var calls = extractAllToolCalls(text);
    if (calls.length === 0) return;
    callQueue = callQueue.concat(calls);
    scheduleDrain(el);
  }

  function processNextInQueue() {
    if (isProcessing || callQueue.length === 0) return;
    isProcessing = true;
    var item = callQueue.shift();
    var isLast = callQueue.length === 0; // last item in this batch

    var popup = window.__vgRelayPopup;
    if (!popup || popup.closed) popup = openPopup();
    if (!popup) {
      showToast('Relay popup could not open', false);
      isProcessing = false;
      callQueue = [];
      batchResults = [];
      lastSummary = null;
      return;
    }
    pendingTool      = item.tool;
    pendingMcpId     = item.mcpId != null ? item.mcpId : null;
    lateResult       = null; // new batch — discard any stale late-result slot
    var requestId    = 'rq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    pendingRequestId = requestId;
    var payload = {
      type: 'vg-call',
      tool: item.tool,
      params: item.params,
      requestId: requestId,
      isLast: isLast,
    };
    setTimeout(function () {
      try {
        popup.postMessage(payload, RELAY_ORIGIN);
        resetCallTimeout();
      } catch (e) {
        console.warn('[vg-relay] postMessage failed:', e);
        isProcessing = false;
      }
    }, 200);
  }

  /* ── MutationObserver — scan every new/changed node ───────────────────── */
  var debounceTimer = null;
  var pendingNodes = new Set();

  function flushPending() {
    pendingNodes.forEach(function (node) { parseAndEnqueue(node); });
    pendingNodes.clear();
  }

  function collectAncestors(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'p' || tag === 'li') {
        // p/li are inline containers — climb to nearest block ancestor so we
        // scan the whole message (params may be in sibling <p> elements).
        var parent = el.parentElement;
        while (parent && parent !== document.body) {
          var ptag = parent.tagName ? parent.tagName.toLowerCase() : '';
          if (ptag === 'div' || ptag === 'section' || ptag === 'article') {
            pendingNodes.add(parent);
            return;
          }
          parent = parent.parentElement;
        }
        pendingNodes.add(el);
        return;
      }
      if (tag === 'div' || tag === 'section' || tag === 'article') {
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

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  setTimeout(function () { parseAndEnqueue(document.body); }, 500);

})();
