/**
 * EventHandlers (stub)
 *
 *  has been removed from the project. This lightweight stub preserves the
 * EventHandlerManager API surface so any remaining imports continue to work but it
 * does not depend on .
 *
 * Methods are no-ops and exist solely to avoid requiring  in tests or other modules.
 */

import { DiagramEventHandlers } from '../../../types/canvas';

export class EventHandlerManager {
  private eventHandlers: Partial<DiagramEventHandlers> = {};

  constructor(handlers: Partial<DiagramEventHandlers> = {}) {
    this.eventHandlers = handlers || {};
  }

  public setupEventHandlers(diagram: any): void {
    // no-op: previously wired  diagram events; now React Flow handles events.
  }

  public updateEventHandlers(newHandlers: Partial<DiagramEventHandlers>): void {
    this.eventHandlers = { ...this.eventHandlers, ...newHandlers };
  }

  public teardown(): void {
    // no-op
  }
}

export default EventHandlerManager;
