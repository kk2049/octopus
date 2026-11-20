/**
 * Ant Design adapter for the opaque-origin Agent View document.
 *
 * This is presentation-only: it reads the View-owned `--av-*` CSS tokens and
 * the document's existing style nonce. It has no transport, identity, resource
 * or parent-document access. Keeping it here (rather than importing the trusted
 * Dashboard provider) preserves the package and trust boundary.
 */

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { StyleProvider } from "@ant-design/cssinjs";
import AntApp from "antd/es/app";
import ConfigProvider, { type ThemeConfig } from "antd/es/config-provider";
import zhCN from "antd/es/locale/zh_CN";
import antTheme from "antd/es/theme";
import { documentStyleNonce } from "./nonce.js";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

function appearanceSnapshot(): string {
  if (typeof document === "undefined") return "classic:light";
  return `${document.documentElement.dataset.avTheme ?? "classic"}:${media()?.matches ? "dark" : "light"}`;
}

function subscribeAppearance(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const query = media();
  query?.addEventListener("change", listener);
  const observer = typeof MutationObserver === "undefined"
    ? null
    : new MutationObserver(listener);
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-av-theme"] });
  return () => {
    query?.removeEventListener("change", listener);
    observer?.disconnect();
  };
}

function cssToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function cssNumber(name: string, fallback: number): number {
  const value = Number.parseFloat(cssToken(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

export function agentViewAntTheme(snapshot: string): ThemeConfig {
  const dark = snapshot.endsWith(":dark");
  const accent = cssToken("--av-accent", dark ? "#7fa2ff" : "#315fd6");
  const surface = cssToken("--av-surface", dark ? "#1a1f27" : "#ffffff");
  const canvas = cssToken("--av-canvas", dark ? "#11151b" : "#f5f7fa");
  const line = cssToken("--av-line", dark ? "#343b47" : "#dfe3e9");
  const tool = cssToken("--av-tool-bg", dark ? "#1f242d" : "#f2f4f8");
  const controlHeight = cssNumber("--av-control-h", 30);
  return {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    cssVar: { key: `agent-view-${snapshot.replace(":", "-")}` },
    hashed: true,
    token: {
      colorPrimary: accent,
      colorInfo: cssToken("--av-info", accent),
      colorLink: accent,
      colorSuccess: cssToken("--av-ok", dark ? "#4fc48a" : "#147a45"),
      colorWarning: cssToken("--av-warn", dark ? "#e5a34e" : "#a45a08"),
      colorError: cssToken("--av-error", dark ? "#f17676" : "#c43636"),
      colorText: cssToken("--av-fg", dark ? "#e5e9f0" : "#1d2430"),
      colorTextSecondary: cssToken("--av-muted", dark ? "#9ba5b5" : "#616c80"),
      colorBorder: line,
      colorBgContainer: surface,
      colorBgElevated: surface,
      colorBgLayout: canvas,
      colorFillAlter: tool,
      borderRadius: cssNumber("--av-rs", 6),
      borderRadiusLG: cssNumber("--av-rm", 10),
      fontFamily: cssToken(
        "--av-font",
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
      ),
      fontSize: cssNumber("--av-md", 14),
      controlHeight,
    },
    components: {
      Alert: { borderRadiusLG: cssNumber("--av-rm", 10) },
      Button: {
        fontWeight: cssNumber("--av-control-weight", 600),
        borderRadius: cssNumber("--av-rs", 6),
        controlHeight,
      },
      Card: {
        bodyPadding: cssNumber("--av-card-padding", 12),
        borderRadiusLG: cssNumber("--av-rm", 10),
      },
      Empty: { colorTextDescription: cssToken("--av-muted", dark ? "#9ba5b5" : "#616c80") },
      Input: { activeBorderColor: accent, hoverBorderColor: accent },
      Select: { optionSelectedBg: tool, controlHeight },
      Tag: { borderRadiusSM: cssNumber("--av-pill", 999) },
    },
  };
}

export function AgentViewUiProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribeAppearance, appearanceSnapshot, () => "classic:light");
  const theme = useMemo(() => agentViewAntTheme(snapshot), [snapshot]);
  const nonce = documentStyleNonce();
  return (
    <StyleProvider layer>
      <ConfigProvider
        locale={zhCN}
        componentSize="small"
        button={{ autoInsertSpace: false }}
        wave={{ disabled: true }}
        csp={nonce ? { nonce } : undefined}
        theme={theme}
      >
        <AntApp className="av-ant-root">{children}</AntApp>
      </ConfigProvider>
    </StyleProvider>
  );
}
