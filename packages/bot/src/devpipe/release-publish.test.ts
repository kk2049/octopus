import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir: string;
const sha = "a".repeat(40);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "release-publish-"));
  const parts = ["dependencies", "outputs"].map(name => {
    const bytes = Buffer.from(name); writeFileSync(path.join(dir, `${name}.tar.gz`), bytes);
    return { name, file: `${name}.tar.gz`, bytes: bytes.length, sha256: hash(bytes) };
  });
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version: 1, repoSha: sha, parts }));
  // Exercise the actual CI executable with an isolated fetch boundary, never a real server.
  writeFileSync(path.join(dir, "fetch.mjs"), `
    import { appendFileSync } from 'node:fs';
    const root = process.env.OCTOPUS_JOB_ARTIFACT_DIR;
    let release = process.env.SCENARIO === 'existing' ? { tag_name: 'wrong' } : null;
    globalThis.fetch = async (url, init) => {
      if (init.redirect !== 'error' || init.headers['JOB-TOKEN'] !== 'fixture') throw Error('auth/redirect boundary changed');
      const method = init.method || 'GET';
      appendFileSync(root + '/calls.jsonl', JSON.stringify({ method, url }) + '\\n');
      if (method === 'HEAD') return new Response(null, { status: 404 });
      if (method === 'PUT') {
        let size = 0; for await (const chunk of init.body) size += chunk.length;
        if (size !== Number(init.headers['Content-Length'])) throw Error('upload truncated');
        return new Response(null, { status: 201 });
      }
      if (method === 'POST') {
        release = { ...JSON.parse(init.body), commit: { id: process.env.CI_COMMIT_SHA } };
        throw Error('server committed, ACK lost');
      }
      return release ? Response.json(release) : new Response(null, { status: 404 });
    };
  `);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(scenario = "normal") {
  return execFileSync(process.execPath, ["--import", path.join(dir, "fetch.mjs"), "scripts/ops/release-publish.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../../../.."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OCTOPUS_JOB_ARTIFACT_DIR: dir, CI_COMMIT_SHA: sha, CI_PROJECT_ID: "1", CI_JOB_TOKEN: "fixture",
      CI_API_V4_URL: "https://gitlab.example/api/v4", SCENARIO: scenario },
  });
}
const calls = () => readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { method: string });
it("uploads complete parts before one release marker and reconciles its lost ACK without replay", () => {
  expect(JSON.parse(run())).toMatchObject({ state: "published", sha });
  expect(calls().map(row => row.method)).toEqual(["GET", "HEAD", "PUT", "HEAD", "PUT", "HEAD", "PUT", "POST", "GET"]);
});
it("never replaces an existing different release", () => {
  expect(() => run("existing")).toThrow(); expect(calls().map(row => row.method)).toEqual(["GET"]);
});
it("does not create a release marker after detecting tampered archive bytes", () => {
  writeFileSync(path.join(dir, "dependencies.tar.gz"), "tampered");
  expect(() => run()).toThrow(); expect(calls().some(row => row.method === "POST")).toBe(false);
});
