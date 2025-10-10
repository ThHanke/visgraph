/**
 * Theme helpers for applying light/dark mode.
 *
 * Usage:
 *  - Call initTheme() early (before React renders) to apply persisted or system preference.
 *  - Use setTheme('light'|'dark'|'system') to change and persist the preference.
 */

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'visgraph-theme';
const DARK_CLASS = 'dark';

function getStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
    return null;
  } catch {
    return null;
  }
}

function prefersSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Apply the given theme to the documentElement by adding/removing the .dark class.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const isDark =
    theme === 'dark' || (theme === 'system' && prefersSystemDark());

  if (isDark) {
    root.classList.add(DARK_CLASS);
  } else {
    root.classList.remove(DARK_CLASS);
  }

  // for convenience, also set data-theme attribute
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

/**
 * Persist theme preference and apply it immediately.
 */
export function setTheme(theme: Theme) {
  {
    localStorage.setItem(STORAGE_KEY, theme);
  }
  applyTheme(theme);
}

/**
 * Initialize theme on app startup.
 * - If a persisted preference exists, apply it.
 * - Otherwise, apply system preference (light/dark).
 * - Also listen to system preference changes if user chose 'system'.
 */
export function initTheme() {
  const stored = getStoredTheme();

  const initial: Theme = stored || (prefersSystemDark() ? 'dark' : 'light');
  applyTheme(initial);

  // If user explicitly chose 'system' we should react to system changes.
  // If no stored value exists, we treat as system preference as well.
  const listenToSystem = !stored || stored === 'system';
  if (listenToSystem && typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      // only change if user didn't pick explicit light/dark
      const currentStored = getStoredTheme();
      if (currentStored && currentStored !== 'system') return;
      applyTheme(e.matches ? 'dark' : 'light');
    };
    // Older and newer browsers
    if (mql.addEventListener) {
      mql.addEventListener('change', handler as EventListener);
    } else if ((mql as any).addListener) {
      (mql as any).addListener(handler);
    }
  }
}
