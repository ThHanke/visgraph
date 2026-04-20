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
  // Only open via user gesture (bookmark click or badge click) to avoid popup blockers.
  function openPopup() {
    if (!window.__vgRelayPopup || window.__vgRelayPopup.closed) {
      window.__vgRelayPopup = window.open(RELAY_URL, POPUP_NAME, POPUP_OPTS);
    }
    return window.__vgRelayPopup;
  }
  openPopup(); // bookmark click = user gesture → always allowed

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

    // Badge click (not the × button) reopens popup — this IS a user gesture
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

  /* ── Find multiline input near the tool-call source element ───────────── */
  function findInput(sourceEl) {
    // Walk up from the element where the tool call was detected.
    // At each level, look for a multiline input in the subtree.
    // This works because the chat input is always in a sibling subtree
    // of the message area — we just need their common ancestor.
    var el = (sourceEl && document.contains(sourceEl)) ? sourceEl : document.body;
    while (el && el !== document.body) {
      var inp = pickInput(el);
      if (inp) return inp;
      el = el.parentElement;
    }
    // Body-level fallback
    return pickInput(document.body);
  }

  function pickInput(root) {
    // Prefer textarea, fall back to contenteditable; take last (bottom of page)
    var all = Array.from(root.querySelectorAll('textarea, div[contenteditable="true"]'));
    if (!all.length) return null;
    var textareas = all.filter(function (e) { return e.tagName === 'TEXTAREA'; });
    return textareas.length ? textareas[textareas.length - 1] : all[all.length - 1];
  }

  /* ── Submit the chat input (send button or Enter key) ─────────────────── */
  function submitInput(inputEl) {
    // Walk up from the input to find a send/submit button in the same form/container
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
    // Fallback: Enter keypress on the input itself
    ['keydown', 'keyup'].forEach(function (type) {
      inputEl.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  }

  /* ── Inject result into chat input and auto-submit ─────────────────────── */
  function injectResult(text, sourceEl) {
    var el = findInput(sourceEl);
    if (!el) return false;

    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? el.value + '\n' : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ProseMirror/TipTap manage their own state — setting innerText is overwritten immediately.
      // execCommand('insertText') goes through the browser input pipeline that these frameworks hook.
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // move cursor to end
      sel.removeAllRanges();
      sel.addRange(range);
      var prefix = el.textContent && el.textContent.trim() ? '\n' : '';
      document.execCommand('insertText', false, prefix + text);
    }
    setTimeout(function () { submitInput(el); }, 300);
    return true;
  }

  /* ── Result listener (popup → AI tab) ─────────────────────────────────── */
  // Keyed by requestId so concurrent calls inject into the right source element
  var pendingSourceEl = {};

  window.addEventListener('message', function (evt) {
    if (evt.origin !== RELAY_ORIGIN) return;
    var data = evt.data;
    if (!data || data.type !== 'vg-result') return;

    var ok = data.result && data.result.success !== false;
    var text = 'Tool result: ' + JSON.stringify(data.result !== undefined ? data.result : data, null, 2);
    var sourceEl = pendingSourceEl[data.requestId] || null;
    delete pendingSourceEl[data.requestId];

    injectResult(text, sourceEl);
    showToast(ok ? 'Result injected into chat' : 'Error injected into chat', ok);
  });

  /* ── Tool-call extractor ───────────────────────────────────────────────── */
  //
  // Format (instructed to AI):
  //   TOOL: toolName
  //   param1: value1
  //   param2: value2
  //
  // Key:value lines replace JSON — no quotes, no curly braces, no parse errors.
  // el.innerText/textContent decodes HTML entities and strips all tags automatically,
  // so hyperlinked URLs, hljs spans, and &quot; encoding are all handled transparently.

  // Dedup set — prevents re-firing when chat UI collapses/expands messages
  var dispatchedSigs = new Set();

  function extractAndSend(text, sourceEl) {
    // ^...$  with multiline flag: tool name must be alone on its line
    var m = text.match(/^TOOL:\s*(\w+)\s*$/m);
    if (!m) return false;
    var tool = m[1];
    var params = {};
    var after = text.slice(text.indexOf(m[0]) + m[0].length);
    after.split('\n').forEach(function (line) {
      var kv = line.match(/^(\w+):\s*(.+)/);
      if (kv) {
        var v = kv[2].trim();
        params[kv[1]] = v === 'true' ? true : v === 'false' ? false : !isNaN(+v) && v !== '' ? +v : v;
      }
    });
    var sig = tool + ':' + JSON.stringify(params);
    if (dispatchedSigs.has(sig)) return false;
    dispatchedSigs.add(sig);
    sendToolCall(tool, params, sourceEl);
    return true;
  }

  function parseAndSend(el) {
    if (!el || (el.dataset && el.dataset.vgProcessed)) return;
    var text = el.innerText || el.textContent || '';
    if (extractAndSend(text, el) && el.dataset) {
      el.dataset.vgProcessed = '1';
    }
  }

  function sendToolCall(tool, params, sourceEl) {
    var popup = window.__vgRelayPopup;
    if (!popup || popup.closed) {
      showToast('Relay popup closed — click the green badge to reopen', false);
      return;
    }
    var requestId = 'rq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    pendingSourceEl[requestId] = sourceEl || null;
    var payload = { type: 'vg-call', tool: tool, params: params, requestId: requestId };
    setTimeout(function () {
      try {
        popup.postMessage(payload, RELAY_ORIGIN);
      } catch (e) {
        console.warn('[vg-relay] postMessage failed:', e);
      }
    }, 200);
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
