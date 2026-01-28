/**
 * Test helper to initialize rdfManager worker for Node.js test environment.
 * 
 * Usage in tests:
 * ```typescript
 * import { initRdfManagerWorker } from '../utils/initRdfManagerWorker';
 * 
 * beforeEach(async () => {
 *   await initRdfManagerWorker();
 * });
 * ```
 */

import { InProcessWorker } from '../../utils/rdfManager.workerNode';
import { rdfManager } from '../../utils/rdfManager';

export async function initRdfManagerWorker(): Promise<void> {
  try {
    // Access the private worker property (which is the RdfManagerWorkerClient)
    const workerClient = (rdfManager as any).worker;
    
    if (!workerClient) {
      console.error('[initRdfManagerWorker] worker not found on rdfManager');
      return;
    }

    // Always reinitialize the worker for each test (test isolation)
    // This ensures each test gets a fresh worker instance
    const worker = new InProcessWorker();
    (workerClient as any).worker = worker;
    (workerClient as any).workerInit = Promise.resolve(worker);
    
    // Bind event handlers (using bind to preserve 'this' context)
    const handleMessage = (workerClient as any).handleMessage?.bind(workerClient);
    const handleError = (workerClient as any).handleError?.bind(workerClient);
    
    if (handleMessage) {
      worker.addEventListener('message', handleMessage);
    }
    if (handleError) {
      worker.addEventListener('error', handleError);
    }
  } catch (err) {
    console.error('[initRdfManagerWorker] Failed to initialize:', err);
    // Don't throw - allow test to continue and fail with better error message
  }
}

/**
 * Reset worker initialization state (useful for test isolation)
 */
export function resetWorkerState(): void {
  try {
    const workerClient = (rdfManager as any).worker;
    if (workerClient) {
      (workerClient as any).worker = null;
      (workerClient as any).workerInit = null;
    }
  } catch (err) {
    console.error('[resetWorkerState] Failed:', err);
  }
}
