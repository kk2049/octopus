import { type PanelReply, type PanelRequest, bodyOf, replyJson as json } from "../http.js";
import type { DashboardTentaclePort } from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity } from "../server.js";
import type { GuardedRoutes } from "./context.js";

export interface TentacleRoutesContext {
  tentacle: DashboardTentaclePort | null;
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
  requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean;
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
}

export function registerTentacleRoutes(routes: GuardedRoutes, ctx: TentacleRoutesContext): void {
  routes.get("/api/tentacle", "api.tentacle.list", (req, reply, identity) => {
    const owner = ctx.targetAccount(req, identity);
    if (!ctx.requireUser(reply, identity, owner)) return;
    if (!ctx.tentacle) {
      json(reply, 200, { owner, available: false, devices: [], shares: [] });
      return;
    }
    json(reply, 200, {
      owner,
      available: true,
      ...ctx.tentacle.catalog(owner),
      shares: ctx.tentacle.shares(owner),
    });
  });

  routes.post(
    "/api/tentacle/shares",
    "api.tentacle.share",
    PANEL_BODY_SCHEMAS.tentacleShare,
    (req, reply, identity) => {
      const body = bodyOf(req);
      const owner = String(body.username ?? identity.username ?? "");
      if (!ctx.canWriteAs(identity, owner)) {
        json(reply, 403, { error: "dsh 共享只能由资源 owner 决定" });
        return;
      }
      if (!ctx.tentacle) {
        json(reply, 404, { error: "当前部署没有组合 dsh tentacle Gate" });
        return;
      }
      const kind = body.kind === "projection" ? "projection" : body.kind === "tool" ? "tool" : null;
      if (!kind) {
        json(reply, 400, { error: "kind 必须是 tool 或 projection" });
        return;
      }
      try {
        const share = ctx.tentacle.share({
          owner,
          viewer: String(body.viewer ?? ""),
          device: String(body.device ?? ""),
          kind,
          resourceKey: String(body.resource_key ?? ""),
          createdBy: identity.username!,
        });
        json(reply, 200, { ok: true, share });
      } catch (error) {
        json(reply, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  routes.post(
    "/api/tentacle/shares/revoke",
    "api.tentacle.revoke",
    PANEL_BODY_SCHEMAS.tentacleRevoke,
    (req, reply, identity) => {
      const body = bodyOf(req);
      const owner = String(body.username ?? identity.username ?? "");
      if (!ctx.canWriteAs(identity, owner)) {
        json(reply, 403, { error: "dsh 共享只能由资源 owner 撤销" });
        return;
      }
      if (!ctx.tentacle) {
        json(reply, 404, { error: "当前部署没有组合 dsh tentacle Gate" });
        return;
      }
      const changed = ctx.tentacle.revoke({
        owner,
        viewer: String(body.viewer ?? ""),
        objectId: String(body.object_id ?? ""),
        by: identity.username!,
      });
      json(reply, 200, { ok: true, changed });
    },
  );
}
