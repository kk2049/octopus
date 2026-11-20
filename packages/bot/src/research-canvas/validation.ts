import { createHash, randomUUID } from "node:crypto";
import type { Json } from "@claude-bot/research-canvas-contract";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需要一个对象");
  return value as Record<string, unknown>;
}
export function parse(value: string | undefined): Record<string, unknown> {
  return object(JSON.parse(value ?? "{}"));
}
export function text(
  value: unknown,
  label: string,
  max: number,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!value.trim() && fallback === undefined)
  )
    throw new Error(`${label}无效`);
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("整数超出范围");
  return n;
}
export function coordinate(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 10_000_000
  )
    throw new Error("坐标无效");
  return value;
}
export function jsonObject(value: unknown): Record<string, Json> {
  const result = object(value ?? {});
  if (JSON.stringify(result).length > 24_000)
    throw new Error("节点数据过大，请使用文件资源");
  return result as Record<string, Json>;
}
export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID()}`;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function base64(value: string, max: number): Buffer {
  if (
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("无效的 base64 数据");
  return Buffer.from(value, "base64");
}
