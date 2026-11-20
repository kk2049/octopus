import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fakeExecutables } from "../../../../tools/test-support/fake-executables.mjs";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "release-archive-")); temporary.push(dir);
  const root = join(dir, "source"), out = join(dir, "artifacts");
  for (const entry of ["tools", "node_modules/.vite", "packages/dashboard-web/dist/.vite", "packages/dashboard-web/dist/assets", "packages/runner/dist", "plugins/sessions/dist"]) {
    mkdirSync(join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, "pnpm-lock.yaml"), "fixture lock\n");
  writeFileSync(join(root, "node_modules/.vite/results.json"), "temporary test results");
  writeFileSync(join(root, "packages/dashboard-web/dist/.vite/manifest.json"), JSON.stringify({ main: { isEntry: true, file: "assets/main.js", css: ["assets/main.css"] } }));
  writeFileSync(join(root, "packages/dashboard-web/dist/assets/main.js"), "export default 1");
  writeFileSync(join(root, "packages/dashboard-web/dist/assets/main.css"), "body{}");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "pnpm-lock.yaml"]);
  execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // These tests exercise the real packer and tar bytes, with already-built fixture outputs.
  // Dependency installation, compilation and native ABI checks have separate real release acceptance.
  // Only these fakes (never the host's real pnpm/node) are reachable.
  const fake = fakeExecutables({ pnpm: "#!/bin/sh\nexit 0\n", node: "#!/bin/sh\nexit 0\n" }, { home: dir });
  temporary.push(fake.dir);
  const bin = fake.bin;
  const build = () => spawnSync(process.execPath, [join(process.cwd(), "scripts/ops/release-build.mjs"), sha], {
    cwd: root, encoding: "utf8", env: { ...fake.env, OCTOPUS_COMPUTE_ROLE: "worker", OCTOPUS_JOB_ARTIFACT_DIR: out },
  });
  return { root, out, bin, build };
}

it("retains the runtime Vite manifest while excluding dependency test caches", () => {
  const f = fixture(), result = f.build();
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  expect(execFileSync("tar", ["-tzf", join(f.out, "outputs.tar.gz")], { encoding: "utf8" })).toContain("packages/dashboard-web/dist/.vite/manifest.json");
  expect(execFileSync("tar", ["-tzf", join(f.out, "dependencies.tar.gz")], { encoding: "utf8" })).not.toContain(".vite");
  expect(JSON.parse(readFileSync(join(f.out, "release.json"), "utf8")).parts).toHaveLength(2);
  const manifest = JSON.parse(readFileSync(join(f.out, "release.json"), "utf8"));
  const inventory = execFileSync("tar", ["-xOzf", join(f.out, "outputs.tar.gz"), manifest.dependencyIndex.file]);
  expect(createHash("sha256").update(inventory).digest("hex")).toBe(manifest.dependencyIndex.sha256);
  expect(manifest.dependencyIndex.archiveSha256).toBe(manifest.parts.find((p: { name: string }) => p.name === "dependencies").sha256);
  expect(inventory.toString().trim()).toBe(JSON.stringify({ path: "node_modules", type: "directory" }));
});

it("refuses to declare a release whose dashboard manifest references a missing asset", () => {
  const f = fixture(); rmSync(join(f.root, "packages/dashboard-web/dist/assets/main.css"));
  const result = f.build();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("main.css");
});

it("packages every App before declaring the trusted-code release ready", () => {
  const f = fixture();
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: { "app:pack": "fixture", "app:pack:second": "fixture", ignored: "fixture" } }));
  writeFileSync(join(f.bin, "pnpm"), `#!/bin/sh\nif [ "$1" = run ]; then printf '{"script":"%s"}' "$2" > "$5"; fi\n`);
  const result = f.build();
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  const manifest = JSON.parse(readFileSync(join(f.out, "release.json"), "utf8"));
  expect(manifest.apps.map((a: { script: string }) => a.script)).toEqual(["app:pack", "app:pack:second"]);
  const archive = execFileSync("tar", ["-tzf", join(f.out, "outputs.tar.gz")], { encoding: "utf8" });
  for (const app of manifest.apps) {
    expect(archive).toContain(app.file);
    expect(app.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});
