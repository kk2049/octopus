/**
 * The two helpers every conformance test of this contract needs.
 *
 * They live in the package rather than in a test fixture because they are pure
 * TypeScript — no Node, no DOM, no timers — so keeping them here costs the
 * package nothing and gives every consumer (contract tests, the bot's broker
 * tests, the vertical harness) the SAME notion of "a source that was pulled
 * twice" instead of three hand-rolled ones that count slightly differently.
 */

import type {
  ResourceStream,
  ResourceStreamMetadata,
  ResourceStreamPull,
  ResourceStreamRead,
  ResourceStreamSource,
} from "./stream.js";

export interface MemoryResourceStreamSource<T> extends ResourceStreamSource<T> {
  /** How many times the producer was actually asked for something. */
  readonly pulls: number;
  /** How many times it was released. The guard must make this at most one. */
  readonly closes: number;
}

/**
 * A pull source that answers from a script.
 *
 * Running off the end answers `end`, so a test that forgets the terminal still
 * terminates rather than hanging. `pulls` and `closes` are what make "one pull
 * triggered at most one read" and "cancel released it exactly once" assertable.
 */
export function memoryResourceStreamSource<T>(
  script: readonly ResourceStreamPull<T>[],
  metadata: Partial<ResourceStreamMetadata> = {},
): MemoryResourceStreamSource<T> {
  let pulls = 0;
  let closes = 0;
  let index = 0;
  const meta: ResourceStreamMetadata = {
    payload: metadata.payload ?? "test/v1#chunk",
    mediaType: metadata.mediaType ?? "text/plain; charset=utf-8",
    ...(metadata.totalBytes === undefined ? {} : { totalBytes: metadata.totalBytes }),
    ...(metadata.digest === undefined ? {} : { digest: metadata.digest }),
  };
  return {
    metadata: meta,
    get pulls() {
      return pulls;
    },
    get closes() {
      return closes;
    },
    async pull(): Promise<ResourceStreamPull<T>> {
      pulls += 1;
      return index < script.length ? script[index++] : { kind: "end" };
    },
    close(): void {
      closes += 1;
    },
  };
}

export interface DrainedResourceStream<T> {
  chunks: T[];
  seqs: number[];
  terminal: ResourceStreamRead<T>;
}

/**
 * Pull to the terminal answer, one at a time.
 *
 * Deliberately serial: pulling in parallel is a contract violation, so a helper
 * that did it would make every consumer's happy path exercise the wrong thing.
 */
export async function drainResourceStream<T>(
  stream: ResourceStream<T>,
  // A test bound, not a contract one: streams themselves have no total cap,
  // and a fixture that never terminates must fail rather than hang the suite.
  maxReads = 65_536,
): Promise<DrainedResourceStream<T>> {
  const chunks: T[] = [];
  const seqs: number[] = [];
  for (let i = 0; i < maxReads; i += 1) {
    const read = await stream.next();
    if (read.kind !== "chunk") return { chunks, seqs, terminal: read };
    chunks.push(read.value);
    seqs.push(read.seq);
  }
  return {
    chunks,
    seqs,
    terminal: { kind: "refused", code: "protocol", message: "drain exceeded maxReads" },
  };
}
