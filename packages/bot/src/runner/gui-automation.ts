/**
 * Separate capability Object for a Runner's physical macOS GUI.
 *
 * This intentionally does not widen `runner-account-v9`. The resource has its
 * own operation vocabulary, root, slot and revocation line while reusing the
 * one already-claimed Runner transport. Dashboard exposure is a discoverability
 * prerequisite; target-local consent is the mandatory runtime gate.
 */

import type {
  CapabilityService,
  ContextId,
  ObjectDefinition,
  Operation,
  OperationSpec,
  PolicyInput,
} from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import type { RunnerLocalAgentBridgeLease, RunnerTransport } from "./gateway.js";
import type { RunnerDevicePolicyRow, Store } from "../store/store.js";
import { AccountAuthority, SlotGrant } from "./account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "./dispatch.js";

export const RUNNER_GUI_AUTOMATION_SLOT = "runner_gui_automation";
export const RUNNER_GUI_AUTOMATION_OBJECT_PREFIX = "runner-gui-automation-v1";

const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;
const GRANT_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.guiGrantIdMaxBytes } as const;
const COORDINATE_ARG = {
  type: "number",
  required: true,
  min: 0,
  max: MACHINE_LIMITS.guiCoordinateMax,
} as const;

export const RUNNER_GUI_AUTOMATION_OPERATIONS: Record<string, OperationSpec> = {
  gui_request_control: {
    args: {
      device: DEVICE_ARG,
      controller_label: {
        type: "string",
        required: true,
        maxLength: MACHINE_LIMITS.guiControllerLabelMaxBytes,
      },
    },
    effect: "execute",
    retrySafe: false,
    title: "请求目标 Mac 本地授权",
  },
  gui_capture_screen: {
    args: { device: DEVICE_ARG, grant_id: GRANT_ARG },
    effect: "read",
    retrySafe: true,
    title: "截取目标 Mac 主屏幕",
  },
  gui_click: {
    args: {
      device: DEVICE_ARG,
      grant_id: GRANT_ARG,
      x: COORDINATE_ARG,
      y: COORDINATE_ARG,
      button: { type: "string", enum: ["left", "right"] },
      click_count: { type: "number", min: 1, max: MACHINE_LIMITS.guiClickCountMax, integer: true },
    },
    effect: "execute",
    retrySafe: false,
    title: "点击目标 Mac 屏幕",
  },
  gui_scroll: {
    args: {
      device: DEVICE_ARG,
      grant_id: GRANT_ARG,
      x: COORDINATE_ARG,
      y: COORDINATE_ARG,
      direction: { type: "string", required: true, enum: ["up", "down", "left", "right"] },
      amount: { type: "number", min: 1, max: MACHINE_LIMITS.guiScrollAmountMax, integer: true },
    },
    effect: "execute",
    retrySafe: false,
    title: "滚动目标 Mac 屏幕",
  },
  gui_drag: {
    args: {
      device: DEVICE_ARG,
      grant_id: GRANT_ARG,
      from_x: COORDINATE_ARG,
      from_y: COORDINATE_ARG,
      to_x: COORDINATE_ARG,
      to_y: COORDINATE_ARG,
      duration_ms: {
        type: "number",
        min: 100,
        max: MACHINE_LIMITS.guiDragDurationMaxMs,
        integer: true,
      },
    },
    effect: "execute",
    retrySafe: false,
    title: "拖动目标 Mac 指针",
  },
  gui_type_text: {
    args: {
      device: DEVICE_ARG,
      grant_id: GRANT_ARG,
      text: { type: "string", required: true, maxLength: MACHINE_LIMITS.guiTypeTextMaxBytes },
    },
    effect: "execute",
    retrySafe: false,
    title: "向目标 Mac 输入文字",
  },
  gui_key_press: {
    args: {
      device: DEVICE_ARG,
      grant_id: GRANT_ARG,
      key: {
        type: "string",
        required: true,
        enum: [
          "enter", "tab", "escape", "backspace", "delete", "space",
          "arrow_up", "arrow_down", "arrow_left", "arrow_right",
          "home", "end", "page_up", "page_down",
        ],
      },
      modifier_command: { type: "boolean" },
      modifier_control: { type: "boolean" },
      modifier_option: { type: "boolean" },
      modifier_shift: { type: "boolean" },
    },
    effect: "execute",
    retrySafe: false,
    title: "向目标 Mac 发送按键",
  },
  gui_release_control: {
    args: { device: DEVICE_ARG, grant_id: GRANT_ARG },
    effect: "execute",
    retrySafe: true,
    title: "结束目标 Mac 远程操作",
  },
};

export const RUNNER_GUI_BRIDGE_TOOLS = [
  "capture_screen",
  "click",
  "scroll",
  "drag",
  "type_text",
  "key_press",
] as const;
export type RunnerGuiBridgeTool = (typeof RUNNER_GUI_BRIDGE_TOOLS)[number];

