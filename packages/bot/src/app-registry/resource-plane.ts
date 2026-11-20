import type { RuntimeJson } from '@claude-bot/app-runtime';
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from '../app-core/instance.js';

/** Installed by trusted composition only. No runtime or View can register a provider. */
export interface DeclaredResourcePlane {
  /** Label only; callers must first establish shared membership. */
  sharedInstanceTitle?(key: string): string;
  project(binding: SessionPlusInstanceBinding, durable: RuntimeJson): RuntimeJson;
  dispatch(input: {
    binding: SessionPlusInstanceBinding;
    principal: SessionPlusPrincipal;
    action: string;
    params: Readonly<Record<string, string>>;
    current(): SessionPlusInstanceBinding | null;
    publish(): void;
    operation(value: RuntimeJson): void;
  }): Promise<{ ok: true; result: RuntimeJson } | { ok: false; message: string }>;
  close(instanceId: string, reason: string): void;
}
export type DeclaredResourceFactory = (app: string, publisher: string) => DeclaredResourcePlane | null;
