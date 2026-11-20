import { describe, expect, it, vi } from "vitest";
import {
  PendingRegistrationStore,
  StateStore,
  buildAuthorizeUrl,
  exchangeCode,
  fetchGithubUser,
  type GithubFetcher,
} from "./oauth-github.js";

describe("GitHub OAuth primitives", () => {
  it("builds the no-scope authorize URL without a redirect_uri", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "client id", state: "state/value" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client id");
    expect(url.searchParams.get("state")).toBe("state/value");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("redirect_uri")).toBe(false);
  });

  it("exchanges the code as form data and returns only the access token", async () => {
    const fetcher = vi.fn<GithubFetcher>(async () => new Response(JSON.stringify({ access_token: "gho_secret" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(exchangeCode({
      clientId: "client",
      clientSecret: "secret",
      code: "temporary-code",
      fetcher,
    })).resolves.toBe("gho_secret");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init?.headers).toMatchObject({ accept: "application/json" });
    expect(new URLSearchParams(String(init?.body))).toEqual(new URLSearchParams({
      client_id: "client",
      client_secret: "secret",
      code: "temporary-code",
    }));
  });

  it("fetches and validates the immutable numeric id plus mutable login", async () => {
    const fetcher = vi.fn<GithubFetcher>(async () => new Response(JSON.stringify({ id: 123456, login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(fetchGithubUser({ accessToken: "gho_secret", fetcher })).resolves.toEqual({
      id: 123456,
      login: "octocat",
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer gho_secret",
      "user-agent": "octopus-dashboard",
    });
  });

  it("fails closed on HTTP errors or malformed responses", async () => {
    const denied = async () => new Response("no", { status: 401 });
    await expect(exchangeCode({ clientId: "c", clientSecret: "s", code: "x", fetcher: denied })).rejects.toThrow(
      "token exchange failed",
    );
    await expect(fetchGithubUser({
      accessToken: "x",
      fetcher: async () => new Response(JSON.stringify({ id: "1", login: "octocat" })),
    })).rejects.toThrow("invalid profile");
  });
});

describe("one-shot OAuth memory stores", () => {
  it("consumes state once and rejects it the second time", () => {
    const store = new StateStore(() => 1_000, () => "state-token");
    const token = store.issue({ mode: "login", next: "/tickets" });
    expect(store.consume(token)).toMatchObject({ mode: "login", next: "/tickets" });
    expect(store.consume(token)).toBeNull();
  });

  it("rejects expired state even on its first consume", () => {
    let now = 1_000;
    const store = new StateStore(() => now, () => "state-token", 100);
    const token = store.issue({ mode: "login" });
    now = 1_100;
    expect(store.consume(token)).toBeNull();
  });

  it("peeks pending registrations without consuming and consumes them once", () => {
    const store = new PendingRegistrationStore(() => 1_000, () => "reg-token");
    const token = store.issue({ provider: "github", externalId: "123", label: "octocat" });
    expect(store.peek(token)).toMatchObject({ externalId: "123", label: "octocat" });
    expect(store.peek(token)).toBeTruthy();
    expect(store.consume(token)).toBeTruthy();
    expect(store.consume(token)).toBeNull();
  });
});
