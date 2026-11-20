import type { ReactNode } from "react";
import Descriptions, { type DescriptionsProps } from "antd/es/descriptions";
import Form, { type FormItemProps, type FormProps } from "antd/es/form";
import Pagination, { type PaginationProps } from "antd/es/pagination";
import Skeleton, { type SkeletonProps } from "antd/es/skeleton";
import Tabs, { type TabsProps } from "antd/es/tabs";
import Tooltip, { type TooltipProps } from "antd/es/tooltip";
import styles from "./primitives.module.css";

export const UiForm = Form;
export const UiFormItem = Form.Item as typeof Form.Item;
export type { FormItemProps as UiFormItemProps, FormProps as UiFormProps };

export function UiTabs({ className, ...props }: TabsProps) {
  return <Tabs className={[styles.tabs, className].filter(Boolean).join(" ")} {...props} />;
}

export function UiDescriptions(props: DescriptionsProps) {
  return <Descriptions size="small" bordered column={1} {...props} />;
}

export function UiTooltip({ children, ...props }: TooltipProps & { children: ReactNode }) {
  return <Tooltip {...props}>{children}</Tooltip>;
}

export function UiSkeleton({ active = true, paragraph = { rows: 2 }, ...props }: SkeletonProps) {
  return <Skeleton active={active} paragraph={paragraph} {...props} />;
}

export function UiPagination(props: PaginationProps) {
  return <Pagination size="small" hideOnSinglePage showSizeChanger={false} {...props} />;
}
