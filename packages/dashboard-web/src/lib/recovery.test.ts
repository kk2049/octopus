import { describe, expect, it } from "vitest";
import {
  documentReturnPath,
  loginUrl,
} from "./recovery.js";

describe("login recovery", () => {
  it("preserves the protected page, query and hash as one encoded return target", () => {
    const where = { pathname: "/tickets", search: "?mine=1", hash: "#approvals" };
    expect(documentReturnPath(where)).toBe("/tickets?mine=1#approvals");
    expect(loginUrl(where)).toBe("/login?next=%2Ftickets%3Fmine%3D1%23approvals");
  });

  it("does not recursively wrap the login page", () => {
    expect(loginUrl({ pathname: "/login", search: "?next=%2Ftickets", hash: "" })).toBe("/login");
  });
});
