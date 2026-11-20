import type { AgentProvider } from "./agent-runtime.js";

/**
 * Stable identity for one logical provider conversation.
 *
 * `logicalId` never changes. `currentProviderId` is the id accepted by the
 * provider now, while `lineage` retains every provider id that has named this
 * conversation. The rollout path is device-private evidence and is never part
 * of a public projection.
 */
export interface ProviderSessionRef {
  readonly logicalId: string;
  readonly currentProviderId: string;
  readonly rolloutPath?: string;
  readonly lineage: readonly string[];
}

export interface StoredProviderSessionRef extends ProviderSessionRef {
  provider: AgentProvider;
}

export interface ProviderSessionRename {
  provider: AgentProvider;
  from: string;
  to: string;
  ref: ProviderSessionRef;
}

export interface ProviderSessionRefsOptions<TAttachment> {
  restored?: readonly StoredProviderSessionRef[];
  /**
   * Called after the alias/attachment projection changes synchronously. The
   * owner uses this one edge to persist recovery state and rename runtime
   * evidence before any provider prompt is dispatched.
   */
  onRename?: (rename: ProviderSessionRename) => void | Promise<void>;
}

type MutableProviderSessionRef = {
  logicalId: string;
  currentProviderId: string;
  rolloutPath?: string;
  lineage: string[];
};

interface SessionEntry<TAttachment> {
  provider: AgentProvider;
  ref: MutableProviderSessionRef;
  attachment?: TAttachment;
}

/**
 * The sole owner of provider-id aliases and managed attachment lookup.
 *
 * Attachments are keyed by the stable ref object, not whichever provider id
 * happened to be current when they were created. A rename therefore changes
 * old-id and new-id lookup in the same synchronous step; callers never observe
 * an attachment stranded under one side of the edge.
 */
export class ProviderSessionRefs<TAttachment> {
  private readonly aliases = new Map<string, SessionEntry<TAttachment>>();
  private readonly entries = new Set<SessionEntry<TAttachment>>();
  private readonly attached = new Set<SessionEntry<TAttachment>>();
  private readonly byRef = new WeakMap<ProviderSessionRef, SessionEntry<TAttachment>>();
  private readonly onRename?: ProviderSessionRefsOptions<TAttachment>["onRename"];

  constructor(options: ProviderSessionRefsOptions<TAttachment> = {}) {
    this.onRename = options.onRename;
    for (const stored of options.restored ?? []) this.restore(stored);
  }

  reference(
    provider: AgentProvider,
    providerId: string,
    rolloutPath?: string,
  ): ProviderSessionRef {
    const id = sessionId(providerId);
    const existing = this.aliases.get(keyOf(provider, id));
    if (existing) {
      if (!existing.ref.rolloutPath && rolloutPath) existing.ref.rolloutPath = rolloutPath;
      return existing.ref;
    }
    const ref: MutableProviderSessionRef = {
      logicalId: id,
      currentProviderId: id,
      ...(rolloutPath ? { rolloutPath } : {}),
      lineage: [id],
    };
    const entry: SessionEntry<TAttachment> = { provider, ref };
    this.bind(entry);
    return ref;
  }

  restore(stored: StoredProviderSessionRef): ProviderSessionRef {
    const normalized = normalizedRef(stored);
    const aliases = boundedLineage(
      normalized.logicalId,
      normalized.currentProviderId,
      normalized.lineage,
    );
    const matches = new Set(aliases.map((id) => this.aliases.get(keyOf(stored.provider, id))).filter(Boolean));
    if (matches.size > 1) throw new Error("provider session lineage collides with multiple logical sessions");
    const existing = [...matches][0];
    if (existing) {
      existing.ref.currentProviderId = normalized.currentProviderId;
      existing.ref.lineage = boundedLineage(
        existing.ref.logicalId,
        normalized.currentProviderId,
        [...existing.ref.lineage, ...aliases],
      );
      if (!existing.ref.rolloutPath && normalized.rolloutPath) existing.ref.rolloutPath = normalized.rolloutPath;
      this.bindAliases(existing);
      return existing.ref;
    }
    const ref: MutableProviderSessionRef = { ...normalized, lineage: aliases };
    const entry: SessionEntry<TAttachment> = { provider: stored.provider, ref };
    this.bind(entry);
    return ref;
  }

  resolve(provider: AgentProvider, providerId: string): ProviderSessionRef | undefined {
    return this.aliases.get(keyOf(provider, providerId))?.ref;
  }

  attachment(provider: AgentProvider, providerId: string): TAttachment | undefined;
  attachment(ref: ProviderSessionRef): TAttachment | undefined;
  attachment(providerOrRef: AgentProvider | ProviderSessionRef, providerId?: string): TAttachment | undefined {
    const entry = typeof providerOrRef === "string"
      ? this.aliases.get(keyOf(providerOrRef, String(providerId)))
      : this.byRef.get(providerOrRef);
    return entry?.attachment;
  }

