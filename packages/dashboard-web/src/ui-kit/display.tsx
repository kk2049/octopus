import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import type { ReactNode } from "react";
import Alert from "antd/es/alert/Alert";
import type { AlertProps } from "antd/es/alert/Alert";
import Card from "antd/es/card/Card";
import type { CardProps } from "antd/es/card/Card";
import Empty from "antd/es/empty";
import Tag from "antd/es/tag";
import type { TagProps } from "antd/es/tag";
import styles from "./primitives.module.css";

export function UiCard({ className, ...props }: CardProps) {
  return <Card size="small" className={[styles.card, className].filter(Boolean).join(" ")} {...props} />;
}

export type UiTagTone = "neutral" | "info" | "success" | "warning" | "danger";

const TAG_COLORS: Record<UiTagTone, TagProps["color"]> = {
  neutral: "default",
  info: "processing",
  success: "success",
  warning: "warning",
  danger: "error",
};

export interface UiTagProps extends Omit<TagProps, "color"> {
  tone?: UiTagTone;
}

export function UiTag({ tone = "neutral", ...props }: UiTagProps) {
  return <Tag color={TAG_COLORS[tone]} {...props} />;
}

export type UiAlertTone = NonNullable<AlertProps["type"]>;

export interface UiAlertProps extends Omit<AlertProps, "type" | "title" | "message"> {
  tone?: UiAlertTone;
  title?: ReactNode;
  children?: ReactNode;
}

export function UiAlert({ tone = "info", title, children, ...props }: UiAlertProps) {
  return <Alert type={tone} title={title} description={children} showIcon {...props} />;
}

export function UiEmpty({ children }: { children?: ReactNode }) {
  useDashboardLanguage();
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={children ?? uiText("暂无数据")} />;
}
