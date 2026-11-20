import { randomBytes } from "node:crypto";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
export const GITHUB_OAUTH_TTL_MS = 10 * 60_000;

export type GithubFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function buildAuthorizeUrl(input: { clientId: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetcher?: GithubFetcher;
}): Promise<string> {
  const response = await (input.fetcher ?? fetch)(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    }).toString(),
  });
  if (!response.ok) throw new Error("GitHub token exchange failed");
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("GitHub token exchange returned no access token");
  }
  return body.access_token;
}

export async function fetchGithubUser(input: {
  accessToken: string;
  fetcher?: GithubFetcher;
}): Promise<{ id: number; login: string }> {
  const response = await (input.fetcher ?? fetch)(USER_URL, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.accessToken}`,
      "user-agent": "octopus-dashboard",
    },
  });
  if (!response.ok) throw new Error("GitHub user lookup failed");
  const body = await response.json().catch(() => null) as { id?: unknown; login?: unknown } | null;
  if (
    !body
    || typeof body.id !== "number"
    || !Number.isSafeInteger(body.id)
    || body.id <= 0
    || typeof body.login !== "string"
    || !body.login
  ) {
    throw new Error("GitHub user lookup returned an invalid profile");
  }
  return { id: body.id, login: body.login };
}

export interface OAuthState {
  mode: "login" | "connect";
  username?: string;
  next?: string;
  expiresAt: number;
}

export interface PendingGithubRegistration {
  provider: "github";
  externalId: string;
  label: string;
  expiresAt: number;
}

type TimedInput<T extends { expiresAt: number }> = Omit<T, "expiresAt">;

/**
 * OAuth state is deliberately process-local: losing it on restart makes the
 * browser repeat the authorization step, while persisting it would create a
 * second session-like credential store. Entries are short-lived and one-shot,
 * matching the fail-closed MemorySessionStore trade-off in web-trust.
 */
export class StateStore {
  private rows = new Map<string, OAuthState>();

  constructor(
    private now: () => number = Date.now,
    private token: () => string = randomToken,
    private ttlMs = GITHUB_OAUTH_TTL_MS,
    private maxEntries = 10_000,
  ) {}

  issue(input: TimedInput<OAuthState>): string {
    this.prune();
    this.makeRoom();
    const token = this.uniqueToken();
    this.rows.set(token, { ...input, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  consume(token: string): OAuthState | null {
    const row = this.rows.get(token);
    if (!row) return null;
    this.rows.delete(token);
    return row.expiresAt > this.now() ? row : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, row] of this.rows) {
      if (row.expiresAt <= now) this.rows.delete(token);
    }
  }

  private makeRoom(): void {
    while (this.rows.size >= this.maxEntries) {
      const oldest = this.rows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rows.delete(oldest);
    }
  }

  private uniqueToken(): string {
    let token = this.token();
    while (this.rows.has(token)) token = this.token();
    return token;
  }
}

/** GitHub-verified registration handoff; process-local, short-lived, one-shot. */
export class PendingRegistrationStore {
  private rows = new Map<string, PendingGithubRegistration>();

  constructor(
    private now: () => number = Date.now,
    private token: () => string = randomToken,
    private ttlMs = GITHUB_OAUTH_TTL_MS,
    private maxEntries = 10_000,
  ) {}

  issue(input: TimedInput<PendingGithubRegistration>): string {
    this.prune();
    this.makeRoom();
    const token = this.uniqueToken();
    this.rows.set(token, { ...input, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  peek(token: string): PendingGithubRegistration | null {
    const row = this.rows.get(token);
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.rows.delete(token);
      return null;
    }
    return row;
  }

  consume(token: string): PendingGithubRegistration | null {
    const row = this.rows.get(token);
    if (!row) return null;
    this.rows.delete(token);
    return row.expiresAt > this.now() ? row : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, row] of this.rows) {
      if (row.expiresAt <= now) this.rows.delete(token);
    }
  }

  private makeRoom(): void {
    while (this.rows.size >= this.maxEntries) {
      const oldest = this.rows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rows.delete(oldest);
    }
  }

  private uniqueToken(): string {
    let token = this.token();
    while (this.rows.has(token)) token = this.token();
    return token;
  }
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}
