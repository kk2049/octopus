/** Narrow consumer surfaces and readers for the G4/G5 contracts. */
import {
  IssueBag,
  boundedIntAt,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractBound,
  type ContractResult,
  type PortReply,
} from "@claude-bot/typed-port-kit";

import {
  APP_REGISTRY_ADMIN_CONTRACT,
  APP_REGISTRY_ADMIN_REFUSALS,
  SESSION_HARNESS_LAUNCH_CONTRACT,
  SESSION_HARNESS_LAUNCH_REFUSALS,
  type AppRegistryAdminRefusalCode,
  type SessionHarnessLaunchRefusalCode,
} from "./port-types.js";
import { CONVERGENCE_CONTRACT_LIMITS } from "./contracts.js";

export interface SessionHarnessLaunchIntent {
  rid: string;
  sessionRef: string;
  intentRef: string;
  state: "ready" | "offline" | "unknown";
}

export interface SessionHarnessLaunchPort extends ContractBound<typeof SESSION_HARNESS_LAUNCH_CONTRACT> {
  openSession(sessionRef: string, rid: string): Promise<PortReply<SessionHarnessLaunchIntent, SessionHarnessLaunchRefusalCode>>;
}

export interface AppRegistryAppSummary {
  appId: string;
  publisher: string;
  activeDigest: string | null;
  releaseCount: number;
  compatibility: "supported" | "incompatible" | "unknown";
  runtimeHealth: "healthy" | "degraded" | "offline" | "unknown";
}

export interface AppRegistryDirectoryProjection {
  revision: number;
  apps: AppRegistryAppSummary[];
  reconcile: {
    activeUnusable: number;
    installedUnusable: number;
    undescribable: number;
    orphanContent: number;
  };
}

export interface AppRegistryMutationReceipt {
  operation: string;
  appId: string;
  packageDigest: string | null;
  revision: number;
  status: "applied" | "unchanged";
}

type RegistryReply<T> = PortReply<T, AppRegistryAdminRefusalCode>;

