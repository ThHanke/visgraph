/*
  ESM wrapper around React's runtime export.

  Import the public 'react/jsx-runtime' entry as a namespace and re-export
  the named members so Rollup can see explicit ESM named exports during bundling.
*/
import * as runtime from 'react/jsx-runtime';

export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const Fragment = runtime.Fragment;
export default runtime;
