import { describe, expect, it } from "vitest";
import { defineOperationCatalog, type OperationInfo } from "../permissions/catalog.js";
import {
  SESSION_PLUS_ALL_OPERATIONS,
  SESSION_PLUS_AUTO_ALLOW,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_AUTO_ALLOW,
  SESSION_PLUS_WORKSPACE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
} from "./contract.js";
import {
  SESSION_RESOURCE_CATALOG,
  SESSION_RESOURCE_OPERATIONS,
  sessionResourceCatalogFor,
} from "./catalog.js";

describe("Session Plus operation catalog", () => {
  it("describes every operation any implemented contract may declare", () => {
    // The dictionary is the UNION — a screen must be able to describe an
    // operation before anybody is asked about it — while what a given release
    // asks for is narrowed per contract below.
    expect(SESSION_RESOURCE_CATALOG.ids).toEqual([...SESSION_PLUS_ALL_OPERATIONS]);
    // The catalog can express owner-local session/workspace defaults; shared
    // document editing and outbound notification remain per-call approval.
    expect(SESSION_RESOURCE_CATALOG.autoAllowable).toEqual([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "list_session_workspaces",
      "start_session",
      "append_session",
      "list_workspace_entries",
      "read_workspace_text",
      "read_workspace_binary",
      "download_workspace_file",
      "access_owner_files",
      "replace_owner_text",
      "replace_workspace_text",
      "upload_session_file",
      "read_document",
      "open_workspace_terminal",
      "workspace_terminal",
    ]);
    expect(SESSION_RESOURCE_OPERATIONS.filter((operation) => operation.effect === "execute"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "start_session", alwaysApprove: false, mayAutoAllow: true }),
        expect.objectContaining({ id: "append_session", alwaysApprove: false, mayAutoAllow: true }),
      ]));
  });

  it("narrows to exactly one release's ask", () => {
    expect(sessionResourceCatalogFor(SESSION_PLUS_PERMISSION_CONTRACT).ids)
      .toEqual([...SESSION_PLUS_OPERATIONS]);
    expect(sessionResourceCatalogFor(SESSION_PLUS_PERMISSION_CONTRACT).autoAllowable)
      .toEqual([...SESSION_PLUS_AUTO_ALLOW]);
    expect(sessionResourceCatalogFor(SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT).ids)
      .toEqual([...SESSION_PLUS_WORKSPACE_OPERATIONS]);
    expect(sessionResourceCatalogFor(SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT).autoAllowable)
      .toEqual([...SESSION_PLUS_WORKSPACE_AUTO_ALLOW]);
    expect(sessionResourceCatalogFor(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT).autoAllowable)
      .toEqual([...SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.autoAllow]);
    expect(sessionResourceCatalogFor(SESSION_PLUS_PERMISSION_CONTRACT).operation("append_session"))
      .toMatchObject({ alwaysApprove: true, mayAutoAllow: false });
    expect(sessionResourceCatalogFor(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT).operation("append_session"))
      .toMatchObject({ alwaysApprove: false, mayAutoAllow: true });
  });

  it("keeps the two new workspace reads read-class and auto-allowable", () => {
    for (const id of ["list_workspace_entries", "read_workspace_text"]) {
      const info = SESSION_RESOURCE_CATALOG.operation(id)!;
      expect(info).toBeDefined();
      expect(info.effect).toBe("read");
      expect(info.alwaysApprove).toBe(false);
      expect(info.mayAutoAllow).toBe(true);
    }
  });

  it("describes regular-file download as a distinct read authority", () => {
    expect(SESSION_RESOURCE_CATALOG.operation("download_workspace_file")).toMatchObject({
      runner: "download_workspace_file",
      effect: "read",
      alwaysApprove: false,
      mayAutoAllow: true,
      disclosure: "workspace-file-content",
    });
  });

  it("describes owner Runner access separately from workspace-scoped reads", () => {
    expect(SESSION_RESOURCE_CATALOG.operation("access_owner_files")).toMatchObject({
      runner: "access_owner_files",
      effect: "read",
      alwaysApprove: false,
      mayAutoAllow: true,
      disclosure: "owner-runner-file-content",
    });
  });

  it("describes upload as an owner-local device write", () => {
    expect(SESSION_RESOURCE_CATALOG.operation("upload_session_file")).toMatchObject({
      runner: "upload_session_file",
      effect: "modify",
      alwaysApprove: false,
      mayAutoAllow: true,
      disclosure: "session-attachment",
    });
  });

  it("reuses the existing workspace-enumeration token rather than a third name", () => {
    // The file tree's root listing spends `list_session_workspaces`, which the
    // new-agent form already asks for. A third permission name for one
    // capability would be a second thing to grant for the same disclosure.
    expect(SESSION_PLUS_WORKSPACE_OPERATIONS.filter((op) => op.includes("workspace"))).toEqual([
      "list_session_workspaces",
      "list_workspace_entries",
      "read_workspace_text",
    ]);
  });

  it("rejects contradictory always-approve and auto-allow policy", () => {
    const bad: OperationInfo = {
      id: "run_thing",
      runner: "run_thing",
      title: "run",
      description: "run",
      effect: "execute",
      risk: "执行命令",
      alwaysApprove: true,
      mayAutoAllow: true,
    };
    expect(() => defineOperationCatalog("bad", [bad], { run_thing: {} }))
      .toThrow(/both always-approve and auto-allowable/);
  });
});
