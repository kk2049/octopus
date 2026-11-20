import { randomUUID } from "node:crypto";
import type { AppInstanceService } from "./app-instance.js";
import type { AppTrustService } from "../permissions/app-trust.js";
import type { Store } from "../store/store.js";

/** Trusted shell administration, shared by browser routes and explicitly granted MCP. */
export interface SharedManagementApp {
  stableAppId: string;
  publisher: string;
  packageDigest: string | null;
  service: Pick<AppInstanceService, "sharedRoles" | "releaseSharedInstance"> | null;
}

export class SharedManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message); }
}

export class SharedAppManagement {
  constructor(private readonly deps: {
    store: Pick<Store, "getSharedAppInstance" | "getSharedAppMember" | "listSharedAppMembers" | "createSharedAppInstance"
      | "setSharedAppMember" | "removeSharedAppMember" | "closeSharedAppInstance" | "getUser" | "recordPermissionAudit">;
    get: (app: string) => SharedManagementApp | null;
    trust: Pick<AppTrustService, "status">;
  }) {}

  private app(owner: string, appId: string) {
    const app = this.deps.get(appId);
    if (!app) throw new SharedManagementError("unknown_app", "没有这个 App", 404);
    if (!app.service || !app.packageDigest) throw new SharedManagementError("unavailable", "App 没有可服务的 release", 503);
    if (!this.deps.trust.status(owner, { appId, publisher: app.publisher, profile: "publisher-js", packageDigest: app.packageDigest }).trusted) {
      throw new SharedManagementError("trust_required", "请先在可信外层确认发布者与当前 release");
    }
    const roles = app.service.sharedRoles();
    if (!roles) throw new SharedManagementError("not_shared", "这个 App 没有共享实例", 400);
    return { app, roles };
  }

  managed(owner: string, appId: string, key: string) {
    const shared = this.app(owner, appId);
    if (!/^asi_[0-9a-f]{32}$/.test(key)) throw new SharedManagementError("invalid_params", "实例标识格式无效", 400);
    const instance = this.deps.store.getSharedAppInstance(appId, key);
    if (!instance) throw new SharedManagementError("instance_missing", "共享实例不存在", 404);
    if (instance.creator !== owner) throw new SharedManagementError("creator_required", "只有共享实例的创建者可以管理成员或关闭实例");
    return { ...shared, instance };
  }

  private audit(owner: string, appId: string, key: string, operation: string, detail: Record<string, unknown>) {
    this.deps.store.recordPermissionAudit({ at: new Date().toISOString(), owner, subject_type: "app", subject_id: appId,
      operation, resource: key, decision: "allow", reason: null, detail: JSON.stringify(detail) });
  }

  create(owner: string, appId: string, role: string) {
    const { roles } = this.app(owner, appId);
    if (!Object.hasOwn(roles, role)) throw new SharedManagementError("unknown_role", "角色不在当前 App release 的声明里", 400);
    const key = "asi_" + randomUUID().replace(/-/g, "");
    this.deps.store.createSharedAppInstance({ app_id: appId, instance_key: key, creator: owner,
      created_at: new Date().toISOString(), status: "open" }, role);
    this.audit(owner, appId, key, "create_shared_instance", { role });
    return { instance_key: key, role };
  }

  members(owner: string, appId: string, key: string) {
    const { instance, roles } = this.managed(owner, appId, key);
    return { instance_key: key, status: instance.status, creator: instance.creator, roles,
      members: this.deps.store.listSharedAppMembers(appId, key).map(({ username, role, joined_at }) => ({ username, role, joined_at })) };
  }

  setMember(owner: string, appId: string, key: string, username: string, role: string) {
    const { app, roles } = this.managed(owner, appId, key);
    if (!this.deps.store.getUser(username)) throw new SharedManagementError("unknown_user", "系统里没有这个用户", 400);
    if (!Object.hasOwn(roles, role)) throw new SharedManagementError("unknown_role", "角色不在当前 App release 的声明里", 400);
    const previous = this.deps.store.getSharedAppMember(appId, key, username);
    if (!this.deps.store.setSharedAppMember(appId, key, username, role, roles[role]!.max, new Date().toISOString())) {
      throw new SharedManagementError("seat_unavailable", "实例已关闭或该角色没有空位", 409);
    }
    if (previous && previous.role !== role) app.service!.releaseSharedInstance(key, "shared_membership_changed", username);
    this.audit(owner, appId, key, "set_shared_member", { username, role, previous_role: previous?.role ?? null });
    return { instance_key: key, username, role };
  }

  removeMember(owner: string, appId: string, key: string, username: string) {
    const { app, instance } = this.managed(owner, appId, key);
    if (username === instance.creator) throw new SharedManagementError("creator_required", "不能移除创建者；如需结束共享请关闭实例", 400);
    const changed = this.deps.store.removeSharedAppMember(appId, key, username);
    if (changed) app.service!.releaseSharedInstance(key, "shared_membership_revoked", username);
    this.audit(owner, appId, key, "remove_shared_member", { username, changed });
    return { changed };
  }

  close(owner: string, appId: string, key: string) {
    const { app } = this.managed(owner, appId, key);
    const changed = this.deps.store.closeSharedAppInstance(appId, key);
    if (changed) app.service!.releaseSharedInstance(key, "shared_instance_closed");
    this.audit(owner, appId, key, "close_shared_instance", { changed });
    return { changed };
  }
}