export interface RunnerGuiAutomationTarget {
  device: string;
  online: true;
  gui_automation: {
    protocol: "runner-macos-gui/v1";
    requires_local_consent: true;
    consent_ttl_seconds: 900;
    display: "main";
    actions: readonly RunnerGuiBridgeTool[];
  };
}

export interface RunnerGuiAutomationToggleResult {
  changed: boolean;
  code?: "runner_not_found" | "gui_automation_unavailable";
  onlineApplied?: boolean;
}

interface RunnerGuiBinding extends RunnerDispatchBinding {}

class RunnerGuiGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, purpose: string, owner: string) {
    super(service, contextId, RUNNER_GUI_AUTOMATION_SLOT, purpose, owner);
  }
}

class LiveGuiLease implements RunnerLocalAgentBridgeLease {
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly owner: RunnerGuiAutomationCapabilities,
    private readonly grant: RunnerGuiGrant,
    readonly username: string,
    readonly targetDevice: string,
    readonly controllerDevice: string,
    readonly grantId: string,
    readonly expiresAt: number,
  ) {
    this.timer = setTimeout(() => this.close(), Math.max(1, expiresAt - owner.nowMs()));
    this.timer.unref?.();
  }

  get description(): Readonly<Record<string, unknown>> {
    return {
      granted: true,
      requires_local_consent: true,
      consent_ttl_seconds: 900,
      expires_at: new Date(this.expiresAt).toISOString(),
    };
  }

  async call(tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed || this.owner.nowMs() >= this.expiresAt) {
      this.close();
      throw new Error("the target Mac GUI control lease expired; request local permission again");
    }
    if (!this.owner.targetEnabled(this.username, this.targetDevice)) {
      this.close();
      throw new Error("GUI automation is no longer enabled for this Runner");
    }
    if (!(RUNNER_GUI_BRIDGE_TOOLS as readonly string[]).includes(tool)) {
      throw new Error("tool is outside the GUI automation capability surface");
    }
    const operation = `gui_${tool}`;
    return await this.grant.call(operation, {
      ...args,
      device: this.targetDevice,
      grant_id: this.grantId,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.owner.forget(this);
    void this.grant.call("gui_release_control", {
      device: this.targetDevice,
      grant_id: this.grantId,
    }).catch(() => undefined).finally(() => this.grant.destroy());
  }
}

