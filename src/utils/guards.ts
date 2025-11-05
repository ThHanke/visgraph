/**
 * Runtime guard utilities used to enforce deterministic codepaths.
 * These helpers deliberately avoid implicit coercions so that validation
 * failures surface immediately with actionable errors.
 */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function invariant(condition: unknown, message: string, context?: PlainObject): asserts condition {
  if (condition) return;
  const error = new Error(message);
  if (context && isPlainObject(context) && Object.keys(context).length > 0) {
    (error as any).context = context;
  }
  throw error;
}

export function assertPlainObject(value: unknown, message: string): asserts value is PlainObject {
  invariant(isPlainObject(value), message, { received: value });
}

export function assertString(value: unknown, message: string): asserts value is string {
  invariant(typeof value === "string", message, { received: value });
}

export function assertNumber(value: unknown, message: string): asserts value is number {
  invariant(typeof value === "number" && Number.isFinite(value), message, { received: value });
}

export function assertArray(value: unknown, message: string): asserts value is unknown[] {
  invariant(Array.isArray(value), message, { received: value });
}

export function assertBoolean(value: unknown, message: string): asserts value is boolean {
  invariant(typeof value === "boolean", message, { received: value });
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== "string" || typeof val !== "string") return false;
  }
  return true;
}
