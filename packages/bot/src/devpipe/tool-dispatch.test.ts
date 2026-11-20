import { expect, it, vi } from "vitest";
import { dispatchDevpipeTool } from "./tool-dispatch.js";

it("returns submit knowledge validation errors as a tool refusal", async () => {
  const toolSubmit = vi.fn();
  const pipe = { toolSubmit } as never;
  const result = await dispatchDevpipeTool(pipe, "token", "submit", {});
  expect(result).toEqual({
    status: 200,
    body: {
      ok: false,
      code: "invalid_params",
      message: "devpipe_submit 参数无效：knowledge 必须是 object",
    },
  });
  expect(toolSubmit).not.toHaveBeenCalled();
});
