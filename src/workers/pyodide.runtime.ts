/**
 * @fileoverview Pyodide worker runtime implementation
 * Handles initialization, package loading, and Python code execution
 */

import type {
  PyodideWorkerCommand,
  PyodideWorkerCommandName,
  ExecuteResult,
  StatusResult,
} from './pyodide.workerProtocol';

export interface PyodideWorkerRuntime {
  handleEvent: (message: unknown) => void;
  terminate: () => void;
}

const SHARED_LIBRARIES = ['spw_input.py'];

export function createPyodideWorkerRuntime(
  postMessage: (message: unknown) => void
): PyodideWorkerRuntime {
  let pyodide: any = null;
  let initializationPromise: Promise<any> | null = null;
  const loadedPackages = new Set<string>();
  const loadedLibraries = new Set<string>();

  // SharedArrayBuffer for blocking input requests
  let signalBuffer: SharedArrayBuffer | null = null;
  let textBuffer: SharedArrayBuffer | null = null;
  let signalView: Int32Array | null = null;
  let textView: Uint8Array | null = null;
  const INPUT_TIMEOUT_MS = 300_000;
  const TEXT_BUFFER_SIZE = 8192;

  function post(message: any) {
    try {
      postMessage(message);
    } catch (err) {
      console.error('[pyodide.runtime] postMessage failed', err);
    }
  }

  function respondOk(id: string, result: any) {
    post({
      type: 'response',
      id,
      ok: true,
      result,
    });
  }

  function respondError(id: string, error: Error | string) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    post({
      type: 'response',
      id,
      ok: false,
      error: message,
      stack,
    });
  }

  function emitProgress(stage: string, percent: number) {
    post({
      type: 'event',
      event: 'progress',
      payload: { stage, percent },
    });
  }

  function emitStdout(text: string) {
    post({ type: 'event', event: 'stdout', payload: { text, timestamp: Date.now() } });
  }

  function emitStderr(text: string) {
    post({ type: 'event', event: 'stderr', payload: { text, timestamp: Date.now() } });
  }

  function setupStdioCapture() {
    if (!pyodide) return;
    try {
      pyodide.globals.set('__vg_emit', (channel: string, text: string) => {
        if (channel === 'stdout') emitStdout(text);
        else if (channel === 'stderr') emitStderr(text);
      });

      pyodide.runPython(`
import sys

class _VGWriter:
    def __init__(self, channel, original):
        self._channel = channel
        self._original = original
    def write(self, text):
        if text and text != '\\n':
            __vg_emit(self._channel, text)
        if self._original:
            self._original.write(text)
    def flush(self):
        if self._original:
            self._original.flush()

sys.stdout = _VGWriter('stdout', sys.stdout)
sys.stderr = _VGWriter('stderr', sys.stderr)
`);
    } catch (err) {
      console.warn('[pyodide.runtime] Failed to set up stdio capture, continuing without it', err);
    }
  }

  function setupInputBlocking() {
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('[pyodide.runtime] SharedArrayBuffer not available — request_input disabled');
      if (pyodide) {
        pyodide.runPython(`
import builtins as _builtins
def request_input(prompt, input_type='text', options=None, default_value=None):
    raise RuntimeError('request_input() requires SharedArrayBuffer (COOP/COEP headers). Not available in this environment.')
_builtins.request_input = request_input
`);
      }
      return;
    }

    signalBuffer = new SharedArrayBuffer(8);
    textBuffer = new SharedArrayBuffer(TEXT_BUFFER_SIZE);
    signalView = new Int32Array(signalBuffer);
    textView = new Uint8Array(textBuffer);

    post({
      type: 'event',
      event: 'init_buffers',
      payload: { signalBuffer, textBuffer },
    });

    if (!pyodide) return;

    let requestCounter = 0;
    pyodide.globals.set('__vg_request_input', (
      prompt: string,
      inputType: string,
      optionsJson: string,
      defaultValue: string,
    ) => {
      if (!signalView || !textView) throw new Error('Input buffers not initialized');

      const requestId = `input-${++requestCounter}`;
      Atomics.store(signalView, 0, 0); // waiting
      Atomics.store(signalView, 1, 0);

      const options = optionsJson ? JSON.parse(optionsJson) : undefined;
      post({
        type: 'event',
        event: 'input_request',
        payload: { requestId, prompt, inputType: inputType || 'text', options, defaultValue: defaultValue || undefined },
      });

      const waitResult = Atomics.wait(signalView, 0, 0, INPUT_TIMEOUT_MS);
      const state = Atomics.load(signalView, 0);

      if (waitResult === 'timed-out' || state === 0) {
        throw new Error(`request_input() timed out after ${INPUT_TIMEOUT_MS / 1000}s waiting for user response`);
      }
      if (state === -1) {
        throw new Error('request_input() was cancelled by the user');
      }

      const byteLength = Atomics.load(signalView, 1);
      if (byteLength === 0) return '';
      const decoder = new TextDecoder();
      return decoder.decode(textView.slice(0, byteLength));
    });

    pyodide.runPython(`
import json as _json
import builtins as _builtins

def request_input(prompt, input_type='text', options=None, default_value=None):
    options_json = _json.dumps(options) if options else ''
    return __vg_request_input(prompt, input_type or 'text', options_json, default_value or '')

_builtins.request_input = request_input
`);
  }

  async function ensurePyodide(pyodideUrl?: string): Promise<any> {
    if (pyodide) return pyodide;
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      try {
        emitProgress('Loading Pyodide runtime', 10);
        
        // Load Pyodide from CDN (default to 0.26.2)
        const baseUrl = pyodideUrl || 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
        const url = baseUrl.endsWith('/') ? `${baseUrl}pyodide.mjs` : `${baseUrl}/pyodide.mjs`;
        
        emitProgress('Importing Pyodide module', 20);
        
        // Dynamic import for ES module workers
        const pyodideModule = await import(/* @vite-ignore */ url);
        
        emitProgress('Initializing Pyodide', 40);
        
        // Initialize Pyodide runtime using the imported loadPyodide function
        if (typeof pyodideModule.loadPyodide !== 'function') {
          throw new Error('Pyodide loader not available in imported module');
        }
        
        pyodide = await pyodideModule.loadPyodide({
          indexURL: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
        });
        
        emitProgress('Pyodide ready', 100);

        setupStdioCapture();
        setupInputBlocking();

        console.log('[pyodide.runtime] Initialized Pyodide', pyodide.version);
        return pyodide;
      } catch (err) {
        initializationPromise = null;
        console.error('[pyodide.runtime] Failed to initialize Pyodide', err);
        throw err;
      }
    })();

    return initializationPromise;
  }

  async function fetchText(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    } catch (err) {
      throw new Error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function installRequirements(requirementsText: string): Promise<void> {
    if (!pyodide) {
      throw new Error('Pyodide not initialized');
    }

    const lines = requirementsText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    if (lines.length === 0) {
      return;
    }

    emitProgress('Installing Python packages', 40);
    
    try {
      // First, ensure micropip is loaded (it's a built-in Pyodide package)
      await pyodide.loadPackage('micropip');
      const micropip = pyodide.pyimport('micropip');
      
      // Install each package using micropip, which can fetch from PyPI
      for (const line of lines) {
        // Keep the full line with version specifiers for micropip
        const packageSpec = line.trim();
        
        if (loadedPackages.has(packageSpec)) {
          console.log('[pyodide.runtime] Package already loaded:', packageSpec);
          continue;
        }
        
        console.log('[pyodide.runtime] Installing package:', packageSpec);
        
        try {
          // micropip.install can handle version specifiers and will fetch from PyPI
          await micropip.install(packageSpec);
          loadedPackages.add(packageSpec);
          console.log('[pyodide.runtime] Successfully installed:', packageSpec);
        } catch (pkgErr) {
          console.warn('[pyodide.runtime] Failed to install package:', packageSpec, pkgErr);
          // Continue with other packages even if one fails
          throw new Error(`Failed to install ${packageSpec}: ${pkgErr instanceof Error ? pkgErr.message : String(pkgErr)}`);
        }
      }
      
      console.log('[pyodide.runtime] All packages installed successfully');
    } catch (err) {
      throw new Error(`Package installation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleInit(id: string, payload?: { pyodideUrl?: string }) {
    try {
      await ensurePyodide(payload?.pyodideUrl);
      respondOk(id, { ready: true, version: pyodide.version });
    } catch (err) {
      respondError(id, err as Error);
    }
  }

  async function handleExecute(
    id: string,
    payload: {
      activityIri: string;
      codeUrl: string;
      requirementsUrl?: string;
      inputTurtle: string;
    }
  ) {
    const startTime = Date.now();

    try {
      // Ensure Pyodide is initialized
      await ensurePyodide();

      emitProgress('Fetching Python code', 20);

      // Fetch Python code
      const codeText = await fetchText(payload.codeUrl);

      // Fetch and install requirements if provided
      if (payload.requirementsUrl) {
        emitProgress('Fetching requirements', 30);
        const requirementsText = await fetchText(payload.requirementsUrl);
        await installRequirements(requirementsText);
      }

      // Load shared Python libraries from the same base URL as the script
      const baseUrl = payload.codeUrl.substring(0, payload.codeUrl.lastIndexOf('/'));
      for (const libName of SHARED_LIBRARIES) {
        if (loadedLibraries.has(libName)) continue;
        try {
          emitProgress('Loading shared libraries', 50);
          const libText = await fetchText(`${baseUrl}/${libName}`);
          pyodide.FS.writeFile(`/tmp/${libName}`, libText);
          loadedLibraries.add(libName);
          console.log(`[pyodide.runtime] Loaded shared library: ${libName}`);
        } catch (err) {
          console.warn(`[pyodide.runtime] Shared library ${libName} not available, skipping`, err);
        }
      }

      emitProgress('Executing Python code', 60);

      // Set up a virtual filesystem for the Python code to use
      // This allows file I/O operations within the Pyodide environment
      try {
        // Ensure /home directory exists (Pyodide's default home)
        try {
          pyodide.FS.mkdirTree('/home/pyodide');
        } catch (e) {
          // Directory might already exist, ignore
        }
        
        // Create /tmp directory
        try {
          pyodide.FS.mkdirTree('/tmp');
        } catch (e) {
          // Directory might already exist, ignore
        }
        
        pyodide.runPython(`
import os, sys
os.environ['HOME'] = '/home/pyodide'
os.chdir('/tmp')
if '/tmp' not in sys.path:
    sys.path.insert(0, '/tmp')
`);
        
        console.log('[pyodide.runtime] Virtual filesystem set up successfully');
      } catch (fsErr) {
        console.error('[pyodide.runtime] Failed to set up filesystem:', fsErr);
        // Don't throw - try to continue
      }

      // Write input data to a file in the virtual filesystem
      // This allows Python code to read it if needed
      try {
        pyodide.FS.writeFile('/tmp/input.ttl', payload.inputTurtle);
        console.log('[pyodide.runtime] Input turtle written to /tmp/input.ttl');
      } catch (writeErr) {
        console.warn('[pyodide.runtime] Failed to write input file:', writeErr);
      }

      // Execute Python code in a try-catch to provide better error messages
      try {
        pyodide.runPython(codeText);
      } catch (execErr) {
        // Extract more detailed error information
        const errorMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const errorStr = String(errorMsg);
        
        // Try to extract the actual Python error
        let pythonError = errorStr;
        if (errorStr.includes('Traceback')) {
          pythonError = errorStr;
        }
        
        throw new Error(`Failed to execute Python code:\n${pythonError}\n\nThis error occurred during module loading. The Python code may be trying to access files or perform I/O operations at the module level (outside of functions).`);
      }

      // Get the run function from Python globals
      const runFunc = pyodide.globals.get('run');
      if (!runFunc || typeof runFunc !== 'function') {
        throw new Error('Python code must define a run(input_turtle: str, activity_iri: str) -> str function');
      }

      // Execute the run function with error handling
      let outputTurtle: string;
      try {
        outputTurtle = runFunc(payload.inputTurtle, payload.activityIri);
      } catch (runErr) {
        throw new Error(`Python run() function failed: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
      }

      if (typeof outputTurtle !== 'string') {
        throw new Error('Python run() function must return a string (Turtle format)');
      }

      emitProgress('Execution complete', 100);

      const executionTime = Date.now() - startTime;

      const result: ExecuteResult = {
        activityIri: payload.activityIri,
        outputTurtle,
        executionTime,
      };

      respondOk(id, result);
    } catch (err) {
      console.error('[pyodide.runtime] Execution failed', err);
      respondError(id, err as Error);
    }
  }

  async function handleStatus(id: string) {
    try {
      const result: StatusResult = {
        ready: pyodide !== null,
        pyodideVersion: pyodide ? pyodide.version : undefined,
        loadedPackages: Array.from(loadedPackages),
      };
      respondOk(id, result);
    } catch (err) {
      respondError(id, err as Error);
    }
  }

  async function handleCommand(message: PyodideWorkerCommand) {
    const { id, command } = message;
    const payload = 'payload' in message ? (message as any).payload : undefined;

    try {
      switch (command) {
        case 'init':
          await handleInit(id, payload as any);
          break;

        case 'execute':
          await handleExecute(id, payload as any);
          break;

        case 'status':
          await handleStatus(id);
          break;

        default:
          respondError(id, `Unknown command: ${command}`);
      }
    } catch (err) {
      console.error('[pyodide.runtime] Command handler failed', err);
      respondError(id, err as Error);
    }
  }

  return {
    handleEvent(message: unknown) {
      try {
        if (!message || typeof message !== 'object') {
          console.warn('[pyodide.runtime] Invalid message', message);
          return;
        }

        const msg = message as any;

        if (msg.type === 'command') {
          void handleCommand(msg as PyodideWorkerCommand);
        } else {
          console.warn('[pyodide.runtime] Unknown message type', msg.type);
        }
      } catch (err) {
        console.error('[pyodide.runtime] handleEvent failed', err);
      }
    },

    terminate() {
      // Clean up if needed
      pyodide = null;
      initializationPromise = null;
      loadedPackages.clear();
    },
  };
}
