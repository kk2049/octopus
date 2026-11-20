import Table from "antd/es/table";
import type { TableProps } from "antd/es/table";
import type { ColumnType } from "antd/es/table/interface";
import styles from "./primitives.module.css";

export type UiTableColumn<Row extends object> = ColumnType<Row>;

export function UiTable<Row extends object>({
  className,
  pagination = false,
  scroll = { x: "max-content" },
  ...props
}: TableProps<Row>) {
  return (
    <Table<Row>
      size="small"
      pagination={pagination}
      scroll={scroll}
      className={[styles.table, className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
