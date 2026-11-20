/** Browser ABI shared by independently published Apps and the Dashboard build. */
export const APP_RUNTIME_ABI = "octopus-ui/v1";
export const APP_MODULE_SCHEMA = "octopus-app-module/v1";
export const APP_RUNTIME_IMPORTS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@claude-bot/agent-view-react",
  "@claude-bot/agent-view-react/runtime",
  "@claude-bot/agent-view-react/ui",
  "@claude-bot/agent-view-react/shell",
  "@claude-bot/agent-view-react/workspace",
  "@ant-design/cssinjs",
  "antd/es/alert",
  "antd/es/app",
  "antd/es/button",
  "antd/es/card/Card",
  "antd/es/checkbox",
  "antd/es/config-provider",
  "antd/es/descriptions",
  "antd/es/drawer",
  "antd/es/empty",
  "antd/es/form",
  "antd/es/input/Input",
  "antd/es/input/Password",
  "antd/es/input/TextArea",
  "antd/es/locale/en_US",
  "antd/es/locale/ja_JP",
  "antd/es/locale/zh_CN",
  "antd/es/locale/zh_TW",
  "antd/es/modal",
  "antd/es/pagination",
  "antd/es/radio",
  "antd/es/select",
  "antd/es/skeleton",
  "antd/es/table",
  "antd/es/tabs",
  "antd/es/tag",
  "antd/es/theme",
  "antd/es/tooltip"
] as const;
// React publishes CommonJS. `export *` cannot make its runtime properties
// discoverable as ESM exports, even though Dashboard's own bundled imports work.
// These public exports form the explicit shared ABI for independent App modules.
const COMMONJS_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  react: [
    "Activity", "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense",
    "act", "cache", "cacheSignal", "cloneElement", "createContext", "createElement", "createRef",
    "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "unstable_useCacheRefresh", "use",
    "useActionState", "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect",
    "useEffectEvent", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo",
    "useOptimistic", "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition", "version",
  ],
  "react/jsx-runtime": ["Fragment", "jsx", "jsxs"],
  "react/jsx-dev-runtime": ["Fragment", "jsxDEV"],
  "react-dom": ["createPortal", "flushSync", "preconnect", "prefetchDNS", "preinit", "preinitModule", "preload",
    "preloadModule", "requestFormReset", "unstable_batchedUpdates", "useFormState", "useFormStatus", "version"],
  "react-dom/client": ["createRoot", "hydrateRoot", "version"],
};
export function runtimeEntrySource(specifier: string): string {
  const quoted = JSON.stringify(specifier);
  const names = COMMONJS_EXPORTS[specifier];
  if (names) return `import runtime from ${quoted};export default runtime;`
    + names.map((name) => `export const ${name}=runtime.${name};`).join("");
  return `export * from ${quoted};${specifier.startsWith("antd/") ? `export { default } from ${quoted};` : ""}`;
}
export function runtimeEntryName(index: number): string { return `runtime-${index}`; }
export interface AppModuleEntry {
  schema: typeof APP_MODULE_SCHEMA;
  runtime: typeof APP_RUNTIME_ABI;
  appId: string;
  scope: string;
  entry: string;
  styles: string[];
  assets: string[];
}
