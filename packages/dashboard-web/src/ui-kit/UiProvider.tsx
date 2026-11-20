/**
 * Ant Design is an implementation detail of the ordinary dashboard UI.
 *
 * The dashboard's CSS themes remain authoritative. Whenever the
 * theme store changes, resolved CSS variables are projected into Ant's token
 * system; pages never import ConfigProvider or Ant theme APIs themselves.
 */

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { StyleProvider } from "@ant-design/cssinjs";
import AntApp from "antd/es/app";
import ConfigProvider, { type ThemeConfig } from "antd/es/config-provider";
import enUS from "antd/es/locale/en_US";
import jaJP from "antd/es/locale/ja_JP";
import zhCN from "antd/es/locale/zh_CN";
import zhTW from "antd/es/locale/zh_TW";
import antTheme from "antd/es/theme";
import {
  currentLanguage,
  subscribeLanguage,
  type DashboardLanguageId,
} from "../i18n/language.js";
import { currentTheme, subscribeTheme } from "../styles/themes.js";
import { currentColorScheme, subscribeColorScheme } from "../styles/color-scheme.js";
import styles from "./UiProvider.module.css";

const ANT_LOCALES: Record<DashboardLanguageId, typeof zhCN> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  // Ant has no Min Nan pack; Taiwanese Traditional Chinese is the closest
  // component-library vocabulary while product copy remains independently nan.
  "nan-TW": zhTW,
  en: enUS,
  "ja-JP": jaJP,
};

export function dashboardAntLocale(language: DashboardLanguageId): typeof zhCN {
  return ANT_LOCALES[language];
}

function cssToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function cssNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(cssToken(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function dashboardAntTheme(themeId: string, dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    cssVar: { key: `octopus-${themeId}-${dark ? "dark" : "light"}` },
    hashed: true,
    token: {
      colorPrimary: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
      colorInfo: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
      colorLink: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
      colorSuccess: cssToken("--ok", dark ? "#4ade80" : "#16a34a"),
      colorWarning: cssToken("--q-warning", dark ? "#fbbf24" : "#d97706"),
      colorError: cssToken("--err", dark ? "#f87171" : "#dc2626"),
      colorText: cssToken("--fg", dark ? "#e5e7eb" : "#1c1e21"),
      colorTextSecondary: cssToken("--muted", dark ? "#9aa1ad" : "#68707c"),
      colorBorder: cssToken("--line", dark ? "#333842" : "#e3e5e8"),
      colorBgContainer: cssToken("--card", dark ? "#1b1e24" : "#ffffff"),
      colorBgElevated: cssToken("--card", dark ? "#1b1e24" : "#ffffff"),
      colorBgLayout: cssToken("--bg", dark ? "#12141a" : "#f5f6f8"),
      colorFillAlter: cssToken("--tool-bg", dark ? "#20242c" : "#f2f3f5"),
      borderRadius: cssNumber("--radius-sm", 6),
      borderRadiusLG: cssNumber("--radius-md", 10),
      fontFamily: cssToken(
        "--font-ui",
        '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      ),
      fontSize: cssNumber("--text-md", 14),
      fontSizeSM: cssNumber("--text-sm", 13),
      lineHeight: cssNumber("--leading", 1.6),
      // The provider defaults to small; Ant otherwise keeps a separate 24px
      // height while our button adapter and native fields use theme geometry.
      controlHeight: cssNumber("--control-height", 32),
      controlHeightSM: cssNumber("--control-height", 32),
    },
    components: {
      Alert: { borderRadiusLG: cssNumber("--radius-md", 10) },
      Button: {
        fontWeight: cssNumber("--control-weight", 550),
        borderRadius: cssNumber("--radius-sm", 6),
        controlHeight: cssNumber("--control-height", 32),
      },
      Card: {
        bodyPadding: cssNumber("--card-padding", 16),
        headerHeight: cssNumber("--card-header-height", 42),
        borderRadiusLG: cssNumber("--radius-md", 10),
      },
      Checkbox: { colorPrimary: cssToken("--accent", dark ? "#60a5fa" : "#2563eb") },
      Descriptions: { labelBg: cssToken("--tool-bg", dark ? "#20242c" : "#f2f3f5") },
      Drawer: { colorBgElevated: cssToken("--card", dark ? "#1b1e24" : "#ffffff") },
      Form: { labelColor: cssToken("--muted", dark ? "#9aa1ad" : "#68707c") },
      Input: {
        activeBorderColor: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
        hoverBorderColor: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
      },
      Modal: {
        borderRadiusLG: cssNumber("--radius-md", 10),
        paddingContentHorizontalLG: cssNumber("--modal-padding", 20),
      },
      Pagination: { itemActiveBg: cssToken("--accent-soft", dark ? "#17233a" : "#eef4ff") },
      Select: {
        optionSelectedBg: cssToken("--accent-soft", dark ? "#17233a" : "#eef4ff"),
        optionSelectedColor: cssToken("--fg", dark ? "#e5e7eb" : "#1c1e21"),
        selectorBg: cssToken("--card", dark ? "#1b1e24" : "#ffffff"),
      },
      Skeleton: {
        gradientFromColor: cssToken("--tool-bg", dark ? "#20242c" : "#f2f3f5"),
        gradientToColor: cssToken("--line", dark ? "#333842" : "#e3e5e8"),
      },
      Table: {
        cellPaddingBlockSM: cssNumber("--table-row-padding", 8),
        cellPaddingInlineSM: cssNumber("--table-cell-padding", 10),
        headerBg: cssToken("--tool-bg", dark ? "#20242c" : "#f2f3f5"),
        rowHoverBg: cssToken("--accent-soft", dark ? "#17233a" : "#eef4ff"),
      },
      Tabs: {
        inkBarColor: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
        itemSelectedColor: cssToken("--accent", dark ? "#60a5fa" : "#2563eb"),
      },
      Tag: { borderRadiusSM: 999 },
      Tooltip: { colorBgSpotlight: cssToken("--fg", dark ? "#e5e7eb" : "#1c1e21") },
    },
  };
}

export function DashboardUiProvider({ children }: { children: ReactNode }) {
  const themeId = useSyncExternalStore<string>(subscribeTheme, currentTheme, currentTheme);
  const language = useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
  const dark = useSyncExternalStore(subscribeColorScheme, currentColorScheme, () => "light") === "dark";
  const theme = useMemo(() => dashboardAntTheme(themeId, dark), [themeId, dark]);

  return (
    <StyleProvider layer>
      <ConfigProvider
        locale={dashboardAntLocale(language)}
        componentSize="small"
        button={{ autoInsertSpace: false }}
        theme={theme}
      >
        <AntApp className={styles.root}>{children}</AntApp>
      </ConfigProvider>
    </StyleProvider>
  );
}
