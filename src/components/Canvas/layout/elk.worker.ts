/**
 * ELK Web Worker entry point.
 *
 * elk-worker.min.js detects the Web Worker context automatically
 * (typeof document === 'undefined' && typeof self !== 'undefined') and
 * registers itself on `self.onmessage`. Nothing else is needed here.
 */
import 'elkjs/lib/elk-worker.min.js';
