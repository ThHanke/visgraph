import {
  assertArray,
  assertBoolean,
  assertNumber,
  assertPlainObject,
  assertString,
  invariant,
} from "./guards";

interface NormalizeStringOptions {
  allowEmpty?: boolean;
  trim?: boolean;
}

interface NormalizeNumberOptions {
  min?: number;
  max?: number;
}

export function normalizeBoolean(value: unknown, context: string): boolean {
  assertBoolean(value, `${context} must be a boolean`);
  return value;
}

export function normalizeString(
  value: unknown,
  context: string,
  options: NormalizeStringOptions = {},
): string {
  assertString(value, `${context} must be a string`);
  const trimmed = options.trim === false ? value : value.trim();
  if (!options.allowEmpty) {
    invariant(trimmed.length > 0, `${context} must not be empty`);
  }
  return trimmed;
}

export function normalizeOptionalString(
  value: unknown,
  context: string,
  options: NormalizeStringOptions = {},
): string | undefined {
  if (typeof value === "undefined" || value === null) return undefined;
  return normalizeString(value, context, options);
}

export function normalizeNumber(
  value: unknown,
  context: string,
  options: NormalizeNumberOptions = {},
): number {
  assertNumber(value, `${context} must be a finite number`);
  let result = value;
  if (typeof options.min === "number") {
    result = Math.max(options.min, result);
  }
  if (typeof options.max === "number") {
    result = Math.min(options.max, result);
  }
  return result;
}

export function normalizeStringArray(value: unknown, context: string): string[] {
  assertArray(value, `${context} must be an array`);
  const output: string[] = [];
  for (const entry of value as unknown[]) {
    output.push(normalizeString(entry, `${context} entry`, { allowEmpty: false }));
  }
  return output;
}

export function normalizeStringSet(value: unknown, context: string): string[] {
  return [...new Set(normalizeStringArray(value, context))];
}

export function normalizeStringRecord(
  value: unknown,
  context: string,
): Record<string, string> {
  assertPlainObject(value, `${context} must be a plain object`);
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeString(key, `${context} key`);
    const normalizedValue = normalizeString(raw, `${context}.${normalizedKey}`, {
      allowEmpty: false,
    });
    record[normalizedKey] = normalizedValue;
  }
  return record;
}

export function normalizeBooleanFlag(value: unknown, context: string, fallback = false): boolean {
  if (typeof value === "undefined" || value === null) return fallback;
  return normalizeBoolean(value, context);
}
