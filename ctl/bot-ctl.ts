#!/usr/bin/env tsx
/**
 * bot-ctl — Claude Bot containerized instance management CLI.
 *
 * Supports multi-instance management: create, start, stop, restart,
 * update, remove, list, logs, run.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ── Constants ──

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? __dirname, "..");
const INSTANCES_DIR = path.join(PROJECT_ROOT, "instances");
const IMAGE_NAME = "claude-bot:latest";
const DEV_IMAGE_NAME = "claude-bot-dev:latest";

// ── Utilities ──

function run(cmd: string, options?: { cwd?: string; check?: boolean }): string {
  const { cwd, check = true } = options ?? {};
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "inherit" }) ?? "";
  } catch (err) {
    if (check) throw err;
    return "";
  }
}

function runCapture(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const hasCompose = (() => {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function containerName(name: string): string {
  return `claude-bot-${name}`;
}

function dockerCompose(instanceDir: string, ...args: string[]): string {
  return `docker compose -f "${path.join(instanceDir, "docker-compose.yml")}" ${args.join(" ")}`;
}

function getProxyBuildArgs(): string {
  const keys = [
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ];
  return keys
    .filter((k) => process.env[k])
    .map((k) => `--build-arg ${k}=${process.env[k]}`)
    .join(" ");
}

// ── Commands ──

function buildImage(): void {
  console.log(`正在构建镜像 ${IMAGE_NAME}...`);
  run(`docker build -t ${IMAGE_NAME} ${getProxyBuildArgs()} .`, { cwd: PROJECT_ROOT });
  console.log(`✓ 镜像 ${IMAGE_NAME} 构建完成`);
}

function ensureImageExists(): void {
  const result = runCapture(`docker images -q ${IMAGE_NAME}`);
  if (!result) {
    console.log(`镜像 ${IMAGE_NAME} 不存在，开始构建...`);
    buildImage();
  }
}

function buildDevImage(): void {
  ensureImageExists();
  console.log(`正在构建开发镜像 ${DEV_IMAGE_NAME}...`);
  run(`docker build -t ${DEV_IMAGE_NAME} -f Dockerfile.dev ${getProxyBuildArgs()} .`, { cwd: PROJECT_ROOT });
  console.log(`✓ 开发镜像 ${DEV_IMAGE_NAME} 构建完成`);
}

function createInstance(name: string, template?: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 已存在`);
    process.exit(1);
  }

  console.log(`初始化实例: ${name}`);
  mkdirSync(instanceDir, { recursive: true });
  mkdirSync(path.join(instanceDir, "data"), { recursive: true });

  // Copy config template
  let configSource: string;
  if (template && existsSync(template)) {
    configSource = template;
  } else if (existsSync(path.join(PROJECT_ROOT, "config.yaml"))) {
    configSource = path.join(PROJECT_ROOT, "config.yaml");
  } else if (existsSync(path.join(PROJECT_ROOT, "config.yaml.example"))) {
    configSource = path.join(PROJECT_ROOT, "config.yaml.example");
  } else {
    console.error("错误: 找不到配置模板文件");
    process.exit(1);
  }

  copyFileSync(configSource, path.join(instanceDir, "config.yaml"));
  console.log(`✓ 配置文件已复制: ${path.join(instanceDir, "config.yaml")}`);
  console.log(`  来源: ${configSource}`);

  // Auto-detect SSH public key
  let sshVolume = "";
  for (const keyFile of ["id_ed25519.pub", "id_rsa.pub"]) {
    const keyPath = path.join(homedir(), ".ssh", keyFile);
    if (existsSync(keyPath)) {
      sshVolume = `\n      - ${keyPath}:/tmp/ssh_authorized_keys:ro`;
      console.log(`✓ SSH 公钥已配置: ${keyPath}`);
      break;
    }
  }

  // Generate docker-compose.yml
  const proxyEnv = [
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy",
  ]
    .filter((k) => process.env[k])
    .map((k) => `      - ${k}=${process.env[k]}`)
    .join("\n");

  // Mount host's ~/.claude for OAuth credentials (Max plan)
  // Container runs as non-root user "claude" (HOME=/home/claude)
  const claudeDir = path.join(homedir(), ".claude");
  const claudeVolume = existsSync(claudeDir)
    ? `\n      - ${claudeDir}:/home/claude/.claude:ro`
    : "";

  // Mount host SSH keys for remote MCP connections
  const sshDir = path.join(homedir(), ".ssh");
  const sshDirVolume = existsSync(sshDir)
    ? `\n      - ${sshDir}:/home/claude/.ssh:ro`
    : "";

  const compose = `services:
  bot:
    image: ${IMAGE_NAME}
    container_name: claude-bot-${name}
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./data:/data${sshVolume}${sshDirVolume}${claudeVolume}
    environment:
      - TZ=Asia/Shanghai
      - DATA_DIR=/data
      - HOME=/home/claude
${proxyEnv ? proxyEnv + "\n" : ""}    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
`;

  writeFileSync(path.join(instanceDir, "docker-compose.yml"), compose, "utf-8");
  console.log("✓ docker-compose.yml 已生成");

  console.log(`\n✓ 实例 ${name} 初始化完成`);
  console.log(`\n下一步:`);
  console.log(`  1. 编辑配置: vim ${path.join(instanceDir, "config.yaml")}`);
  console.log(`  2. 启动实例: ./bot-ctl start ${name}`);
}

function listInstances(): void {
  if (!existsSync(INSTANCES_DIR)) {
    console.log("暂无实例");
    return;
  }

  const instances = readdirSync(INSTANCES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  if (instances.length === 0) {
    console.log("暂无实例");
    return;
  }

  // Get container info
  const containerOutput = runCapture(
    `docker ps -a --filter "name=claude-bot-" --format "{{.Names}}\t{{.ID}}\t{{.Status}}\t{{.Image}}"`,
  );
  const containerInfo = new Map<string, { id: string; status: string; image: string }>();
  for (const line of containerOutput.split("\n").filter(Boolean)) {
    const [cname, id, status, image] = line.split("\t");
    containerInfo.set(cname, { id, status, image });
  }

  console.log(`${"NAME".padEnd(20)} ${"STATUS".padEnd(25)} ${"CONTAINER ID".padEnd(15)} ${"IMAGE"}`);
  console.log("-".repeat(80));

  for (const name of instances) {
    const containerName = `claude-bot-${name}`;
    const info = containerInfo.get(containerName);
    if (info) {
      console.log(
        `${name.padEnd(20)} ${info.status.padEnd(25)} ${info.id.padEnd(15)} ${info.image}`,
      );
    } else {
      console.log(`${name.padEnd(20)} ${"Created (not started)".padEnd(25)} ${"-".padEnd(15)} -`);
    }
  }
}

function startInstance(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    console.log(`提示: 使用 './bot-ctl create ${name}' 创建新实例`);
    process.exit(1);
  }
  ensureImageExists();
  console.log(`启动实例 ${name}...`);
  run(dockerCompose(instanceDir, "up", "-d"));
  console.log(`✓ 实例 ${name} 已启动`);
  console.log(`\n查看日志: ./bot-ctl logs ${name} -f`);
}

function stopInstance(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    process.exit(1);
  }
  console.log(`停止实例 ${name}...`);
  run(dockerCompose(instanceDir, "stop"));
  console.log(`✓ 实例 ${name} 已停止`);
}

function restartInstance(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    process.exit(1);
  }
  console.log(`重启实例 ${name}...`);
  run(dockerCompose(instanceDir, "restart"));
  console.log(`✓ 实例 ${name} 已重启`);
}

function updateInstance(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    process.exit(1);
  }
  console.log(`更新实例 ${name}...`);
  console.log("1/4 停止并移除旧容器...");
  run(dockerCompose(instanceDir, "down"), { check: false });
  console.log("2/4 重新构建镜像...");
  buildImage();
  console.log("3/4 打包 CLI 分发包...");
  packCli();
  // Fix data directory ownership — previous root-run containers may have left
  // root-owned files that the new non-root process can't write to
  const dataDir = path.join(instanceDir, "data");
  if (existsSync(dataDir)) {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    console.log(`    修复 data/ 目录权限 (${uid}:${gid})...`);
    run(`docker run --rm -v "${dataDir}:/data" alpine chown -R ${uid}:${gid} /data`, { check: false });
  }
  console.log("4/4 启动容器...");
  run(dockerCompose(instanceDir, "up", "-d"));
  console.log(`✓ 实例 ${name} 已更新并启动`);
  console.log(`\n查看日志: ./bot-ctl logs ${name} -f`);
}

function updateAllInstances(): void {
  if (!existsSync(INSTANCES_DIR)) {
    console.log("暂无实例");
    return;
  }

  const instances = readdirSync(INSTANCES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Find running instances
  const running: string[] = [];
  for (const name of instances) {
    const result = runCapture(`docker ps -q --filter "name=claude-bot-${name}"`);
    if (result) running.push(name);
  }

  if (running.length === 0) {
    console.log("没有正在运行的实例");
    return;
  }

  console.log(`将更新 ${running.length} 个运行中的实例: ${running.join(", ")}`);

  console.log("\n1/4 停止并移除旧容器...");
  for (const name of running) {
    run(dockerCompose(path.join(INSTANCES_DIR, name), "down"), { check: false });
  }

  console.log("2/4 重新构建镜像...");
  buildImage();

  console.log("3/4 打包 CLI 分发包...");
  packCli();

  console.log("4/4 启动所有实例...");
  for (const name of running) {
    run(dockerCompose(path.join(INSTANCES_DIR, name), "up", "-d"));
    console.log(`  ✓ ${name}`);
  }

  console.log(`\n✓ 全部 ${running.length} 个实例已更新`);
}

function removeInstance(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    process.exit(1);
  }

  // Simple confirmation via stderr prompt
  process.stderr.write(`确认删除实例 ${name}？所有数据将被删除 (y/N): `);
  const buf = Buffer.alloc(10);
  const { readSync } = require("node:fs");
  const n = readSync(0, buf, 0, 10, null);
  const answer = buf.toString("utf-8", 0, n).trim().toLowerCase();

  if (answer !== "y") {
    console.log("已取消");
    return;
  }

  console.log("停止并删除容器...");
  run(dockerCompose(instanceDir, "down"), { check: false });
  console.log("删除实例目录...");
  rmSync(instanceDir, { recursive: true });
  console.log(`✓ 实例 ${name} 已删除`);
}

function showLogs(name: string, follow: boolean): void {
  const instanceDir = path.join(INSTANCES_DIR, name);
  if (!existsSync(instanceDir)) {
    console.error(`错误: 实例 ${name} 不存在`);
    process.exit(1);
  }
  const args = follow ? "logs -f" : "logs";
  run(dockerCompose(instanceDir, args));
}

function runLocal(name: string): void {
  const instanceDir = path.join(INSTANCES_DIR, name);

  if (!existsSync(instanceDir)) {
    console.log(`实例 ${name} 不存在，正在初始化...`);
    mkdirSync(instanceDir, { recursive: true });
    mkdirSync(path.join(instanceDir, "data"), { recursive: true });

    let configSource: string;
    if (existsSync(path.join(PROJECT_ROOT, "config.yaml"))) {
      configSource = path.join(PROJECT_ROOT, "config.yaml");
    } else if (existsSync(path.join(PROJECT_ROOT, "config.yaml.example"))) {
      configSource = path.join(PROJECT_ROOT, "config.yaml.example");
    } else {
      console.error("错误: 找不到配置模板文件");
      process.exit(1);
    }

    copyFileSync(configSource, path.join(instanceDir, "config.yaml"));
    console.log(`✓ 实例 ${name} 已初始化: ${instanceDir}`);
    console.log(`  配置文件: ${path.join(instanceDir, "config.yaml")}`);

    if (configSource.endsWith(".example")) {
      console.log("\n提示: 请先编辑配置文件填入凭证:");
      console.log(`  vim ${path.join(instanceDir, "config.yaml")}`);
      process.exit(0);
    }
  }

  const configPath = path.join(instanceDir, "config.yaml");
  const dataDir = path.join(instanceDir, "data");

  console.log(`本地运行实例: ${name}`);
  console.log(`  配置: ${configPath}`);
  console.log(`  数据目录: ${dataDir}`);
  console.log();

  process.env.CONFIG_PATH = configPath;
  process.env.DATA_DIR = dataDir;

  // Run the bot (the bootstrap-v3 composition root, as production does)
  const botEntry = path.join(PROJECT_ROOT, "packages/bot/src/bootstrap-v3.ts");
  spawnSync("npx", ["tsx", botEntry], {
    cwd: instanceDir,
    stdio: "inherit",
    env: { ...process.env, CONFIG_PATH: configPath, DATA_DIR: dataDir },
  });
}

// ── Main ──

function printHelp(): void {
  console.log(`
Claude Bot 实例管理工具

用法: bot-ctl <command> [options]

命令:
  build              构建 Docker 镜像
  build-dev          构建开发容器镜像
  create <name>      创建新实例
  list               列出所有实例
  start <name>       启动实例
  stop <name>        停止实例
  restart <name>     重启实例
  update [name]      更新代码并重启（不指定则更新所有运行中的实例）
  remove <name>      删除实例
  logs <name> [-f]   查看日志
  run [name]         本地运行（默认实例名: local）
`);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  try {
    switch (command) {
      case "build":
        buildImage();
        break;
      case "build-dev":
        buildDevImage();
        break;
      case "create":
        createInstance(args[1], args.includes("-t") ? args[args.indexOf("-t") + 1] : undefined);
        break;
      case "list":
        listInstances();
        break;
      case "start":
        startInstance(args[1]);
        break;
      case "stop":
        stopInstance(args[1]);
        break;
      case "restart":
        restartInstance(args[1]);
        break;
      case "update":
        if (args[1]) {
          updateInstance(args[1]);
        } else {
          updateAllInstances();
        }
        break;
      case "remove":
        removeInstance(args[1]);
        break;
      case "logs":
        showLogs(args[1], args.includes("-f") || args.includes("--follow"));
        break;
      case "run":
        runLocal(args[1] ?? "local");
        break;
      default:
        console.error(`未知命令: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      console.error("请先安装依赖: pnpm install");
    }
    process.exit(1);
  }
}

main();