export class RunnerGuiAutomationCapabilities {
  private readonly authority: AccountAuthority<RunnerGuiBinding>;
  private readonly leases = new Set<LiveGuiLease>();
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly transport: RunnerTransport,
    service: CapabilityService,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.authority = new AccountAuthority<RunnerGuiBinding>({
      service,
      slot: RUNNER_GUI_AUTOMATION_SLOT,
      objectPrefix: RUNNER_GUI_AUTOMATION_OBJECT_PREFIX,
      kind: "runner-gui-automation",
      operations: RUNNER_GUI_AUTOMATION_OPERATIONS,
      policy: guiAutomationPolicy,
      scopeAllows: (device, input) => input.args.device === device,
      adapter: guiAutomationAdapter as ObjectDefinition<RunnerGuiBinding>["adapter"],
      now: options.now,
      rootAutoAllow: () => Object.keys(RUNNER_GUI_AUTOMATION_OPERATIONS),
      bindingFor: (username) =>
        this.store.getUser(username)
          && this.store.listRunnerTokens(username).some((row) => !row.device.startsWith("dsh:"))
          ? { owner: username, transport: this.transport }
          : null,
    });
  }

  nowMs(): number {
    return this.now();
  }

  ensureAccount(username: string): boolean {
    return this.authority.authorityFor(username) !== null;
  }

  listTargets(username: string): RunnerGuiAutomationTarget[] {
    return this.transport.listDevices(username).flatMap((row) => {
      if (!row.online || !row.inventory?.gui_automation?.available || !this.policy(username, row.device)?.gui_automation_enabled) {
        return [];
      }
      return [{
        device: row.device,
        online: true as const,
        gui_automation: {
          protocol: "runner-macos-gui/v1" as const,
          requires_local_consent: true as const,
          consent_ttl_seconds: 900 as const,
          display: "main" as const,
          actions: RUNNER_GUI_BRIDGE_TOOLS,
        },
      }];
    });
  }

  targetEnabled(username: string, device: string): boolean {
    return this.listTargets(username).some((target) => target.device === device);
  }

  async open(input: {
    username: string;
    controllerDevice: string;
    targetDevice: string;
  }): Promise<RunnerLocalAgentBridgeLease> {
    if (!input.controllerDevice || input.controllerDevice === input.targetDevice) {
      throw new Error("GUI automation requires a different target Runner");
    }
    if (!this.targetEnabled(input.username, input.targetDevice)) {
      throw new Error(`Runner ${input.targetDevice} is offline, unsupported, or not exposed for GUI automation`);
    }
    const purpose = `Runner local Agent GUI · ${input.controllerDevice} → ${input.targetDevice}`;
    const derived = this.authority.derive({
      username: input.username,
      purpose,
      kind: "agent-run",
      rights: Object.keys(RUNNER_GUI_AUTOMATION_OPERATIONS),
      autoAllow: Object.keys(RUNNER_GUI_AUTOMATION_OPERATIONS),
      metadata: { gui_device_scope: input.targetDevice, controller_device: input.controllerDevice },
      scope: input.targetDevice,
    });
    if (!derived) throw new Error("GUI automation authority is unavailable");
    const grant = new RunnerGuiGrant(this.authority.service, derived.contextId, purpose, input.username);
    try {
      const result = await grant.call("gui_request_control", {
        device: input.targetDevice,
        controller_label: `Octopus Agent on ${input.controllerDevice}`,
      });
      const opened = parseOpenedGrant(result, this.now());
      if (!opened) throw new Error("the user on the target Mac denied or did not answer the control request");
      if (!this.targetEnabled(input.username, input.targetDevice)) {
        void grant.call("gui_release_control", {
          device: input.targetDevice,
          grant_id: opened.grantId,
        }).catch(() => undefined);
        throw new Error("GUI automation was disabled while local consent was pending");
      }
      const lease = new LiveGuiLease(
        this,
        grant,
        input.username,
        input.targetDevice,
        input.controllerDevice,
        opened.grantId,
        opened.expiresAt,
      );
      this.leases.add(lease);
      return lease;
    } catch (error) {
      grant.destroy();
      throw error;
    }
  }

  setEnabled(
    username: string,
    device: string,
    enabled: boolean,
    updatedAt: string,
    updatedBy: string,
  ): RunnerGuiAutomationToggleResult {
    const known = this.transport.listDevices(username).find((row) => row.device === device);
    if (!known) return { changed: false, code: "runner_not_found" };
    if (enabled && (!known.online || !known.inventory?.gui_automation?.available)) {
      return { changed: false, code: "gui_automation_unavailable" };
    }
    const changed = this.store.setRunnerGuiAutomationEnabled(username, device, enabled, updatedAt, updatedBy);
    if (!changed) return { changed: false, code: "runner_not_found" };

    // Publish the target-local kill switch immediately. The target controller
    // owns the floating indicator and tears it down synchronously on `false`.
    const onlineApplied = this.transport.setGuiAutomationEnabled?.(username, device, enabled) ?? false;
    if (!enabled) this.closeTarget(username, device);
    // Grants are exact-device Contexts and every use re-checks targetEnabled.
    // Keep unrelated target leases alive; the selected target is revoked above.
    return { changed: true, onlineApplied };
  }

  closeTarget(username: string, device: string): number {
    const selected = [...this.leases].filter((lease) =>
      lease.username === username && lease.targetDevice === device);
    for (const lease of selected) lease.close();
    return selected.length;
  }

  revokeAccount(username: string): void {
    for (const lease of [...this.leases]) if (lease.username === username) lease.close();
    this.authority.revokeAccount(username);
  }

  revokeDevice(username: string, device: string): void {
    for (const lease of [...this.leases]) {
      if (lease.username === username && (lease.targetDevice === device || lease.controllerDevice === device)) lease.close();
    }
    this.authority.revokeScope(username, device);
  }

  forget(lease: LiveGuiLease): void {
    this.leases.delete(lease);
  }

  private policy(username: string, device: string): RunnerDevicePolicyRow | undefined {
    return this.store.getRunnerDevicePolicy(username, device);
  }
}

function guiAutomationPolicy(input: PolicyInput): import("@claude-bot/capability-kernel").PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "GUI automation object has no bound owner" };
  const target = input.context.metadata.gui_device_scope;
  if (!target || String(input.args.device ?? "") !== target) {
    return { kind: "deny", reason: "GUI automation grant is bound to a different Runner" };
  }
  // Dashboard approvals are intentionally not a fallback here. The target Mac
  // consent dialog is the only approval surface for this short-lived resource.
  return input.terms.autoAllow.includes(input.operation)
    ? { kind: "allow" }
    : { kind: "deny", reason: "GUI automation requires a target-local consent lease" };
}

async function guiAutomationAdapter(
  binding: RunnerGuiBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return await dispatchToRunner(binding, operation, args, {
    indeterminateOnLinkLoss:
      RUNNER_GUI_AUTOMATION_OPERATIONS[operation]?.effect === "execute"
      && operation !== "gui_release_control",
  });
}

function parseOpenedGrant(value: unknown, now: number): { grantId: string; expiresAt: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.granted !== true) return null;
  const grantId = typeof row.grant_id === "string" ? row.grant_id : "";
  const expiresAt = Date.parse(String(row.expires_at ?? ""));
  if (
    !/^gui_[0-9a-f]{32}$/.test(grantId)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt > now + MACHINE_LIMITS.guiControlTtlMs + 5_000
  ) {
    throw new Error("target Mac returned a malformed GUI control lease");
  }
  return { grantId, expiresAt };
}
