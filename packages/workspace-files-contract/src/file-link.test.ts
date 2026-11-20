import { expect, it, vi } from "vitest";
import { createRemoteWorkspaceFilesPortV4 } from "./remote-v4.js";
import { workspaceFileLinkProblem } from "./file-link.js";

it("sends only the link and source ref, validates the echoed answer, and discards responses after close", async () => {
  const result = { source: "session-ref", href: "../report.pdf", root: { ref: "root-ref", label: "/", sourceLabel: "Laptop" }, entry: {
    base: "root-ref", path: "reports/report.pdf", ref: "file-ref", label: "report.pdf", kind: "file",
  } };
  const propose = vi.fn(async () => ({ ok: true, result, message: "" }));
  const remote = createRemoteWorkspaceFilesPortV4({ propose }, "files");
  expect(await remote.port.resolveFileLink({ sessionRef: "session-ref", href: "../report.pdf" })).toMatchObject({ ok: true });
  expect(propose).toHaveBeenCalledWith("resource.resolve_file_link", { binding: "files", session: "session-ref", href: "../report.pdf" });
  result.source = "other-session";
  expect(await remote.port.resolveFileLink({ sessionRef: "session-ref", href: "../report.pdf" })).toMatchObject({ ok: false });
  result.source = "session-ref";
  const pending = remote.port.resolveFileLink({ sessionRef: "session-ref", href: "../report.pdf" });
  remote.destroy();
  expect(await pending).toMatchObject({ ok: false, code: "scope_closed" });
});

it("rejects ambiguous origins and non-file links before transport", async () => {
  const propose = vi.fn();
  const { port } = createRemoteWorkspaceFilesPortV4({ propose }, "files");
  for (const href of ["https://example.test/a", "//server/a", "a\0b", "x".repeat(401)]) {
    expect(workspaceFileLinkProblem({ sessionRef: "session-ref", href })).not.toBeNull();
    expect(await port.resolveFileLink({ sessionRef: "session-ref", href })).toMatchObject({ ok: false, code: "invalid_request" });
  }
  expect(await port.resolveFileLink({ sessionRef: "session-ref", fileRef: "file-ref", href: "a.txt" })).toMatchObject({ ok: false });
  expect(propose).not.toHaveBeenCalled();
});
