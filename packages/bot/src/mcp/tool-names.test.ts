import { expect, it } from "vitest";
import {
  APP_DISPATCH_TOOL, APP_TOOLS, CRDT_LIST_TOOL, CRDT_TOOLS, DISCUSSION_TOOLS, EXECUTION_TOOLS, FEISHU_DOC_SHARE_TOOLS, FEISHU_DOC_TOOLS, FEISHU_SHARED_DOC_TOOLS, FEISHU_TOOLS, KNOWLEDGE_TOOLS,
  MEETING_TRANSCRIPTION_TOOLS, MEMORY_TOOLS, RUNNER_CAPABILITY_TOOLS, SESSION_EXECUTION_TOOL, SESSION_START_TOOL, SESSION_TOOLS, SKILL_TOOLS,
  WORKSPACE_TOOLS,
} from "./tools.js";

it("never offers two tools under one name: a client cannot tell them apart, and some refuse the whole list", () => {
  const names = [
    ...[...RUNNER_CAPABILITY_TOOLS, ...KNOWLEDGE_TOOLS, ...DISCUSSION_TOOLS, ...MEETING_TRANSCRIPTION_TOOLS, ...SESSION_TOOLS, ...WORKSPACE_TOOLS,
      SESSION_EXECUTION_TOOL, ...EXECUTION_TOOLS, ...MEMORY_TOOLS, ...SKILL_TOOLS, ...FEISHU_TOOLS, ...FEISHU_DOC_TOOLS, ...FEISHU_DOC_SHARE_TOOLS,
      ...FEISHU_SHARED_DOC_TOOLS, SESSION_START_TOOL,
      ...APP_TOOLS, CRDT_LIST_TOOL].map((spec) => spec.name),
    ...CRDT_TOOLS.map((tool) => tool.definition.name),
    APP_DISPATCH_TOOL.definition.name,
  ];
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
});
