/**
 * startupDebug.ts (enhanced)
 *
 * Structured runtime logger for startup and debugging.
 * - JSON-friendly logs stored in window.__VG_DEBUG_SUMMARY__
 * - log(level, event, meta)
 * - debug/event helpers: debug, info, warn, error
 * - timedAsync(event, meta, asyncFn) to measure async durations
 * - captureCaller() to get a short callsite (file:line) when needed
 * - fallback(event, meta, options) to record gated fallback events (non-noisy by default)
 *
 * Gate: by default console output occurs only when window.__VG_DEBUG__ is truthy.
 * Full stacks are NOT captured by default; can be enabled when anomalies are detected
 * via window.__VG_DEBUG_STACKS__ or options.captureStack.
 */

type Meta = Record<string, any> | undefined;

declare global {
  interface Window {
    __VG_DEBUG__?: boolean;
    __VG_DEBUG_SUMMARY__?: any;
    __VG_DEBUG_STACKS__?: boolean;
  }
}

function nowIso() { return new Date().toISOString(); }

function ensureSummary() {
  if (typeof window === 'undefined') {
    return { startedAt: nowIso(), logs: [], milestones: [], counters: {}, fallbacks: [], anomalies: [] };
  }
  if (!window.__VG_DEBUG_SUMMARY__) {
    window.__VG_DEBUG_SUMMARY__ = { startedAt: nowIso(), logs: [], milestones: [], counters: {}, anomalies: [], fallbacks: [] };
  } else if (!window.__VG_DEBUG_SUMMARY__.fallbacks) {
    try { window.__VG_DEBUG_SUMMARY__.fallbacks = []; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
  }
  return window.__VG_DEBUG_SUMMARY__;
}
 
/**
 * Recent events buffer used for lightweight duplicate detection/anomaly reporting.
 * Each entry: { fingerprint: string, ts: number, caller?: string }
 *
 * We keep a small sliding window and detect when the same (event+key) fingerprint
 * occurs >= DUPLICATE_THRESHOLD within DUPLICATE_WINDOW_MS. When that happens we
 * record an anomaly entry in summary.anomalies (timestamps, callers) and, when
 * requested via VG_DEBUG_STACKS or when the threshold is exceeded, we attach a
 * full stack to help diagnostics.
 */
const recentEvents: any[] = [];

// Duplicate-detection defaults (configurable by code edits / later exposure)
const DUPLICATE_THRESHOLD = 2;
const DUPLICATE_WINDOW_MS = 2000;

function makeFingerprint(eventName: string, meta?: Meta) {
  try {
    // Prefer explicit keys commonly present in logs (id/key/uri/name/nodes).
    const key =
      meta && (
        (meta as any).key ||
        (meta as any).id ||
        (meta as any).uri ||
        (meta as any).name ||
        (typeof meta === 'object' && (meta as any).nodes ? `nodes:${(meta as any).nodes}` : undefined)
      );
    if (key) return `${eventName}|${String(key)}`;
    // Fallback: include a short meta-signature to reduce collisions for keyless events
    if (meta && typeof meta === 'object') {
      try {
        const keys = Object.keys(meta).slice(0, 3).join(',');
        return `${eventName}|meta:${keys}`;
      } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    }
    return `${eventName}|`;
  } catch (_) {
    return `${eventName}|`;
  }
}

function recordRecentEvent(fp: string, caller?: string) {
  const now = Date.now();
  recentEvents.push({ fingerprint: fp, ts: now, caller });
  // purge old entries beyond the window (from head)
  while (recentEvents.length > 0 && (now - recentEvents[0].ts) > DUPLICATE_WINDOW_MS) {
    recentEvents.shift();
  }
  // return occurrences for this fingerprint within window
  return recentEvents.filter(e => e.fingerprint === fp);
}

function captureFullStack() {
  try {
    const e = new Error();
    return e.stack || undefined;
  } catch (_) {
    return undefined;
  }
}
 
function safeConsole(level: 'debug'|'info'|'warn'|'error', ...args: any[]) {
  try {
    if (typeof console === 'undefined') return;
    if (level === 'debug') {
      console.debug(...args);
    } else if (level === 'info') {
      console.info(...args);
    } else if (level === 'warn') {
      console.warn(...args);
    } else {
      console.error(...args);
    }
  } catch (_) {
    // Swallow console errors to avoid recursive logging
  }
}

function shortCaller(stackLimit = 5): string | null {
  try {
    const err = new Error();
    if (!err.stack) return null;
    const lines = err.stack.split('\n').slice(3, 3 + stackLimit); // skip first frames inside logger
    for (const ln of lines) {
      const m = ln.match(/\s+at\s+(?:.+\s\()?(.+):(\d+):\d+\)?/);
      if (m && m[1]) {
        // return file:line
        return `${m[1].split('/').slice(-2).join('/')}:${m[2]}`;
      }
    }
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
  return null;
}

export function incr(counterName: string, n: number = 1) {
  const s = ensureSummary();
  try {
    s.counters[counterName] = (s.counters[counterName] || 0) + n;
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
}

export function milestone(name: string, meta?: Meta) {
  const s = ensureSummary();
  const m = { name, ts: nowIso(), meta: meta || {} };
  try { s.milestones.push(m); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
  if (typeof window !== 'undefined' && window.__VG_DEBUG__) {
    safeConsole('info', '[VG_MILESTONE]', name, meta || {}, m.ts);
  }
}

export function log(level: 'debug'|'info'|'warn'|'error', eventName: string, meta?: Meta, options?: { caller?: boolean }) {
  const s = ensureSummary();
  const entry: any = { ts: nowIso(), level, event: eventName, meta: meta || {} };
  if (options && options.caller) {
    try { entry.caller = shortCaller(); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
  }
  try {
    s.logs.push(entry);
    if (Array.isArray(s.logs) && s.logs.length > 10000) s.logs.shift();
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

  // Console output only when debug flag set
  const shouldConsole = typeof window === 'undefined' ? true : Boolean(window.__VG_DEBUG__);
  if (shouldConsole) {
    safeConsole(level, '[VG_LOG]', entry.event, entry.meta, entry.caller || entry.ts);
  }
}

// convenience helpers
export function debug(event: string, meta?: Meta, options?: { caller?: boolean }) { log('debug', event, meta, options); }
export function info(event: string, meta?: Meta, options?: { caller?: boolean }) { log('info', event, meta, options); }
export function warn(event: string, meta?: Meta, options?: { caller?: boolean }) { log('warn', event, meta, options); }
export function error(event: string, meta?: Meta, options?: { caller?: boolean }) { log('error', event, meta, options); }

/**
 * timedAsync - run an async function, record start/end and duration in logs
 * returns the wrapped function result.
 */
export async function timedAsync<T>(eventName: string, meta: Meta | undefined, fn: () => Promise<T>, options?: { caller?: boolean }) {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const start = Date.now();
  debug(`${eventName}.start`, { id, ...(meta || {}) }, { caller: options?.caller });
  try {
    const res = await fn();
    const dur = Date.now() - start;
    debug(`${eventName}.end`, { id, durationMs: dur, ...(meta || {}) }, { caller: options?.caller });
    return res;
  } catch (err) {
    const dur = Date.now() - start;
    error(`${eventName}.error`, { id, durationMs: dur, error: (err && err.message) ? err.message : String(err), ...(meta || {}) }, { caller: options?.caller });
    throw err;
  }
}

/**
 * fallback - structured, gated recording for fallback/error-handling paths that are currently
 * non-fatal or use best-effort fallbacks.
 *
 * By default this does not spam console output. It always records a structured entry into
 * window.__VG_DEBUG_SUMMARY__.fallbacks so the playwright startup debug runner can capture them.
 *
 * Options:
 *  - level: 'warn'|'error'|'info' (default 'warn')
 *  - captureStack: boolean - capture a full stack trace for this entry (default false)
 *  - caller: boolean - include a short caller file:line (default true)
 */
export function fallback(eventName: string, meta?: Meta, options?: { level?: 'warn'|'error'|'info', captureStack?: boolean, caller?: boolean }) {
  try {
    const s = ensureSummary();
    const level = options?.level || 'warn';
    const caller = options?.caller !== undefined ? options.caller : true;
    const entry: any = { ts: nowIso(), event: eventName, meta: meta || {}, level };

    if (caller) {
      try { entry.caller = shortCaller(); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    }

    // duplicate detection & anomaly recording
    try {
      const fp = makeFingerprint(eventName, meta);
      const occ = recordRecentEvent(fp, entry.caller);
      if (occ.length >= DUPLICATE_THRESHOLD) {
        try {
          (s.anomalies = s.anomalies || []).push({ event: eventName, fingerprint: fp, occurrences: occ.slice(), ts: nowIso() });
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      }
    } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

    // capture full stack only when requested or globally enabled
    if (options?.captureStack || (typeof window !== 'undefined' && window.__VG_DEBUG_STACKS__)) {
      try {
        entry.stack = captureFullStack();
      } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    }

    try {
      s.fallbacks.push(entry);
      if (Array.isArray(s.fallbacks) && s.fallbacks.length > 20000) s.fallbacks.shift();
    } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

    // Console output only when debug flag set
    const shouldConsole = typeof window === 'undefined' ? true : Boolean(window.__VG_DEBUG__);
    if (shouldConsole) {
      safeConsole(entry.level === 'error' ? 'error' : (entry.level === 'info' ? 'info' : 'warn'), '[VG_FALLBACK]', entry.event, entry.meta, entry.caller || entry.ts, entry.stack ? '\nStack:' : '', entry.stack || '');
    }
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
}

/**
 * Alias for older debugLog name used by earlier instrumentation.
 * Keep for compatibility: export debugLog so existing imports don't break.
 */
export const debugLog = debug;

/**
 * getSummary - returns a deep copy of the current summary for external tooling
 */
export function getSummary() {
  try {
    const s = ensureSummary();
    return JSON.parse(JSON.stringify(s));
  } catch (_) {
    return null;
  }
}

/**
 * Auto-gate enablement:
 * - If the page is loaded with ?vg_debug=1 or ?vg_debug=true in the query string,
 *   enable window.__VG_DEBUG__ so console output and fallback stacks (if requested)
 *   will appear for diagnostic runs.
 * - When running in a local dev environment (import.meta.env.DEV === true) we also
 *   enable the debug gate by default so `npm run dev` shows diagnostic output.
 * - Developers can enable full stacks via VITE_VG_DEBUG_STACKS=true in the Vite env.
 *
 * This keeps production quiet while making local dev and playwright-run debugging easy.
 */
try {
  // 1) Query param explicit opt-in (highest precedence)
  try {
    if (typeof window !== 'undefined' && typeof window.location !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('vg_debug');
      if (v === '1' || v === 'true') {
        try { window.__VG_DEBUG__ = true; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      }
    }
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

  // 2) Optional explicit enablement in Vite via env flag:
  //    Only enable debug automatically when VITE_VG_DEBUG=true is set in the Vite env.
  //    This avoids spamming console output for ordinary local dev runs while still
  //    allowing diagnostic runs when requested.
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_VG_DEBUG === 'true') {
      try { window.__VG_DEBUG__ = true; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } }
    }
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } }

  // 3) Optional: enable full stacks when VITE_VG_DEBUG_STACKS=true is set in Vite env
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_VG_DEBUG_STACKS === 'true') {
      try { window.__VG_DEBUG_STACKS__ = true; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    }
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
} catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

// Expose small debug API on globalThis so repo-wide wrappers can call debug/fallback without importing
try {
  if (typeof globalThis !== 'undefined') {
    try { (globalThis as any).debug = debug; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    try { (globalThis as any).fallback = fallback; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    try { (globalThis as any).warn = warn; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    try { (globalThis as any).error = error; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    try { (globalThis as any).info = info; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
  }
} catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
