import { AccountQuota as SharedAccountQuota } from "@claude-bot/chat-ui-commons/quota";
import type { ComponentProps } from "react";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";

export function AccountQuota(props: Omit<ComponentProps<typeof SharedAccountQuota>, "words">) {
  useDashboardLanguage();
  return <SharedAccountQuota {...props} words={{
    unknown: uiText("额度未知"), cached: uiText("缓存值"),
    remaining: (value) => uiText("剩余 {v0}%", { v0: value }),
    reset: (absolute) => uiText(" · 重置时间 {v0}", { v0: absolute }).replace(/^ · /, ""),
  }} />;
}
