/**
 * Endpoint onboarding must submit the account the select actually shows.
 *
 * The select has a derived first-row default, while its user-owned override
 * starts empty. Submitting the override instead of the displayed value made
 * the ordinary first click send `username: ""`; the server then correctly
 * returned 403 because an empty account is not the signed-in user's account.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { bootstrap } from "../lib/bootstrap.js";
import { renderPage, stubApi } from "../test-utils.js";
import { OverviewPage } from "./OverviewPage.js";

describe("the endpoint onboarding form", () => {
  it("submits the displayed default user without requiring a select interaction", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    }));
    (bootstrap as { pageProps: unknown }).pageProps = {
      hostIsGuess: false,
      tutorialHost: "bot.example.test",
      tokenPlaceholder: "<runner_token>",
      commands: {
        download: "download",
        run: "run",
        runOneline: "run one line",
        daemon: "daemon",
        windowsInstall: "install windows placeholder",
      },
    };
    (bootstrap as { viewer: unknown }).viewer = {
      username: "alice",
      admin: false,
      dev: false,
      deploy: false,
      contribute: false,
      session: true,
    };
    const { calls } = stubApi({
      "/api/overview": {
        generated_at: "2026-08-21T00:00:00.000Z",
        gateway_enabled: true,
        users: [{
          username: "alice",
          display_name: "Alice",
          runners: [{
            device: "aws-dev",
            display_name: "aliyun",
            online: true,
            local_agent_bridge_mode: "disabled",
            default_agent_injection: false,
            gui_automation_enabled: false,
            inventory: {
              local_mcp: { available: true, protocol: "runner-local-mcp/v1", clients: ["codex"] },
              gui_automation: {
                available: true,
                protocol: "runner-macos-gui/v1",
                consent_ttl_seconds: 900,
              },
            },
          }],
        }],
      },
      "/api/runner-local-agent-bridge": { ok: true },
      "/api/runner-default-agent-injection": { ok: true },
      "/api/runner-gui-automation": { ok: true },
      "/api/runner-token": {
        enrollment_code: "re_once",
        expires_at: "2026-08-28T00:10:00.000Z",
        install_cmd: "install unix once",
      },
    });
    const user = userEvent.setup();
    renderPage(<OverviewPage />);

    await screen.findByText("Alice");
    expect(screen.getByText("aliyun")).toBeInTheDocument();
    const bridgeRow = screen.getByText("本机 Agent 可操作其他端点：").parentElement!;
    await user.click(within(bridgeRow).getByRole("combobox"));
    await user.click(await screen.findByText("完全授权"));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/runner-local-agent-bridge")).toBe(true);
    });
    const bridgeRequest = calls.find((call) => call.url === "/api/runner-local-agent-bridge")!;
    expect(JSON.parse(String(bridgeRequest.init?.body))).toEqual({
      username: "alice",
      device: "aws-dev",
      mode: "full_access",
    });

    await user.click(screen.getByRole("button", { name: "开启默认注入" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/runner-default-agent-injection")).toBe(true);
    });
    const injectionRequest = calls.find((call) => call.url === "/api/runner-default-agent-injection")!;
    expect(JSON.parse(String(injectionRequest.init?.body))).toEqual({
      username: "alice",
      device: "aws-dev",
      enabled: true,
    });

    expect(screen.getAllByText("允许 Agent 发现并请求操作此 Mac：")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "开启 GUI 自动化" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/runner-gui-automation")).toBe(true);
    });
    const guiRequest = calls.find((call) => call.url === "/api/runner-gui-automation")!;
    expect(JSON.parse(String(guiRequest.init?.body))).toEqual({
      username: "alice",
      device: "aws-dev",
      enabled: true,
    });

    await user.click(screen.getByRole("button", { name: "签发" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("为用户 alice");
    await user.click(within(dialog).getByRole("button", { name: "签发" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/runner-token")).toBe(true);
    });
    const request = calls.find((call) => call.url === "/api/runner-token")!;
    expect(JSON.parse(String(request.init?.body))).toEqual({ username: "alice", device: "laptop", platform: "unix" });
  }, 30_000);

  it("switches to native Windows one-click instructions and renders the minted command", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    }));
    (bootstrap as { pageProps: unknown }).pageProps = {
      hostIsGuess: false,
      tutorialHost: "bot.example.test",
      tokenPlaceholder: "<runner_token>",
      commands: {
        download: "download",
        run: "run",
        runOneline: "run one line",
        daemon: "daemon",
        windowsInstall: "install windows placeholder",
        unixInstall: "install unix placeholder",
      },
    };
    const { calls } = stubApi({
      "/api/overview": {
        generated_at: "2026-08-21T00:00:00.000Z",
        gateway_enabled: true,
        users: [{
          username: "alice",
          display_name: "Alice",
          runners: [{
            device: "linux-ci",
            online: true,
            local_agent_bridge_mode: "disabled",
            default_agent_injection: false,
            gui_automation_enabled: false,
            inventory: {
              local_mcp: { available: true, protocol: "runner-local-mcp/v1", clients: ["codex"] },
            },
          }],
        }],
      },
      "/api/runner-token": {
        enrollment_code: "re_once",
        expires_at: "2026-08-29T00:10:00.000Z",
        install_cmd: "install windows once",
      },
    });
    const user = userEvent.setup();
    renderPage(<OverviewPage />);

    await user.click(await screen.findByRole("tab", { name: "Windows" }));
    expect(screen.queryByText("允许 Agent 发现并请求操作此 Mac：")).not.toBeInTheDocument();
    expect(screen.queryByText("install windows placeholder")).not.toBeInTheDocument();
    expect(screen.getByText(/不使用 WSL/)).toBeInTheDocument();
    expect(screen.getByText(/仅执行环境/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "签发" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "签发" }));
    expect(await screen.findByText("install windows once")).toBeInTheDocument();
    expect(screen.queryByText("rt_once")).not.toBeInTheDocument();
    const request = calls.find((call) => call.url === "/api/runner-token")!;
    expect(JSON.parse(String(request.init?.body))).toEqual({
      username: "alice",
      device: "laptop",
      platform: "windows-installed",
    });
  }, 30_000);
});
