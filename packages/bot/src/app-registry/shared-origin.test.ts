import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { resolveSessionPlus, sessionPlusSettingsFor, viewUrlFor } from "../app-core/settings.js";
import { AppViewServer } from "./view-server.js";
import { declaredAppHostingFrom } from "./declared-adapter.js";

const origin = "https://203.0.113.21:444";
const servers: AppViewServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });
function settings(publicUrl = origin) {
  const result = resolveSessionPlus({ config: { enabled: true, shared_origin: true, view_port: 0 }, publicUrl });
  if (!result.enabled || !result.settings) throw new Error(result.errors.join("; "));
  return result.settings;
}

describe("explicit shared-origin App publication", () => {
  it("keeps CSP origins separate from digest document URLs, including IPv6 and hot releases", () => {
    const base = settings();
    expect(base.viewOrigin).toBe(origin);
    expect(base.frameAncestors).toEqual([origin]);
    expect(base.viewUrl).toBe(`${origin}/__octopus/apps/${base.identity.packageHostLabel}/`);
    const changed = sessionPlusSettingsFor(base, { ...base.identity, packageHostLabel: "app-0123456789abcdef0123" });
    expect(changed).toMatchObject({ ok: true, settings: { viewOrigin: origin, viewUrl: `${origin}/__octopus/apps/app-0123456789abcdef0123/` } });
    expect(declaredAppHostingFrom(base)).toMatchObject({ ok: true, hosting: { appDomain: "203.0.113.21", pathPrefix: "/__octopus/apps/", publicPort: 444 } });
    expect(viewUrlFor(settings("https://[2001:db8::1]:444").origin, "app-0123456789abcdef0123"))
      .toBe("https://[2001:db8::1]:444/__octopus/apps/app-0123456789abcdef0123/");
  });

  it.each([undefined, "http://203.0.113.21:444", "https://user:password@203.0.113.21", `${origin}/prefix`, `${origin}/?q=x`, "https://*.example.com"])("rejects an unsafe or ambiguous public URL: %s", (publicUrl) => {
    expect(resolveSessionPlus({ config: { enabled: true, shared_origin: true }, publicUrl }))
      .toMatchObject({ enabled: true, settings: null });
  });

  it("requires opt-in and refuses mixed domain/path configuration", () => {
    expect(resolveSessionPlus({ config: { enabled: true, view_origin: origin }, publicUrl: origin }))
      .toMatchObject({ settings: null });
    expect(resolveSessionPlus({ config: { enabled: true, shared_origin: true, app_domain: "apps.example.com" }, publicUrl: origin }))
      .toMatchObject({ settings: null });
    const result = resolveSessionPlus({ config: { enabled: true, shared_origin: true }, publicUrl: origin });
    expect(result).toMatchObject({ settings: { listenPort: 9821, originAsk: null } });
  });

  it("serves only exact published digest paths, with no cookie response or alternate-URL fallback", async () => {
    const resolved = settings();
    const server = new AppViewServer(resolved); servers.push(server); await server.start();
    const pathname = new URL(resolved.viewUrl!).pathname;
    const get = (target: string, host = "203.0.113.21:444", method = "GET") => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: target, method, headers: { host, cookie: "test=not-authority" } }, (res) => {
        res.resume(); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
      }); req.on("error", reject); req.end();
    });
    const answer = await get(pathname);
    expect(answer.status).toBe(200);
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(answer.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect((await get(`${pathname}index.html`, undefined, "HEAD")).status).toBe(200);
    expect((await get(pathname, "evil.example")).status).toBe(421);
    for (const target of ["/", `${pathname}?q=x`, `${pathname}../index.html`, pathname.replace("app-", "%61pp-"), "/__octopus/apps/app-00000000000000000000/"]) {
      expect((await get(target)).status, target).toBe(404);
    }
    expect((await get(pathname, undefined, "POST")).status).toBe(405);
  });
});
