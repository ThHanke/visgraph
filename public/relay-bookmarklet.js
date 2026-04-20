/**
 * VisGraph Relay Bookmarklet — full readable source
 *
 * This script is injected into the AI chat tab (ChatGPT, Claude.ai, Gemini, etc.)
 * via a bookmarklet.  It:
 *   1. Opens (or reuses) the relay popup window (relay.html).
 *   2. Watches the page for new assistant messages via MutationObserver.
 *   3. Parses "TOOL: <name>\nPARAMS: <json>" patterns from those messages.
 *   4. Forwards parsed tool calls to the relay popup via postMessage.
 *   5. Receives results back from the popup and copies them to the clipboard.
 *
 * The minified `javascript:` URL version of this script is what goes in the
 * draggable bookmarklet anchor (see Unit 5 sidebar).  The full source here is
 * kept readable for maintenance and updates.
 *
 * Message formats (shared with relay.html and the VisGraph app):
 *   To popup:   { type: 'vg-call',   tool: string, params: unknown, requestId: string }
 *   From popup: { type: 'vg-result', requestId: string, result: unknown, svg?: string }
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
      'cursor:default',
    ].join(';');

    var text = document.createElement('span');
    text.textContent = '\uD83D\uDFE2 VisGraph Relay Active';

    var closeBtn = document.createElement('span');
    closeBtn.textContent = '\u00D7';
    closeBtn.style.cssText = 'cursor:pointer;color:#8b949e;font-size:15px;line-height:1';
    closeBtn.title = 'Hide badge (relay stays active)';
    closeBtn.addEventListener('click', function () {
      badge.style.display = 'none';
    });

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

  /* ── Inject result into ChatGPT input ─────────────────────────────────── */
  function injectResult(text) {
    var selectors = [
      '#prompt-textarea',
      'div[contenteditable="true"]',
      'textarea[data-id]',
      'textarea',
    ];
    var el = null;
    for (var i = 0; i < selectors.length; i++) {
      el = document.querySelector(selectors[i]);
      if (el) break;
    }
    if (!el) return false;

    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      var current = el.value ? el.value + '\n' : '';
      nativeInputValueSetter.call(el, current + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable div (ChatGPT uses this)
      var current = el.innerText ? el.innerText + '\n' : '';
      el.innerText = current + text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  }

  /* ── Result listener (popup → AI tab) ─────────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;
    if (!data || data.type !== 'vg-result') return;

    var ok = data.result && data.result.success !== false;
    var text = 'Tool result: ' + JSON.stringify(data.result !== undefined ? data.result : data, null, 2);

    injectResult(text);
    showToast(ok ? 'Result injected into chat' : 'Error injected into chat', ok);
  });

  /* ── HTML entity decoder ───────────────────────────────────────────────── */
  function decodeHtml(s) {
    var t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  /* ── Tool-call pattern parser ──────────────────────────────────────────── */
  var TOOL_RE = /```visgraph\s*\nTOOL:\s*(\w+)\s*\nPARAMS:\s*(\{[\s\S]*?\})\s*\n```/g;

  var TOOL_PLAIN_RE = /TOOL:\s*(\w+)\s*\nPARAMS:\s*(\{[\s\S]*?\})/;

  function tryParse(toolName, paramsRaw) {
    var raw = decodeHtml(paramsRaw.trim());
    try {
      sendToolCall(toolName, JSON.parse(raw));
      return true;
    } catch (e) {
      showParseError(toolName, raw, e);
      return false;
    }
  }

  function parseAndSend(el) {
    if (el.dataset && el.dataset.vgProcessed) return;

    // 1. Scan rendered <code>/<pre> blocks (chat UIs render ```visgraph as these)
    var codeBlocks = el.querySelectorAll ? el.querySelectorAll('pre code, pre, code') : [];
    var found = false;
    Array.from(codeBlocks).forEach(function (block) {
      if (block.dataset && block.dataset.vgProcessed) return;
      var txt = block.innerText || block.textContent || '';
      // Match blocks that look like visgraph tool calls
      var m = TOOL_PLAIN_RE.exec(txt);
      if (m) {
        found = true;
        tryParse(m[1], m[2]);
        if (block.dataset) block.dataset.vgProcessed = '1';
      }
    });

    // 2. Fallback: scan raw innerText for ```visgraph fences (unrendered)
    var text = el.innerText || el.textContent || '';
    var match;
    TOOL_RE.lastIndex = 0;
    while ((match = TOOL_RE.exec(text)) !== null) {
      found = true;
      tryParse(match[1], match[2]);
    }

    if (found && el.dataset) el.dataset.vgProcessed = '1';
  }

  function sendToolCall(tool, params) {
    var popup = openPopup();
    var requestId = 'rq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    var payload = { type: 'vg-call', tool: tool, params: params, requestId: requestId };
    // Small delay to let the popup finish loading if it was just opened
    setTimeout(function () {
      try {
        popup.postMessage(payload, RELAY_ORIGIN);
      } catch (e) {
        console.warn('[vg-relay] postMessage failed:', e);
      }
    }, 200);
  }

  /* ── Parse error warning overlay ───────────────────────────────────────── */
  function showParseError(toolName, raw, err) {
    var warn = document.createElement('div');
    warn.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:12px',
      'z-index:2147483647',
      'background:#161b22',
      'color:#f85149',
      'border:1px solid #f85149',
      'border-radius:6px',
      'padding:8px 12px',
      'font:12px monospace',
      'max-width:340px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');
    warn.textContent = '[vg-relay] JSON parse error for tool "' + toolName + '": ' + err.message;
    document.body.appendChild(warn);
    setTimeout(function () {
      if (warn.parentNode) warn.parentNode.removeChild(warn);
    }, 6000);
  }

  /* ── MutationObserver — scan every new/changed node generically ────────── */
  var debounceTimer = null;
  var pendingNodes = new Set();

  function flushPending() {
    pendingNodes.forEach(function (node) { parseAndSend(node); });
    pendingNodes.clear();
  }

  function collectAncestors(node) {
    // Walk up to find a meaningful block-level container to scan
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.vgProcessed) return; // already done
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      // Stop at block containers that likely hold a full AI response
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

  // Initial scan of full body in case messages already present
  setTimeout(function () { parseAndSend(document.body); }, 500);

})();
