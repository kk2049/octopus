import { randomBytes } from "node:crypto";
import type { RunnerCapabilities } from "./capability.js";
import { hashRunnerToken } from "./gateway.js";
import { RUNNER_GUEST_PROVIDERS, type RunnerEnrollmentRow, type RunnerGuestProvider, type Store } from "../store/store.js";

export const RUNNER_ENROLLMENT_TTL_MS = 10 * 60_000;

type EnrollmentStore = Pick<Store, "saveRunnerEnrollment" | "consumeRunnerEnrollment">;
type EnrollmentCaps = Pick<RunnerCapabilities, "mintDeviceToken">;

export interface RunnerEnrollment {
  code: string;
  username: string;
  device: string;
  expires_at: string;
}

export function issueRunnerEnrollment(
  store: EnrollmentStore,
  username: string,
  device: string,
  now = new Date(),
): RunnerEnrollment {
  const normalized = device.trim().slice(0, 32);
  if (!normalized) throw new Error("device is required");
  const code = `re_${randomBytes(24).toString("hex")}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RUNNER_ENROLLMENT_TTL_MS).toISOString();
  store.saveRunnerEnrollment({
    code_hash: hashRunnerToken(code),
    username,
    device: normalized,
    created_at: createdAt,
    expires_at: expiresAt,
  });
  return { code, username, device: normalized, expires_at: expiresAt };
}

/**
 * A guest installer travels as a file (chat, USB stick), so its one-shot code
 * lives for days instead of minutes. It is still single use: whoever installs
 * first gets the device credential, and the copy left in a download folder is
 * dead after that.
 */
export const RUNNER_GUEST_ENROLLMENT_TTL_MS = { default: 7 * 24 * 60 * 60_000, max: 30 * 24 * 60 * 60_000 } as const;
export const RUNNER_GUEST_DEVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

type GuestEnrollmentStore = EnrollmentStore
  & Pick<Store, "getRunnerGuestProfile" | "saveRunnerGuestProfile" | "listRunnerTokens">;

export interface RunnerGuestEnrollmentRequest {
  username: string;
  /** New guest device name, under `username`. */
  device: string;
  /** The requesting device: it will serve model egress for the guest. */
  modelHost: string;
  providers: readonly RunnerGuestProvider[];
  ttlMs?: number;
}

/**
 * Create (or re-issue) a guest device: its server-side profile first, then a
 * long-lived single-use enrollment. An existing ordinary device name is
 * refused, so packing a guest can never demote a device that already works.
 */
export function issueGuestEnrollment(
  store: GuestEnrollmentStore,
  request: RunnerGuestEnrollmentRequest,
  now = new Date(),
): RunnerEnrollment & { model_host: string; providers: RunnerGuestProvider[] } {
  const device = request.device.trim();
  if (!RUNNER_GUEST_DEVICE.test(device)) throw new GuestEnrollmentError(400, "访客设备名只能用 1–32 个字母、数字、点、下划线或连字符，且以字母或数字开头");
  if (device === request.modelHost) throw new GuestEnrollmentError(400, "访客设备不能与模型主机同名");
  const providers = RUNNER_GUEST_PROVIDERS.filter((provider) => request.providers.includes(provider));
  if (!providers.length || providers.length !== new Set(request.providers).size) {
    throw new GuestEnrollmentError(400, "providers 只能是 anthropic、openai 或两者");
  }
  const existingGuest = store.getRunnerGuestProfile(request.username, device);
  const existingDevice = store.listRunnerTokens(request.username).some((row) => row.device === device);
  if (existingDevice && !existingGuest) {
    throw new GuestEnrollmentError(409, `设备名 ${device} 已是普通设备，访客请换一个名字`);
  }
  if (store.getRunnerGuestProfile(request.username, request.modelHost)) {
    throw new GuestEnrollmentError(403, "访客设备不能为别的访客签发安装包");
  }
  const ttl = Math.min(RUNNER_GUEST_ENROLLMENT_TTL_MS.max, Math.max(10 * 60_000, request.ttlMs ?? RUNNER_GUEST_ENROLLMENT_TTL_MS.default));
  store.saveRunnerGuestProfile({
    username: request.username,
    device,
    model_host: request.modelHost,
    providers: providers.join(","),
    created_at: now.toISOString(),
    created_by: `device:${request.modelHost}`,
  });
  const code = `re_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  store.saveRunnerEnrollment({
    code_hash: hashRunnerToken(code),
    username: request.username,
    device,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });
  return { code, username: request.username, device, expires_at: expiresAt, model_host: request.modelHost, providers };
}

export class GuestEnrollmentError extends Error {
  constructor(readonly status: 400 | 403 | 409, message: string) {
    super(message);
  }
}

/** Parse the stored canonical provider list; anything else is no provider. */
export function guestProviders(value: string | undefined): RunnerGuestProvider[] {
  const parts = (value ?? "").split(",");
  return RUNNER_GUEST_PROVIDERS.filter((provider) => parts.includes(provider));
}

export function redeemRunnerEnrollment(
  store: EnrollmentStore,
  caps: EnrollmentCaps,
  code: string,
  now = new Date(),
): { row: RunnerEnrollmentRow; token: string } | null {
  if (!/^re_[0-9a-f]{48}$/.test(code)) return null;
  const row = store.consumeRunnerEnrollment(hashRunnerToken(code), now.toISOString());
  if (!row) return null;
  // Consumption happens first. A capability failure costs availability and
  // never leaves a reusable bootstrap credential beside partial authority.
  const token = caps.mintDeviceToken(row.username, row.device);
  return { row, token };
}
