/** SSH recovery entry: uses GitLab, the local store and the independent supervisor.
 * It never calls the Octopus application, builds code or replaces a running tree.
 */
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../packages/bot/src/config.js";
import { GitLabReleaseCatalog } from "../packages/bot/src/devpipe/gitlab-release.js";
import { DeployArtifactService } from "../packages/bot/src/devpipe/deploy-artifact.js";
import { ReleaseStager } from "../packages/bot/src/devpipe/release-stage.js";
import { DeployService } from "../packages/bot/src/devpipe/deploy.js";
import { StartupIngress } from "../packages/bot/src/devpipe/startup-ingress.js";
import { resolveCapabilityBits } from "../packages/bot/src/permissions/capability-bits.js";
import { Store } from "../packages/bot/src/store/store.js";

const { positionals: [command], values } = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, "data-dir": { type: "string" }, sha: { type: "string" }, digest: { type: "string" },
  actor: { type: "string" }, reason: { type: "string" }, id: { type: "string" },
} });
async function main() {
  if (!values.config || !values["data-dir"] || !path.isAbsolute(values.config) || !path.isAbsolute(values["data-dir"])) throw new Error("supply absolute --config and --data-dir paths on the service device");
  if (!["check", "prepare", "request-deploy", "status"].includes(command ?? "")) throw new Error("command must be check, prepare, request-deploy or status");
  const config = loadConfig(values.config), hosting = config.selfhosting;
  const build = hosting?.deployment_build;
  if (!hosting?.repo_dir || !hosting.run_dir || build?.mode !== "gitlab" || !build.gitlab || hosting.mainline?.authority !== "gitlab") throw new Error("this service is not configured for GitLab authority and immutable releases");
  const dataDir = values["data-dir"], repoDir = hosting.repo_dir, branch = hosting.base_branch ?? "v4";
  const catalog = new GitLabReleaseCatalog({ apiUrl: build.gitlab.api_url, project: build.gitlab.project,
    tokenFile: build.gitlab.token_file, repoDir, branch, remote: hosting.mainline.remote, stateFile: path.join(dataDir, "gitlab-release-check.json") });
  if (command === "check") { console.log(JSON.stringify(await catalog.check(), null, 2)); return; }
  const dbFile = path.join(dataDir, "bot.db");
  if (!(await fs.stat(dbFile)).isFile()) throw new Error("the existing service database is required; refusing to create another deployment state");
  const store = new Store(dbFile);
  let artifacts: DeployArtifactService | undefined, deploy: DeployService | undefined, stager: ReleaseStager | undefined;
  try {
    if (command === "status") {
      const id = Number(values.id); if (!Number.isSafeInteger(id) || id < 1) throw new Error("status requires --id");
      console.log(JSON.stringify(store.devTickets.getDeployIntent(id) ?? null, null, 2)); return;
    }
    const sha = values.sha, digest = values.digest;
    if (!/^[0-9a-f]{40}$/u.test(sha ?? "") || !/^[0-9a-f]{64}$/u.test(digest ?? "")) throw new Error("prepare/deploy requires --sha and --digest from an explicit check");
    const checked = (await catalog.snapshot())?.ready;
    if (checked?.sha !== sha || checked?.manifestSha256 !== digest) throw new Error("release is not the checked version; inspect a fresh check before choosing it");
    await catalog.release(sha!, digest);
    const releases = path.join(path.dirname(dataDir), "releases", "trees");
    const releaseJob = path.join(repoDir, "scripts", "ops", "release-job.sh");
    stager = new ReleaseStager({ job: releaseJob, repository: repoDir, releases,
      artifacts: path.join(dataDir, "deploy-artifacts"), database: dbFile,
      foregroundBusy: () => Boolean(store.devTickets.getActiveDeployIntent()),
      pointers: async () => {
        const current = await fs.realpath(hosting.run_dir!);
        const file = path.join(dataDir, "deploy-artifacts", "intents", `${store.devTickets.listDeployIntents(1)[0]?.id}.previous`);
        return { current, previous: await fs.readFile(file, "utf8").then(s => s.trim()).catch(() => current) };
      } });
    artifacts = new DeployArtifactService({ dir: path.join(dataDir, "deploy-artifacts"), repoDir, releasesDir: releases,
      worktreesDir: hosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees"),
      provider: target => catalog.provider(target.target_sha, target.release_manifest_sha256 ?? digest),
      stage: (manifest, target, signal) => stager!.stage(manifest, target, signal) });
    if (command === "prepare") {
      // An operator asking explicitly is the retry: no need to wait out the pause.
      await artifacts.prewarm(sha!, { retryFailed: true }); const status = await artifacts.status(sha!);
      console.log(JSON.stringify(status, null, 2)); if (status.state !== "ready") process.exitCode = 1; return;
    }
    if (!values.actor || !values.reason?.trim() || values.reason.length > 500) throw new Error("recovery deployment requires --actor and a bounded --reason");
    const bits = resolveCapabilityBits({ username: values.actor, admins: config.dashboard?.admins, deployers: hosting.deployers,
      granted: store.listUserGrants(values.actor).map(row => row.capability) });
    if (!bits.deploy) throw new Error("the recovery operator does not have the service's deploy permission");
    deploy = new DeployService({ store, repoDir, baseBranch: branch, runTreeDir: hosting.run_dir, releaseCatalog: catalog,
      releaseStatus: target => artifacts!.status(target),
      ...(config.dashboard?.public_url ? { ingress: new StartupIngress(repoDir, config.dashboard.public_url) } : {}) });
    const intent = await deploy.trigger(values.actor, sha, undefined, { sha: sha!, manifestSha256: digest! });
    deploy.stop();
    const audit = path.join(dataDir, "deploy-artifacts", "intents", `${intent.id}.recovery.json`);
    await fs.writeFile(audit, JSON.stringify({ id: intent.id, actor: values.actor, reason: values.reason, sha, manifestSha256: digest, at: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    await artifacts.prepare(intent);
    const prepared = await artifacts.status(sha!);
    if (prepared.state !== "ready" || prepared.manifestSha256 !== digest) throw new Error(`deployment D${intent.id} is not prepared; inspect its persisted intent state`);
    console.log(JSON.stringify({ intent_id: intent.id, target_sha: sha, manifest_sha256: digest, status: "requested", owner: "independent-supervisor" }, null, 2));
  } finally { deploy?.stop(); artifacts?.close(); stager?.close(); store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
