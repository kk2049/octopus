import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOSS_WORKER } from "./moss-worker.js";
function run(ambiguous = false) {
  const root = mkdtempSync(join(tmpdir(), "research-moss-worker-")), job = join(root, "job"), bin = join(root, "bin");
  mkdirSync(job); mkdirSync(bin);
  const input = join(job, "input.wav"), script = join(root, "transcriber.py");
  writeFileSync(input, "fixture; no GPU audio inference");
  writeFileSync(join(bin, "ffmpeg"), '#!/usr/bin/env python3\nimport pathlib,sys\npathlib.Path(sys.argv[-1]).write_bytes(b"fixture tail")\n', { mode: 0o700 });
  writeFileSync(script, `#!/usr/bin/env python3
import sys,pathlib,json
out=pathlib.Path(sys.argv[sys.argv.index('--out')+1]); out.mkdir()
full=pathlib.Path(sys.argv[1]).name=='input.wav'
raw='[0][S01]甲。[49]\\n[50][S02]乙。[99]\\n[100][S01]甲。[149]\\n[150][S02]乙。[199]\\n[200' if full else '[0][S01]乙。[20]\\n[21][S02]甲。[70]\\n[71][S01]乙。[120]\\n[121][S02]甲。[220.9]'
if ${ambiguous ? "True" : "False"} and not full: raw=raw.replace('S02','S01')
(out/'model-raw.txt').write_text(raw)
(out/'inference.json').write_text(json.dumps({'generated_tokens':16385 if full else 1000}))
(out/'manifest.json').write_text(json.dumps({'settings':{'duration_seconds':300,'max_new_tokens':32768,'model':'MOSS','model_revision':'fixture'}}))
sys.exit(1 if full else 0)
`, { mode: 0o700 });
  const result = spawnSync("python3", ["-c", MOSS_WORKER, JSON.stringify({ job, input, root, script, cwd: root, title: "fixture", timeout: 30 })], {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH }, encoding: "utf8", timeout: 5000,
  });
  return { root, job, result };
}
describe("bounded MOSS overlap recovery worker", () => {
  it("recovers a clipped recording through a verified speaker permutation and common silence seam", () => {
    const { root, job, result } = run();
    try {
      expect(result.status, result.stderr).toBe(0);
      const recovered = JSON.parse(readFileSync(join(job, "result/recovery.json"), "utf8"));
      expect(recovered.sources).toHaveLength(2);
      expect(recovered.speaker_mapping[0]).toMatchObject({ mapping: { S01: "S02", S02: "S01" }, agreement: 1 });
      expect(recovered.seams[0].cutover_seconds).toBe(149.5);
      const segments = JSON.parse(readFileSync(join(job, "result/segments.json"), "utf8"));
      expect(segments.map((segment: { speaker: string }) => segment.speaker)).toEqual(["A", "B", "A", "B", "A"]);
      expect(segments.at(-1).end).toBeCloseTo(299.9);
      expect(JSON.parse(readFileSync(join(job, "result/complete.json"), "utf8")).status).toBe("recovered_machine_transcript_complete");
      expect(readFileSync(join(job, "asr/model-raw.txt"), "utf8")).toMatch(/\[200$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("retains a readable partial transcript instead of merging ambiguous speaker identities", () => {
    const { root, job, result } = run(true);
    try {
      expect(result.status).toBe(1);
      expect(existsSync(join(job, "result/complete.json"))).toBe(false);
      expect(readFileSync(join(job, "result/dialogue.md"), "utf8")).toContain("部分转写");
      expect(JSON.parse(readFileSync(join(job, "result/quality.json"), "utf8"))).toMatchObject({ tail_review_required: true, last_segment_end: 199 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
