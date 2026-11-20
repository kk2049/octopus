import "./text-view.css";

export {
  CodeMirrorTextSurface,
  type CodeMirrorTextSurfaceHandle,
  type CodeMirrorTextSurfaceProps,
} from "./components/CodeMirrorTextSurface.js";
export {
  languageForFileName,
  languageKeyForFileName,
  type TextLanguage,
} from "./languages.js";
export {
  DocumentPane,
  displayTextSize,
  type DocumentPaneProps,
  type DocumentPaneVariant,
  type DocumentReadStatus,
  type TextDocumentMetadata,
} from "./components/DocumentPane.js";
