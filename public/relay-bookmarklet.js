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

  /* ── Result listener (popup → AI tab) ─────────────────────────────────── */
  window.addEventListener('message', function (evt) {
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;
    if (!data || data.type !== 'vg-result') return;

    var text = JSON.stringify(data.result !== undefined ? data.result : data, null, 2);

    // Try clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        showOverlay(text);
      });
    } else {
      showOverlay(text);
    }
  });

  /* ── Clipboard fallback overlay ────────────────────────────────────────── */
  function showOverlay(text) {
    var overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'background:rgba(0,0,0,.7)',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:12px',
      'font:14px/1.5 monospace',
      'color:#c9d1d9',
    ].join(';');

    var box = document.createElement('textarea');
    box.value = text;
    box.style.cssText = 'width:80%;height:200px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:8px;font:13px monospace';
    box.readOnly = true;

    var msg = document.createElement('p');
    msg.textContent = 'VisGraph result (copy manually — clipboard blocked):';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'padding:6px 18px;cursor:pointer;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px';
    closeBtn.addEventListener('click', function () { document.body.removeChild(overlay); });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });

    overlay.appendChild(msg);
    overlay.appendChild(box);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
    box.select();
  }

  /* ── Tool-call pattern parser ──────────────────────────────────────────── */
  var TOOL_RE = /TOOL:\s*(\w+)\s*\nPARAMS:\s*(\{[\s\S]*?\})\s*(?:\n|$)/g;

  function parseAndSend(el) {
    if (el.dataset && el.dataset.vgProcessed) return;
    var text = el.innerText || el.textContent || '';
    var match;
    TOOL_RE.lastIndex = 0;
    var found = false;
    while ((match = TOOL_RE.exec(text)) !== null) {
      found = true;
      var toolName = match[1];
      var paramsRaw = match[2];
      try {
        var params = JSON.parse(paramsRaw);
        sendToolCall(toolName, params);
      } catch (e) {
        showParseError(toolName, paramsRaw, e);
      }
    }
    if (found && el.dataset) {
      el.dataset.vgProcessed = '1';
    }
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

  /* ── MutationObserver — watch for new assistant messages ───────────────── */
  var debounceTimer = null;

  function scanPage() {
    // ChatGPT
    var chatgpt = document.querySelectorAll('[data-message-author-role="assistant"]');
    // Claude.ai (try both selectors, use all matches)
    var claudeA  = document.querySelectorAll('[data-testid*="message"]');
    var claudeB  = document.querySelectorAll('.font-claude-message');
    // Gemini
    var geminiA  = document.querySelectorAll('model-response');
    var geminiB  = document.querySelectorAll('.model-response-text');

    var all = Array.from(chatgpt)
      .concat(Array.from(claudeA))
      .concat(Array.from(claudeB))
      .concat(Array.from(geminiA))
      .concat(Array.from(geminiB));

    all.forEach(parseAndSend);
  }

  var observer = new MutationObserver(function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanPage, DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Initial scan in case messages are already present
  setTimeout(scanPage, 500);

})();
