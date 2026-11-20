/**
 * The certificate question, and the two ways answering it wrongly hurts.
 *
 * A permissive `ask` lets the proxy try to obtain a certificate for any name
 * that resolves here — an issuance-rate-limit burn and a host answering to names
 * nobody chose. A leaky one turns "which releases exist on this machine" into a
 * public query. So the tests below are about exactness (only the configured
 * domain, only the digest label shape, only installed releases) and about the
 * answer carrying nothing but a status code.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AppOriginAskServer } from "./origin-ask.js";
import type { SessionPlusOriginPolicy } from "../app-core/settings.js";

const POLICY: SessionPlusOriginPolicy = {
  scheme: "https:",
  domain: "apps.example.org",
  publicPort: null,
  pinnedLabel: null,
};

const PUBLISHED = new Set(["app-0123456789abcdef0123"]);

let server: AppOriginAskServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(policy = POLICY, labels = PUBLISHED): Promise<AppOriginAskServer> {
  server = new AppOriginAskServer({ host: "127.0.0.1", port: 0, policy, publishedLabels: () => labels });
  await server.start();
  return server;
}

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function ask(port: number, target: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const domain = (name: string): string => `/ask?domain=${encodeURIComponent(name)}`;

describe("the on-demand-TLS ask endpoint", () => {
  it("says yes to exactly one shape: a published digest label under the configured domain", async () => {
    const s = await start();
    const yes = await ask(s.port, domain("app-0123456789abcdef0123.apps.example.org"));
    expect(yes.status).toBe(200);
    expect(yes.body).toBe("");
    expect(s.stats.allowed).toBe(1);
  });

  it("refuses every name that is not that, and never explains which rule failed", async () => {
    const s = await start();
    const names = [
      // Not installed here.
      "app-ffffffffffffffffffff.apps.example.org",
      // Right label, wrong domain — and the two suffix mistakes a `endsWith`
      // test would let through.
      "app-0123456789abcdef0123.evil.com",
      "app-0123456789abcdef0123.apps.example.org.attacker.tld",
      "app-0123456789abcdef0123.not-apps.example.org",
      // Right domain, wrong label shape.
      "www.apps.example.org",
      "app-0123456789abcdef012.apps.example.org",
      "sub.app-0123456789abcdef0123.apps.example.org",
      // The panel itself, and the bare domain.
      "bot.example.org",
      "apps.example.org",
      "",
    ];
    for (const name of names) {
      const answer = await ask(s.port, domain(name));
      expect({ name, status: answer.status }).toEqual({ name, status: 403 });
      // The name is attacker-chosen (it arrives in TLS SNI), so it is never
      // echoed — not in the body, not in a header.
      expect(answer.body).toBe("");
      expect(JSON.stringify(answer.headers)).not.toContain("app-0123456789abcdef0123");
    }
    expect(s.stats.allowed).toBe(0);
    expect(s.stats.refused).toBe(names.length);
  });

  it("treats the hostname case-insensitively, because DNS does", async () => {
    // Not a loophole: `APP-0123….APPS.EXAMPLE.ORG` and its lowercase spelling are
    // the same DNS name and resolve to the same release. Refusing one of them
    // would mean a certificate is not issued for a name the browser will
    // genuinely use, and the digest label itself is lowercase hex either way.
    const s = await start();
    expect((await ask(s.port, domain("APP-0123456789ABCDEF0123.APPS.EXAMPLE.ORG"))).status).toBe(200);
  });

  it("answers only its own path", async () => {
    const s = await start();
    expect((await ask(s.port, "/")).status).toBe(404);
    expect((await ask(s.port, "/ask/../ask?domain=x")).status).toBe(403);
    expect((await ask(s.port, "/anything")).status).toBe(404);
  });

  it("honours an explicit public port, and refuses the same name without it", async () => {
    const s = await start({ ...POLICY, scheme: "http:", domain: "localhost", publicPort: 9821 });
    expect((await ask(s.port, domain("app-0123456789abcdef0123.localhost:9821"))).status).toBe(200);
    expect((await ask(s.port, domain("app-0123456789abcdef0123.localhost"))).status).toBe(403);
    expect((await ask(s.port, domain("app-0123456789abcdef0123.localhost:9822"))).status).toBe(403);
  });

  it("follows the catalog live, so an uninstall stops certificate issuance", async () => {
    const labels = new Set(["app-0123456789abcdef0123"]);
    const s = await start(POLICY, labels);
    expect((await ask(s.port, domain("app-0123456789abcdef0123.apps.example.org"))).status).toBe(200);
    labels.delete("app-0123456789abcdef0123");
    expect((await ask(s.port, domain("app-0123456789abcdef0123.apps.example.org"))).status).toBe(403);
  });

  it("combines an exact provisioned fleet host without weakening the App predicate", async () => {
    const fleetHost = "u-5001.dsh.16-58-204-8.sslip.io";
    server = new AppOriginAskServer({
      host: "127.0.0.1",
      port: 0,
      policy: POLICY,
      publishedLabels: () => PUBLISHED,
      additionalAllowedHost: (host) => host === fleetHost,
    });
    await server.start();
    expect((await ask(server.port, domain(fleetHost))).status).toBe(200);
    expect((await ask(server.port, domain("u-5002.dsh.16-58-204-8.sslip.io"))).status).toBe(403);
    expect((await ask(server.port, domain("app-0123456789abcdef0123.apps.example.org"))).status).toBe(200);
  });

  it("can serve the fleet predicate alone when Agent Views are disabled", async () => {
    server = new AppOriginAskServer({
      host: "127.0.0.1",
      port: 0,
      additionalAllowedHost: (host) => host === "u-5001.dsh.example.test",
    });
    await server.start();
    expect((await ask(server.port, domain("u-5001.dsh.example.test"))).status).toBe(200);
    expect((await ask(server.port, domain("app-0123456789abcdef0123.apps.example.org"))).status).toBe(403);
  });

  it("binds loopback only", async () => {
    const s = await start();
    expect(s.askUrl).toBe(`http://127.0.0.1:${s.port}/ask`);
    expect(s.stats.nonLoopback).toBe(0);
  });
});
