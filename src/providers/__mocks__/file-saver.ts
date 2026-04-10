// Mock for file-saver (CJS module) used in tests to avoid interop issues.
export const saveAs = (_blob: unknown, _filename?: string): void => {
  // no-op in test environment
};
export default { saveAs };
