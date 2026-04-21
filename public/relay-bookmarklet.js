/**
 * VisGraph Relay Bookmarklet — full readable source
 *
 * This script is injected into the AI chat tab (ChatGPT, Claude.ai, Gemini, etc.)
 * via a bookmarklet.  It:
 *   1. Opens (or reuses) the relay popup window (relay.html).
 *   2. Watches the page for new assistant messages via MutationObserver.
 *   3. Parses "TOOL: <name>\nparam: value" patterns from those messages.
 *   4. Forwards parsed tool calls to the relay popup via postMessage.
 *   5. Receives results back from the popup and injects a compact summary
 *      (✓/✗ per tool + canvas state + optional SVG) into the chat input.
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
  var RELAY_URL    = 'https://thhanke.github.io/visgraph/relay.html';
  var RELAY_ORIGIN = 'https://thhanke.github.io';
  var POPUP_NAME   = 'vg-relay';
  var POPUP_OPTS   = 'width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes';
  var DEBOUNCE_MS  = 400;

  /* ── Idempotency guard ─────────────────────────────────────────────────── */
  if (window.__vgRelayActive) {
    showBadge(); // re-show badge if closed
    return;
  }
  window.__vgRelayActive = true;

  /* ── Popup management ──────────────────────────────────────────────────── */
  function openPopup() {
    if (!window.__vgRelayPopup || window.__vgRelayPopup.closed) {
      window.__vgRelayPopup = window.open(RELAY_URL, POPUP_NAME, POPUP_OPTS);
    }
    return window.__vgRelayPopup;
  }
  openPopup();

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
    closeBtn.title = 'Hide badge (relay stays active)';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      badge.style.display = 'none';
    });

    badge.addEventListener('click', function () { openPopup(); });
    badge.appendChild(text);
    badge.appendChild(closeBtn);
    document.body.appendChild(badge);
  }
  showBadge();

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
  function injectResult(text) {
    var el = findInput();
    if (!el) return false;

    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? el.value + '\n' : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      var prefix = el.textContent && el.textContent.trim() ? '\n' : '';
      document.execCommand('insertText', false, prefix + text);
    }
    setTimeout(function () { submitInput(el); }, 300);
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
    if (data.content !== undefined) return '(' + (data.content.length || 0) + ' chars)';
    if (data.expanded !== undefined) return data.expanded + ' nodes expanded';
    return JSON.stringify(data).slice(0, 80);
  }

  /* ── Format and inject combined batch result ───────────────────────────── */
  function injectCombinedResult(results, finalSummary, finalSvg) {
    var allOk = results.every(function (r) { return r.ok; });
    var lines = ['[VisGraph — ' + results.length + ' tool' + (results.length !== 1 ? 's' : '') + (allOk ? ' ✓' : ' (some failed)') + ']'];
    results.forEach(function (r) {
      if (r.ok) {
        lines.push('✓ ' + r.tool + ': ' + briefData(r.result && r.result.data));
      } else {
        var err = (r.result && r.result.error) || 'failed';
        lines.push('✗ ' + r.tool + ': ' + err);
      }
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
    injectResult(lines.join('\n'));
    showToast('Done: ' + results.length + ' tool' + (results.length !== 1 ? 's' : ''), allOk);
  }

  /* ── Batch queue state ─────────────────────────────────────────────────── */
  var callQueue    = [];
  var batchResults = [];
  var isProcessing = false;
  var pendingTool  = null;
  var lastSummary  = null;

  /* ── Result listener (popup → AI tab) ─────────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;
    if (!data || data.type !== 'vg-result') return;

    var ok = !!(data.result && data.result.success !== false);
    batchResults.push({ tool: pendingTool || '?', ok: ok, result: data.result });
    if (data.summary) lastSummary = data.summary;
    isProcessing = false;
    pendingTool  = null;

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
  // Handles:
  //  - Plain TOOL blocks
  //  - TOOL blocks wrapped in markdown fences (```text ... ```, ``` ... ```)
  //  - Prefixed IRIs (rdf:type, owl:Class, ex:Alice, etc.) — expanded to full IRIs
  //  - Values: booleans, numbers, strings coerced automatically

  var dispatchedSigs = new Set();

  function extractAllToolCalls(text) {
    // Strip markdown code fences before parsing — models often wrap TOOL blocks
    var stripped = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, '$1');

    var calls = [];
    var parts = stripped.split(/^TOOL:\s*/m);
    for (var i = 1; i < parts.length; i++) {
      var lines = parts[i].split('\n');
      // Extract tool name = first word; params may be inline on same line or on subsequent lines
      var firstLine = lines[0].trim();
      var toolMatch = firstLine.match(/^(\w+)(.*)/);
      if (!toolMatch) continue;
      var tool = toolMatch[1];
      var params = {};

      // Build a flat list of "key: value" strings from inline rest + subsequent lines.
      // Inline format: "key: val key: val" — split on boundaries before each "word:"
      function parseParamLine(line) {
        line = line.trim();
        if (!line) return;
        // Try standard single "key: value" (whole line).
        // But only use it when the value part doesn't contain additional " word:" tokens
        // (which would mean the line has multiple inline params that need splitting).
        var kv = line.match(/^(\w+):\s*(.+)/);
        if (kv && !/\s+\w+:/.test(kv[2])) {
          var v = kv[2].trim();
          if (v.indexOf(':') !== -1 && v.indexOf(' ') === -1) v = expandPrefix(v);
          params[kv[1]] = v === 'true' ? true : v === 'false' ? false
            : (!isNaN(+v) && v !== '') ? +v : v;
          return;
        }
        // Inline: multiple "key: value" pairs — match each pair stopping before next \s+word:
        // This correctly handles IRI values that contain "http:" or "https:".
        var pairRe = /(\w+):\s*(.*?)(?=\s+\w+:|$)/g;
        var mp;
        while ((mp = pairRe.exec(line)) !== null) {
          var v = mp[2].trim();
          if (!v) continue;
          if (v.indexOf(':') !== -1 && v.indexOf(' ') === -1) v = expandPrefix(v);
          params[mp[1]] = v === 'true' ? true : v === 'false' ? false
            : (!isNaN(+v) && v !== '') ? +v : v;
        }
      }

      var inlineRest = toolMatch[2].trim();
      if (inlineRest) parseParamLine(inlineRest);
      for (var j = 1; j < lines.length; j++) parseParamLine(lines[j]);
      var sig = tool + ':' + JSON.stringify(params);
      if (!dispatchedSigs.has(sig)) {
        dispatchedSigs.add(sig);
        calls.push({ tool: tool, params: params });
      }
    }
    return calls;
  }

  function parseAndEnqueue(el) {
    if (!el || (el.dataset && el.dataset.vgProcessed)) return;
    var text = el.innerText || el.textContent || '';
    var calls = extractAllToolCalls(text);
    if (calls.length === 0) return;
    if (el.dataset) el.dataset.vgProcessed = '1';
    callQueue = callQueue.concat(calls);
    if (!isProcessing) processNextInQueue();
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
    pendingTool = item.tool;
    var requestId = 'rq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
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
      if (el.dataset && el.dataset.vgProcessed) return;
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'li') {
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
