declare const fallback: any;

declare global {
  interface Window {
    fallback?: any;
    __VG_DEBUG__?: boolean;
    __VG_DEBUG_SUMMARY__?: any;
    __VG_DEBUG_STACKS__?: boolean;
  }

  // Expose debug helpers on globalThis for legacy callsites that don't import startupDebug.
  // These are set at runtime by src/utils/startupDebug.ts but declared here for TypeScript.
  var debug: any;
  var warn: any;
  var error: any;
  var info: any;
}

export {};
