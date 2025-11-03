/*
  ESM shim that re-exports React's common APIs as named ESM exports.

  Import React's CJS development build directly and re-export its APIs as
  explicit ESM named exports so Rollup can statically resolve them for
  downstream packages that import named symbols from 'react'.
*/
import ReactCjs from 'react/cjs/react.development.js';

const React = ReactCjs && ReactCjs.default ? ReactCjs.default : ReactCjs;

export default React;

export const Children = React.Children;
export const Fragment = React.Fragment;
export const Component = React.Component;
export const PureComponent = React.PureComponent;
export const createElement = React.createElement;
export const cloneElement = React.cloneElement;
export const isValidElement = React.isValidElement;
export const createContext = React.createContext;
export const useContext = React.useContext;
export const useState = React.useState;
export const useEffect = React.useEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useCallback = React.useCallback;
export const forwardRef = React.forwardRef;
export const memo = React.memo;
export const useImperativeHandle = React.useImperativeHandle;
export const useReducer = React.useReducer;
export const useDebugValue = React.useDebugValue;
export const Profiler = React.Profiler;
export const StrictMode = React.StrictMode;
