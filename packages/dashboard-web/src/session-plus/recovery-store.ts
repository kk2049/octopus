import { VIEW_RECOVERY_BYTES } from "@claude-bot/web-trust/frame-protocol";

const STORAGE_PREFIX = "octopus-session-plus-recovery-v1";

export interface SessionPlusRecoveryStore {
  read(): string | null;
  write(checkpoint: string): void;
}

/** One bounded last-used checkpoint per account and App in this browser.
 * Storage access itself can throw (not just getItem); keep that failure inside
 * this seam. Legacy tab checkpoints migrate only when no durable value exists.
 */
type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;
type StorageSource = RecoveryStorage | (() => RecoveryStorage);
function storageOf(source: StorageSource): RecoveryStorage { return typeof source === "function" ? source() : source; }

export function createSessionPlusRecoveryStore(input: {
  storage: StorageSource;
  legacyStorage?: StorageSource;
  account: string | null;
  app: string;
}): SessionPlusRecoveryStore {
  const key = input.account
    ? `${STORAGE_PREFIX}:${encodeURIComponent(input.account)}:${encodeURIComponent(input.app)}`
    : null;
  return {
    read() {
      if (!key) return null;
      try {
        const value = storageOf(input.storage).getItem(key)
          ?? (input.legacyStorage ? storageOf(input.legacyStorage).getItem(key) : null);
        return value && utf8Bytes(value) <= VIEW_RECOVERY_BYTES ? value : null;
      } catch {
        return null;
      }
    },
    write(checkpoint) {
      if (!key || typeof checkpoint !== "string" || checkpoint.length === 0) return;
      if (utf8Bytes(checkpoint) > VIEW_RECOVERY_BYTES) return;
      try {
        storageOf(input.storage).setItem(key, checkpoint);
      } catch {
        // Private mode/quota/extensions may disable storage. In-memory Host
        // retention still covers a same-page View reconstruction.
      }
    },
  };
}

function utf8Bytes(value: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(value).length : value.length * 3;
}
