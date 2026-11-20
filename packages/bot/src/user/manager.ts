/**
 * UserManager — manages user accounts, directory creation, identity resolution.
 * Handles concurrency-safe registration with in-flight deduplication.
 */

import { chmod, chown, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "../store/store.js";
import type { User, UserIdentity, UserManager, FeishuOAuthToken } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("user-manager");

const RESERVED_USERNAMES = ["root", "admin", "bot", "system", "shared", "data"];
const USERNAME_RE = /^[a-z][a-z0-9_]{1,31}$/;

function validateUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error("用户名必须以小写字母开头，2-32位，仅含小写字母数字下划线");
  }
  if (RESERVED_USERNAMES.includes(username)) {
    throw new Error("该用户名已被保留");
  }
}

function buildUser(row: { username: string; uid: number; home_dir: string; created_at: string }): User {
  return {
    username: row.username,
    uid: row.uid,
    homeDir: row.home_dir,
    workspaceDir: path.join(row.home_dir, "workspace"),
    claudeSessionsDir: path.join(row.home_dir, "claude-sessions"),
    oauthDir: path.join(row.home_dir, "oauth"),
    ragDocsDir: path.join(row.home_dir, "rag/docs"),
    memoryDir: path.join(row.home_dir, "memory"),
    skillsDir: path.join(row.home_dir, ".claude", "skills"),
    createdAt: new Date(row.created_at),
  };
}

export class UserManagerImpl implements UserManager {
  private store: Store;
  private dataDir: string;
  private uidIsolationEnabled: boolean;
  private users = new Map<string, User>();
  private identityIndex = new Map<string, string>(); // "provider:externalId" → username
  private nextUid: number;
  private registrationInFlight = new Map<string, Promise<User>>();

  constructor(store: Store, dataDir: string, uidIsolationEnabled = false) {
    this.store = store;
    this.dataDir = dataDir;
    this.uidIsolationEnabled = uidIsolationEnabled;
    this.nextUid = store.getMaxUid() + 1;
  }

  async restore(): Promise<void> {
    const userRows = this.store.loadUsers();
    for (const row of userRows) {
      const user = buildUser(row);
      this.users.set(user.username, user);
      // Directories added after a user registered (e.g. memory/) must be
      // backfilled here — restore() is the only path an existing user takes.
      await mkdir(user.memoryDir, { recursive: true, mode: 0o700 }).catch(() => {});
      await mkdir(user.skillsDir, { recursive: true, mode: 0o700 }).catch(() => {});
      await this.ensureOwnership(user.homeDir, user.uid);

      const identities = this.store.getIdentitiesByUser(user.username);
      for (const id of identities) {
        this.identityIndex.set(`${id.provider}:${id.external_id}`, user.username);
      }
    }

    if (userRows.length > 0) {
      this.nextUid = Math.max(this.nextUid, ...userRows.map((r) => r.uid)) + 1;
    }

    log.info(`Restored ${this.users.size} users`);
  }

  resolve(provider: string, externalId: string): User | undefined {
    const key = `${provider}:${externalId}`;
    const username = this.identityIndex.get(key);
    return username ? this.users.get(username) : undefined;
  }

