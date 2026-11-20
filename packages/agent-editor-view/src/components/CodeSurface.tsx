/**
 * Compatibility wrapper around the platform's sole CodeMirror integration.
 *
 * The editor module still exports `CodeSurface` under its original name, but it
 * owns no editor-library code. Viewer and editor now receive identical search,
 * wrapping, CSP nonce and accessibility behaviour from `agent-text-view`.
 */

import { forwardRef } from "react";
import {
  CodeMirrorTextSurface,
  type CodeMirrorTextSurfaceHandle,
  type CodeMirrorTextSurfaceProps,
} from "@claude-bot/agent-text-view";

export interface CodeSurfaceProps
  extends Omit<CodeMirrorTextSurfaceProps, "className" | "idBase" | "ariaLabel" | "initialWrap" | "onTextChange"> {
  /**
   * Legacy controlled-buffer callback. New module code omits it and receives
   * only dirty transitions; an older consumer can keep its original contract
   * at the explicit cost of materialising the buffer per user transaction.
   */
  onChange?(text: string): void;
}

export const CodeSurface = forwardRef<CodeMirrorTextSurfaceHandle, CodeSurfaceProps>(function CodeSurface(
  props,
  ref,
) {
  return (
    <CodeMirrorTextSurface
      ref={ref}
      {...props}
      onTextChange={props.onChange}
      className="wsedit-surface"
      idBase="wseditSurface"
      ariaLabel={props.docKey ? "文件编辑器" : "文本编辑器"}
      initialWrap
    />
  );
});
