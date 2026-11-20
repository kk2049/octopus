import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerTentacleTransport, TentaclePeer } from "../runner/gateway.js";
import { TentacleBroker } from "./broker.js";
import type { TentacleWireMessage } from "./protocol.js";

class ControlledTransport implements RunnerTentacleTransport {
  private listener: ((peer: TentaclePeer, message: unknown) => void | Promise<void>) | null = null;
  readonly sent: unknown[] = [];

  constructor(private readonly deliverable: boolean) {}

  onMessage(listener: (peer: TentaclePeer, message: unknown) => void | Promise<void>): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  send(_username: string, _device: string, message: unknown): boolean {
    this.sent.push(message);
    return this.deliverable;
  }

  listDevices(): string[] {
    return this.deliverable ? ["dsh:target"] : [];
  }

  disconnect(): boolean {
    return false;
  }

  disconnectCredential(): number {
    return 0;
  }
}

function invoke(broker: TentacleBroker): Promise<unknown> {
  return broker.invokeTool({
    source: { username: "source", device: "dsh:source" },
    target: { username: "target", device: "dsh:target" },
    objectId: "tentacle-tool-v1:test",
    sourceSeq: 1,
    tool: "bash",
    args: { command: "true" },
  });
}

describe("TentacleBroker tool failure convergence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails immediately when delivery is offline and retires the reply timer", async () => {
    vi.useFakeTimers();
    const broker = new TentacleBroker(new ControlledTransport(false));

    await expect(invoke(broker)).rejects.toThrow("target target/dsh:target is offline");
    expect(vi.getTimerCount()).toBe(0);

    broker.close();
  });

  it("observes both pending rejections when the broker closes", async () => {
    vi.useFakeTimers();
    const broker = new TentacleBroker(new ControlledTransport(true));
    const assertion = expect(invoke(broker)).rejects.toThrow("tentacle broker closed");

    broker.close();
    await assertion;
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts Head control frames in a bounded process epoch and increments within it", () => {
    const transport = new ControlledTransport(true);
    const broker = new TentacleBroker(transport);
    const target = { username: "target", device: "dsh:target" };

    expect(broker.sendControl(target, "tentacle-tool-v1:test", "projection.stop", {})).toBe(true);
    expect(broker.sendControl(target, "tentacle-tool-v1:test", "projection.stop", {})).toBe(true);

    const [first, second] = transport.sent as TentacleWireMessage[];
    expect(first.seq).toBeGreaterThanOrEqual(1);
    expect(first.seq).toBeLessThan(2 ** 48);
    expect(Number.isSafeInteger(first.seq)).toBe(true);
    expect(second.seq).toBe(first.seq + 1);

    broker.close();
  });
});