  async register(username: string, identity: UserIdentity): Promise<User> {
    const key = `${identity.provider}:${identity.externalId}`;

    // Dedup in-flight registrations
    const existing = this.registrationInFlight.get(key);
    if (existing) return existing;

    const promise = this._doRegister(username, identity);
    this.registrationInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.registrationInFlight.delete(key);
    }
  }

  private async _doRegister(username: string, identity: UserIdentity): Promise<User> {
    // Idempotency: check if identity is already bound
    const existingUsername = this.identityIndex.get(`${identity.provider}:${identity.externalId}`);
    if (existingUsername) {
      return this.users.get(existingUsername)!;
    }

    // Check if username already taken
    if (this.users.has(username)) {
      throw new Error(`用户名 "${username}" 已被使用`);
    }

    validateUsername(username);

    const uid = this.nextUid++;
    const homeDir = path.join(this.dataDir, "users", username);
    const now = new Date().toISOString();

    // Create directory structure
    const dirs = [
      homeDir,
      path.join(homeDir, "workspace"),
      path.join(homeDir, ".claude"),
      path.join(homeDir, ".claude", "skills"),
      path.join(homeDir, "claude-sessions"),
      path.join(homeDir, "oauth"),
      path.join(homeDir, "rag"),
      path.join(homeDir, "rag", "docs"),
      path.join(homeDir, "memory"),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
    }
    await this.ensureOwnership(homeDir, uid);

    // Persist
    this.store.saveUser({ username, uid, home_dir: homeDir, created_at: now });
    this.store.saveIdentity(username, {
      provider: identity.provider,
      externalId: identity.externalId,
      label: identity.label,
    });

    const user = buildUser({ username, uid, home_dir: homeDir, created_at: now });
    this.users.set(username, user);
    this.identityIndex.set(`${identity.provider}:${identity.externalId}`, username);

    log.info(`Registered user: ${username} (uid=${uid})`);
    return user;
  }

  async addIdentity(username: string, identity: UserIdentity): Promise<void> {
    const user = this.users.get(username);
    if (!user) throw new Error(`User "${username}" not found`);

    this.store.saveIdentity(username, {
      provider: identity.provider,
      externalId: identity.externalId,
      label: identity.label,
    });
    this.identityIndex.set(`${identity.provider}:${identity.externalId}`, username);

    // externalId is the resolution anchor, not an operator-facing label; do
    // not turn logs into another identity-enumeration surface.
    log.info({ username, provider: identity.provider }, "Added external identity");
  }

  removeIdentity(username: string, provider: string, externalId: string): boolean {
    if (!this.users.has(username)) throw new Error(`User "${username}" not found`);
    const removed = this.store.deleteIdentity(username, provider, externalId);
    const key = `${provider}:${externalId}`;
    if (removed && this.identityIndex.get(key) === username) this.identityIndex.delete(key);
    if (removed) log.info({ username, provider }, "Removed external identity");
    return removed;
  }

  get(username: string): User | undefined {
    return this.users.get(username);
  }

  list(): User[] {
    return Array.from(this.users.values());
  }

  getFeishuToken(username: string): FeishuOAuthToken | undefined {
    const user = this.users.get(username);
    if (!user) return undefined;

    const tokenPath = path.join(user.oauthDir, "feishu_token.json");
    try {
      const data = readFileSync(tokenPath, "utf-8");
      return JSON.parse(data) as FeishuOAuthToken;
    } catch {
      return undefined;
    }
  }

  async saveFeishuToken(username: string, token: FeishuOAuthToken): Promise<void> {
    const user = this.users.get(username);
    if (!user) throw new Error(`User "${username}" not found`);

    const tokenPath = path.join(user.oauthDir, "feishu_token.json");
    await writeFile(tokenPath, JSON.stringify(token, null, 2), "utf-8");
    await chmod(tokenPath, 0o600).catch(() => {});
    if (this.uidIsolationEnabled && process.getuid?.() === 0) {
      await chown(tokenPath, user.uid, user.uid).catch(() => {});
    }
    log.info(`Saved Feishu token for ${username}`);
  }

  private async ensureOwnership(rootDir: string, uid: number): Promise<void> {
    if (!this.uidIsolationEnabled || process.getuid?.() !== 0) return;
    const gid = uid;
    await this.restrictUserTree(rootDir, uid, gid).catch((err) => {
      log.warn({ err, rootDir, uid, gid }, "Failed to apply uid isolation permissions");
    });
  }

  private async restrictUserTree(targetPath: string, uid: number, gid: number): Promise<void> {
    const info = await stat(targetPath).catch(() => null);
    if (!info) return;

    await chown(targetPath, uid, gid).catch(() => {});
    await chmod(targetPath, info.isDirectory() ? 0o700 : 0o600).catch(() => {});

    if (!info.isDirectory()) return;
    const entries = await readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await this.restrictUserTree(path.join(targetPath, entry.name), uid, gid);
    }
  }
}