  attach(ref: ProviderSessionRef, attachment: TAttachment): void {
    const entry = this.entry(ref);
    if (entry.attachment && entry.attachment !== attachment) {
      throw new Error("provider session already has a managed attachment");
    }
    entry.attachment = attachment;
    this.attached.add(entry);
  }

  detach(ref: ProviderSessionRef, attachment: TAttachment): boolean {
    const entry = this.byRef.get(ref);
    if (!entry || entry.attachment !== attachment) return false;
    delete entry.attachment;
    this.attached.delete(entry);
    return true;
  }

  values(): TAttachment[] {
    const values: TAttachment[] = [];
    for (const entry of this.attached) if (entry.attachment) values.push(entry.attachment);
    return values;
  }

  clearAttachments(): void {
    for (const entry of this.attached) delete entry.attachment;
    this.attached.clear();
  }

  /**
   * The only provider-id rename edge. Alias lookup and attachment projection
   * change synchronously; durable/runtime participants are then advanced before
   * this promise resolves and before the caller can transfer a prompt.
   */
  async rename(provider: AgentProvider, from: string, to: string): Promise<ProviderSessionRef> {
    const sourceId = sessionId(from);
    const targetId = sessionId(to);
    const entry = this.aliases.get(keyOf(provider, sourceId));
    if (!entry) throw new Error("provider session rename source is unknown");
    const collision = this.aliases.get(keyOf(provider, targetId));
    if (collision && collision !== entry) {
      throw new Error("provider session rename target belongs to another logical session");
    }
    const previousCurrent = entry.ref.currentProviderId;
    if (previousCurrent === targetId) return entry.ref;
    if (sourceId !== previousCurrent) {
      throw new Error("provider session rename source is no longer current");
    }
    entry.ref.currentProviderId = targetId;
    entry.ref.lineage = boundedLineage(
      entry.ref.logicalId,
      targetId,
      [...entry.ref.lineage, sourceId, targetId],
    );
    this.bindAliases(entry);
    await this.onRename?.({
      provider,
      from: previousCurrent,
      to: targetId,
      ref: snapshotProviderSessionRef(entry.ref),
    });
    return entry.ref;
  }

  snapshot(ref: ProviderSessionRef): ProviderSessionRef {
    this.entry(ref);
    return snapshotProviderSessionRef(ref);
  }

  stored(): StoredProviderSessionRef[] {
    return [...this.entries].map((entry) => ({
      provider: entry.provider,
      ...snapshotProviderSessionRef(entry.ref),
    }));
  }

  private entry(ref: ProviderSessionRef): SessionEntry<TAttachment> {
    const entry = this.byRef.get(ref);
    if (!entry) throw new Error("provider session ref is not owned by this registry");
    return entry;
  }

  private bind(entry: SessionEntry<TAttachment>): void {
    this.entries.add(entry);
    this.byRef.set(entry.ref, entry);
    this.bindAliases(entry);
  }

  private bindAliases(entry: SessionEntry<TAttachment>): void {
    for (const id of uniqueIds([
      entry.ref.logicalId,
      ...entry.ref.lineage,
      entry.ref.currentProviderId,
    ])) {
      const key = keyOf(entry.provider, id);
      const collision = this.aliases.get(key);
      if (collision && collision !== entry) {
        throw new Error("provider session alias belongs to another logical session");
      }
      this.aliases.set(key, entry);
    }
  }
}

export function snapshotProviderSessionRef(ref: ProviderSessionRef): ProviderSessionRef {
  return {
    logicalId: ref.logicalId,
    currentProviderId: ref.currentProviderId,
    ...(ref.rolloutPath ? { rolloutPath: ref.rolloutPath } : {}),
    lineage: [...ref.lineage],
  };
}

/** Normalize an untrusted/durable shape to the identity module's invariants. */
export function normalizeProviderSessionRef(ref: ProviderSessionRef): ProviderSessionRef {
  return snapshotProviderSessionRef(normalizedRef(ref));
}

function normalizedRef(ref: ProviderSessionRef): MutableProviderSessionRef {
  const logicalId = sessionId(ref.logicalId);
  const currentProviderId = sessionId(ref.currentProviderId);
  return {
    logicalId,
    currentProviderId,
    ...(ref.rolloutPath ? { rolloutPath: ref.rolloutPath } : {}),
    lineage: boundedLineage(logicalId, currentProviderId, ref.lineage.map(sessionId)),
  };
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function boundedLineage(logicalId: string, currentProviderId: string, values: readonly string[]): string[] {
  const middle = uniqueIds(values)
    .filter((id) => id !== logicalId && id !== currentProviderId)
    .slice(-62);
  return uniqueIds([logicalId, ...middle, currentProviderId]);
}

function sessionId(value: string): string {
  const clean = value.trim().slice(0, 256);
  if (!clean) throw new Error("provider session id is invalid");
  return clean;
}

function keyOf(provider: AgentProvider, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}