export interface AppRegistryAdminPort extends ContractBound<typeof APP_REGISTRY_ADMIN_CONTRACT> {
  list(rid: string, cursor: string | undefined, limit: number): Promise<RegistryReply<AppRegistryDirectoryProjection>>;
  describe(rid: string, appId: string): Promise<RegistryReply<AppRegistryAppSummary>>;
  declare(rid: string, opId: string, appId: string, packageDigest: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  install(rid: string, opId: string, appId: string, packageDigest: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  activate(rid: string, opId: string, appId: string, packageDigest: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  deactivate(rid: string, opId: string, appId: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  uninstall(rid: string, opId: string, appId: string, packageDigest: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  rollback(rid: string, opId: string, appId: string, packageDigest: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
  approveHotswap(rid: string, opId: string, appId: string, packageDigest: string, approvalRef: string): Promise<RegistryReply<AppRegistryMutationReceipt>>;
}

const LAUNCH_FIELDS = ["rid", "sessionRef", "intentRef", "state"] as const;
const APP_FIELDS = ["appId", "publisher", "activeDigest", "releaseCount", "compatibility", "runtimeHealth"] as const;
const DIRECTORY_FIELDS = ["revision", "apps", "reconcile"] as const;
const RECONCILE_FIELDS = ["activeUnusable", "installedUnusable", "undescribable", "orphanContent"] as const;
const RECEIPT_FIELDS = ["operation", "appId", "packageDigest", "revision", "status"] as const;
const REF = /^[A-Za-z][A-Za-z0-9_.:-]{7,199}$/;
const RID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const APP = /^[a-z][a-z0-9-]{0,95}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function readSessionHarnessLaunchIntent(value: unknown, at = "launch"): ContractResult<SessionHarnessLaunchIntent> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, LAUNCH_FIELDS, at);
  const rid = boundedStringAt(bag, row, "rid", at, CONVERGENCE_CONTRACT_LIMITS.requestId);
  const sessionRef = boundedStringAt(bag, row, "sessionRef", at, CONVERGENCE_CONTRACT_LIMITS.opaqueRef);
  const intentRef = boundedStringAt(bag, row, "intentRef", at, CONVERGENCE_CONTRACT_LIMITS.opaqueRef);
  const state = boundedStringAt(bag, row, "state", at, 7);
  if (rid !== null && !RID.test(rid)) bag.add("identifier", "rid is not opaque", `${at}.rid`);
  if (sessionRef !== null && !REF.test(sessionRef)) bag.add("identifier", "sessionRef is not opaque", `${at}.sessionRef`);
  if (intentRef !== null && !REF.test(intentRef)) bag.add("identifier", "intentRef is not opaque", `${at}.intentRef`);
  if (state !== null && !["ready", "offline", "unknown"].includes(state)) bag.add("schema", "state is not closed", `${at}.state`);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { rid: rid!, sessionRef: sessionRef!, intentRef: intentRef!, state: state! as SessionHarnessLaunchIntent["state"] } };
}

export function readAppRegistryDirectory(value: unknown, at = "directory"): ContractResult<AppRegistryDirectoryProjection> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DIRECTORY_FIELDS, at);
  const revision = boundedIntAt(bag, row, "revision", at, CONVERGENCE_CONTRACT_LIMITS.revision);
  const apps: AppRegistryAppSummary[] = [];
  if (!Array.isArray(row.apps)) bag.add("field_type", "apps must be an array", `${at}.apps`);
  else if (row.apps.length > 100) bag.add("limit", "apps exceeds 100 entries", `${at}.apps`);
  else for (let index = 0; index < row.apps.length; index += 1) {
    const app = readApp(row.apps[index], `${at}.apps[${index}]`);
    if (app.ok) apps.push(app.value);
    else for (const issue of app.issues) bag.add(issue.code, issue.message, issue.at);
  }
  const reconcileRow = objectAt(bag, row.reconcile, `${at}.reconcile`);
  let reconcile: AppRegistryDirectoryProjection["reconcile"] | null = null;
  if (reconcileRow) {
    refuseUnknownFields(bag, reconcileRow, RECONCILE_FIELDS, `${at}.reconcile`);
    const counts = RECONCILE_FIELDS.map((field) => boundedIntAt(bag, reconcileRow, field, `${at}.reconcile`, 1_000_000));
    if (counts.every((count) => count !== null)) {
      reconcile = { activeUnusable: counts[0]!, installedUnusable: counts[1]!, undescribable: counts[2]!, orphanContent: counts[3]! };
    }
  }
  if (!bag.empty || !reconcile) return bag.fail();
  return { ok: true, value: { revision: revision!, apps, reconcile } };
}

export function readAppRegistryMutationReceipt(value: unknown, at = "receipt"): ContractResult<AppRegistryMutationReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, RECEIPT_FIELDS, at);
  const operation = boundedStringAt(bag, row, "operation", at, 32);
  const appId = boundedStringAt(bag, row, "appId", at, 96);
  const digest = row.packageDigest === null ? null : boundedStringAt(bag, row, "packageDigest", at, 64);
  const revision = boundedIntAt(bag, row, "revision", at, CONVERGENCE_CONTRACT_LIMITS.revision);
  const status = boundedStringAt(bag, row, "status", at, 9);
  if (operation !== null && !/^[a-z][a-z0-9_]{0,31}$/.test(operation)) bag.add("identifier", "operation is not closed", `${at}.operation`);
  if (appId !== null && !APP.test(appId)) bag.add("identifier", "appId is invalid", `${at}.appId`);
  if (digest !== null && !DIGEST.test(digest)) bag.add("identifier", "packageDigest is invalid", `${at}.packageDigest`);
  if (status !== null && !["applied", "unchanged"].includes(status)) bag.add("schema", "status is not closed", `${at}.status`);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { operation: operation!, appId: appId!, packageDigest: digest, revision: revision!, status: status! as AppRegistryMutationReceipt["status"] } };
}

function readApp(value: unknown, at: string): ContractResult<AppRegistryAppSummary> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, APP_FIELDS, at);
  const appId = boundedStringAt(bag, row, "appId", at, 96);
  const publisher = boundedStringAt(bag, row, "publisher", at, 128);
  const digest = row.activeDigest === null ? null : boundedStringAt(bag, row, "activeDigest", at, 64);
  const releaseCount = boundedIntAt(bag, row, "releaseCount", at, 100_000);
  const compatibility = boundedStringAt(bag, row, "compatibility", at, 12);
  const runtimeHealth = boundedStringAt(bag, row, "runtimeHealth", at, 8);
  if (appId !== null && !APP.test(appId)) bag.add("identifier", "appId is invalid", `${at}.appId`);
  if (digest !== null && !DIGEST.test(digest)) bag.add("identifier", "activeDigest is invalid", `${at}.activeDigest`);
  if (compatibility !== null && !["supported", "incompatible", "unknown"].includes(compatibility)) bag.add("schema", "compatibility is not closed", `${at}.compatibility`);
  if (runtimeHealth !== null && !["healthy", "degraded", "offline", "unknown"].includes(runtimeHealth)) bag.add("schema", "runtimeHealth is not closed", `${at}.runtimeHealth`);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { appId: appId!, publisher: publisher!, activeDigest: digest, releaseCount: releaseCount!, compatibility: compatibility! as AppRegistryAppSummary["compatibility"], runtimeHealth: runtimeHealth! as AppRegistryAppSummary["runtimeHealth"] } };
}

export function sessionHarnessLaunchRefusal(code: SessionHarnessLaunchRefusalCode, message: string) {
  return SESSION_HARNESS_LAUNCH_REFUSALS.refuse(code, message);
}

export function appRegistryAdminRefusal(code: AppRegistryAdminRefusalCode, message: string) {
  return APP_REGISTRY_ADMIN_REFUSALS.refuse(code, message);
}
