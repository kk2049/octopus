import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureStartup } from "./configure-startup.mjs";
import { haveCaddy, startupFixture } from "./fixture.js";

describe("startup-page configuration", () => {
  const source = `{
  admin off
}
bot.example.com {
  handle /octopus-runner/v1* {
    reverse_proxy 127.0.0.1:9910
  }
  handle {
    reverse_proxy 127.0.0.1:9820
  }
}
other.example.com {
  reverse_proxy 127.0.0.1:9820
}
`;
  const configure = (input: string) => configureStartup(input, "bot.example.com", "/srv/startup/startup.caddy", "/srv/startup", "127.0.0.1:9820");
  it("changes only the Dashboard catch-all and is idempotent", () => {
    const candidate = configure(source);
    expect(candidate).toContain("handle /octopus-runner/v1* {\n    reverse_proxy 127.0.0.1:9910");
    expect(candidate).toContain("other.example.com {\n  reverse_proxy 127.0.0.1:9820");
    expect(candidate).toContain("import octopus_startup /srv/startup 127.0.0.1:9820");
    expect(configure(candidate)).toBe(candidate);
    const updated = configureStartup(candidate, "bot.example.com", "/srv/next/startup.caddy", "/srv/next", "127.0.0.1:9820");
    expect(updated).toContain("import /srv/next/startup.caddy");
    expect(updated).toContain("import octopus_startup /srv/next 127.0.0.1:9820");
    expect(updated).not.toContain("/srv/startup");
  });
  it("refuses custom or ambiguous proxy/error routing", () => {
    expect(() => configure(source.replace("reverse_proxy 127.0.0.1:9820", "reverse_proxy 127.0.0.1:9820 {\n header_up X-Custom yes\n }"))).toThrow("custom proxy");
    expect(() => configure(source.replace("  handle {", "  handle_errors { respond 503 }\n  handle {"))).toThrow("custom error");
    expect(() => configure(source + source)).toThrow("one caddy-fmt");
  });
});

if (!haveCaddy) console.warn("startup ingress integration skipped: caddy is not installed");
describe.skipIf(!haveCaddy)("real Caddy restart fallback", () => {
  let env: Awaited<ReturnType<typeof startupFixture>>;
  beforeAll(async () => { env = await startupFixture(); });
  afterAll(async () => { await env?.close(); });

  it("preserves healthy authorization/errors and strips credentials from the readiness probe", async () => {
    for (const [path, status] of [["/", 401], ["/denied", 403], ["/missing", 404], ["/broken", 500]] as const) {
      expect((await fetch(env.base + path, { headers: { Accept: "text/html" } })).status).toBe(status);
    }
    const probe = await fetch(`${env.base}/__octopus/ready?token=never-forward`, {
      headers: { Cookie: "secret=cookie", Authorization: "Bearer secret" },
    });
    expect(probe.status).toBe(204);
    expect(probe.headers.get("cache-control")).toBe("no-store");
    expect(env.requests.at(-1)).toEqual({ method: "GET", url: "/login", cookie: undefined, authorization: undefined });
    env.setLoginStatus(503);
    expect((await fetch(`${env.base}/__octopus/ready`)).status).toBe(503);
    env.setLoginStatus(200);
    const before = env.requests.length;
    expect((await fetch(`${env.base}/api/action`, { method: "POST", body: "once" })).status).toBe(503);
    expect(env.requests.length - before).toBe(1);
  });

  it("serves a standalone loading document while Bot is absent, then resumes normal routing", async () => {
    await env.stopBackend();
    const response = await fetch(`${env.base}/sessions-plus?private=value`, { headers: { Accept: "text/html" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain("服务正在启动");
    expect(html).not.toContain("private=value");
    for (const path of ["/launcher", "/apps/chess/open", "/hq", "/secretary", "/access-preview"]) {
      const page = await fetch(env.base + path, { headers: { Accept: "text/html" } });
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("服务正在启动");
    }
    for (const file of ["loading.js", "loading.css"]) {
      expect((await fetch(`${env.base}/__octopus/startup/${file}`)).status).toBe(200);
    }
    expect((await fetch(`${env.base}/__octopus/startup/unknown`)).status).toBe(404);
    for (const path of ["/api/action", "/auth/github", "/ui/a/missing.js", "/__octopus/ready"]) {
      const api = await fetch(env.base + path, { headers: { Accept: "text/html" } });
      expect(api.status).toBe(503);
      expect(api.headers.get("content-type")).toBe("application/json");
      expect(await api.json()).toEqual({ error: "service_unavailable" });
    }
    const write = await fetch(`${env.base}/tickets`, { method: "POST", headers: { Accept: "text/html" } });
    expect(await write.json()).toEqual({ error: "service_unavailable" });
    const runner = await fetch(`${env.base}/octopus-runner/v1`, { headers: { Accept: "text/html" } });
    expect(runner.status).toBe(502);
    expect(await runner.text()).not.toContain("OCTOPUS");
    await env.startBackend();
    expect((await fetch(`${env.base}/__octopus/ready`)).status).toBe(204);
    expect((await fetch(`${env.base}/sessions-plus`, { headers: { Accept: "text/html" } })).status).toBe(401);
  });
});
