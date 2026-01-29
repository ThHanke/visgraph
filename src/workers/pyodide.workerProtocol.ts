/**
 * @fileoverview Type definitions for Pyodide worker communication protocol
 */

// Commands sent from main thread to Pyodide worker
export type PyodideWorkerCommand =
  | PyodideWorkerInitCommand
  | PyodideWorkerExecuteCommand
  | PyodideWorkerStatusCommand;

export interface PyodideWorkerInitCommand {
  type: 'command';
  id: string;
  command: 'init';
  payload?: {
    pyodideUrl?: string;
  };
}

export interface PyodideWorkerExecuteCommand {
  type: 'command';
  id: string;
  command: 'execute';
  payload: {
    activityIri: string;
    codeUrl: string;
    requirementsUrl?: string;
    inputTurtle: string;
  };
}

export interface PyodideWorkerStatusCommand {
  type: 'command';
  id: string;
  command: 'status';
}

// Responses sent from Pyodide worker to main thread
export type PyodideWorkerMessage =
  | PyodideWorkerResponse
  | PyodideWorkerEvent;

export interface PyodideWorkerResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
  stack?: string;
}

export interface PyodideWorkerEvent {
  type: 'event';
  event: 'progress' | 'status';
  payload: any;
}

// Command name type for type-safe dispatch
export type PyodideWorkerCommandName = 'init' | 'execute' | 'status';

// Payload types mapped to command names
export interface PyodideWorkerCommandPayloads {
  init: PyodideWorkerInitCommand['payload'];
  execute: PyodideWorkerExecuteCommand['payload'];
  status: undefined;
}

// Result types for each command
export interface ExecuteResult {
  activityIri: string;
  outputTurtle: string;
  executionTime?: number;
}

export interface StatusResult {
  ready: boolean;
  pyodideVersion?: string;
  loadedPackages?: string[];
}
