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

export function createPyodideWorkerRuntime(
  postMessage: (message: unknown) => void
): PyodideWorkerRuntime {
  let pyodide: any = null;
  let initializationPromise: Promise<any> | null = null;
  const loadedPackages = new Set<string>();

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
        
        // Set HOME environment variable
        pyodide.runPython(`
import os
os.environ['HOME'] = '/home/pyodide'
os.chdir('/tmp')
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
    const { id, command, payload } = message;

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
