/**
 * Sidebar helper constants extracted from sidebar.tsx
 * Keeping these as pure exports so they can be imported where needed
 * without exporting React components from the same module (avoids react-refresh warnings).
 */

export const SIDEBAR_COOKIE_NAME = "sidebar:state";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 1 week

export const SIDEBAR_WIDTH = "16rem";
export const SIDEBAR_WIDTH_MOBILE = "18rem";
export const SIDEBAR_WIDTH_ICON = "3rem";

export const SIDEBAR_KEYBOARD_SHORTCUT = "b";
