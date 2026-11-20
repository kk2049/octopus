import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { AuthorizationService } from "./service.js";
import type { PolicyRule } from "./types.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function rules(): PolicyRule[] {
  return [
    {
      id: "acme:report-chain",
      title: "Managers can read reports below them",
      authority: { kind: "organization", id: "acme" },
      effect: "allow",
      match: { subjectTypes: ["user", "app"], domainKinds: ["organization"], resourceKinds: ["report"], operations: ["read"] },
      when: {
        op: "ancestor",
        hierarchy: "reports",
        ancestor: { fact: "actor" },
        descendant: { fact: "resource_owner" },
      },
      explanation: "the organization reporting chain covers this report",
    },
    {
      id: "acme:legal-hold",
      title: "Legal hold",
      authority: { kind: "organization", id: "acme" },
      effect: "deny",
      mandatory: true,
      match: { domainKinds: ["organization"], operations: ["delete", "edit"] },
      explanation: "organization records under legal hold cannot be deleted",
    },
    {
      id: "acme:incident-freeze",
      title: "Incident freeze",
      authority: { kind: "organization", id: "acme" },
      effect: "block",
      mandatory: true,
      match: { domainKinds: ["organization"], operations: ["delete"] },
      explanation: "the organization incident response program blocks deletion",
    },
    {
      id: "acme:no-snapshot-import",
      title: "Snapshot import hold",
      authority: { kind: "organization", id: "acme" },
      effect: "deny",
      mandatory: true,
      match: { domainKinds: ["organization"], operations: ["transfer:snapshot"] },
      explanation: "the organization currently blocks snapshot imports",
    },
    {
      id: "acme:conditional-retention",
      title: "Conditional retention hold",
      authority: { kind: "organization", id: "acme" },
      effect: "deny",
      mandatory: true,
      match: { domainKinds: ["organization"], operations: ["archive"] },
      when: { op: "eq", left: { fact: "legal_hold" }, right: { value: true } },
      explanation: "records on legal hold cannot be archived",
    },
    {
      id: "acme:conditional-export",
      title: "Conditional export hold",
      authority: { kind: "organization", id: "acme" },
      effect: "deny",
      mandatory: true,
      match: { domainKinds: ["organization"], operations: ["transfer:live_view"] },
      when: { op: "eq", left: { fact: "export_hold" }, right: { value: true } },
      explanation: "records under export hold cannot leave the organization",
    },
    {
      id: "alice:sensitive-review",
      title: "Sensitive review",
      authority: { kind: "owner", id: "alice" },
      effect: "ask",
      match: { resourceKinds: ["report"], operations: ["read"] },
      explanation: "this owner asks for review before sensitive reads",
    },
    {
      id: "alice:shared-work-copy",
      title: "Reviewed work copies enter the expense room",
      authority: { kind: "owner", id: "alice" },
      effect: "allow",
      match: {
        subjectTypes: ["user"],
        subjectIds: ["alice"],
        resourceIds: ["resource:private-note"],
        operations: ["transfer:work_copy"],
      },
      when: { op: "eq", left: { fact: "flow.target_domain_id" }, right: { value: "domain:shared" } },
      explanation: "the trusted owner rule binds this work copy to the reviewed shared domain",
    },
    {
      id: "alice:targetless-snapshot",
      title: "Targetless snapshot rule",
      authority: { kind: "owner", id: "alice" },
      effect: "allow",
      match: {
        subjectTypes: ["user"],
        subjectIds: ["alice"],
        resourceIds: ["resource:private-note"],
        operations: ["transfer:snapshot"],
      },
      explanation: "a targetless rule cannot create cross-domain AUTO authority",
    },
  ];
}

describe("AuthorizationService", () => {
  let store: Store;
  let service: AuthorizationService;
  let sequence: number;

  beforeEach(() => {
    sequence = 0;
    store = new Store(":memory:");
    service = new AuthorizationService({
      repository: store.authorization,
      rules: rules(),
      now: () => NOW,
      newId: () => `permit:${++sequence}`,
    });
    service.upsertDomain({
      id: "domain:alice",
      kind: "personal",
      title: "Alice private",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    service.upsertDomain({
      id: "domain:acme",
      kind: "organization",
      title: "Acme",
      authority: { kind: "organization", id: "acme" },
      historyPolicy: "since_join",
    });
    service.upsertDomain({
      id: "domain:shared",
      kind: "shared",
      title: "Expense room",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    service.upsertResource({
      id: "resource:private-note",
      uri: "file://octopus/alice/notes/42",
      owner: "alice",
      domainId: "domain:alice",
      kind: "note",
      title: "Private note",
      sensitivity: "sensitive",
      externalRef: { system: "notes", id: "note:42" },
    });
    service.upsertResource({
      id: "resource:expense",
      uri: "object://reports/alice/expense-42",
      owner: "alice",
      domainId: "domain:acme",
      kind: "report",
      title: "Expense report",
      sensitivity: "normal",
      externalRef: { system: "expenses", id: "expense:42" },
    });
    service.upsertResource({
      id: "resource:key",
      uri: "object://credentials/alice/deploy",
      owner: "alice",
      domainId: "domain:alice",
      kind: "credential-handle",
      title: "Deploy credential",
      sensitivity: "credential",
      externalRef: { system: "vault", id: "handle:deploy" },
    });
  });

  afterEach(() => {
    service.close();
    store.close();
  });

  it("allows an owner user directly but requires an exact install permit for apps and agents", () => {
    expect(service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      operation: "read",
    })).toMatchObject({ result: "allow", code: "authority_allow", enforcement: "intent-only" });

    expect(service.getAppInstallDefaults("alice")).toMatchObject({
      source: "built-in",
      profile: { readMode: "allow", observeMode: "allow", writeMode: "ask", executeMode: "ask" },
    });
    // The convenient read default is only a draft default, never access.
    expect(service.decideAccess({
      subject: { type: "app", id: "new-app" },
      resourceId: "resource:private-note",
      operation: "read",
    })).toMatchObject({ result: "deny", code: "install_permit_missing" });

    service.putPermit({
      subject: { type: "app", id: "new-app" },
      resourceId: "resource:private-note",
      operation: "read",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideAccess({
      subject: { type: "app", id: "new-app" },
      resourceId: "resource:private-note",
      operation: "read",
    }).result).toBe("allow");
  });

  it("persists configurable write/execute install defaults without changing access", () => {
    expect(service.setAppInstallDefaults("alice", {
      version: 1,
      readMode: "allow",
      observeMode: "allow",
      writeMode: "deny",
      executeMode: "allow",
    }, "alice")).toMatchObject({
      source: "saved",
      updatedBy: "alice",
      profile: { writeMode: "deny", executeMode: "allow" },
    });
    expect(service.getAppInstallDefaults("alice").profile).toEqual({
      version: 1,
      readMode: "allow",
      observeMode: "allow",
      writeMode: "deny",
      executeMode: "allow",
    });
    expect(service.decideAccess({
      subject: { type: "app", id: "new-app" },
      resourceId: "resource:private-note",
      operation: "execute",
    }).result).toBe("deny");
  });

  it("lets an organization program a reporting-chain rule", () => {
    expect(service.decideAccess({
      subject: { type: "user", id: "manager" },
      resourceId: "resource:expense",
      operation: "read",
      facts: { actor: "manager", resource_owner: "alice" },
      hierarchies: { reports: [{ ancestor: "manager", descendant: "alice" }] },
    })).toMatchObject({ result: "allow", code: "authority_allow" });
    expect(service.listRulesForResource("resource:expense").map((rule) => rule.id)).toEqual(
      expect.arrayContaining(["acme:report-chain", "acme:legal-hold", "acme:no-snapshot-import"]),
    );
  });

  it("does not let an owner permit bypass a mandatory organization deny", () => {
    service.putPermit({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "edit",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    const decision = service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "edit",
    });
    expect(decision).toMatchObject({ result: "deny", code: "mandatory_organization_deny" });
    expect(decision.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "acme:legal-hold", outcome: "matched", effect: "deny" }),
    ]));
  });

  it("gives a mandatory block precedence over a mandatory deny and an exact allow", () => {
    service.putPermit({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "delete",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "delete",
    })).toMatchObject({ result: "block", code: "policy_block" });
  });

  it("fails a mandatory conditional rule closed when required facts are absent", () => {
    expect(service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "archive",
    })).toMatchObject({ result: "deny", code: "mandatory_policy_context_missing" });
    expect(service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "archive",
      facts: { legal_hold: false },
    })).toMatchObject({ result: "allow", code: "authority_allow" });
    expect(service.decideAccess({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      operation: "archive",
      facts: { legal_hold: true },
    })).toMatchObject({ result: "deny", code: "mandatory_organization_deny" });
  });

  it("treats an App ASK permit as a ceiling even when a broad rule allows", () => {
    service.putPermit({
      subject: { type: "app", id: "expense-helper" },
      resourceId: "resource:expense",
      operation: "read",
      mode: "ask",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideAccess({
      subject: { type: "app", id: "expense-helper" },
      resourceId: "resource:expense",
      operation: "read",
      facts: { actor: "manager", resource_owner: "alice" },
      hierarchies: { reports: [{ ancestor: "manager", descendant: "alice" }] },
    })).toMatchObject({ result: "ask", code: "approval_required" });
  });

  it("models same-domain and explicit cross-domain products, with credential egress blocked", () => {
    service.upsertDomain({
      id: "domain:bob",
      kind: "personal",
      title: "Bob private",
      authority: { kind: "owner", id: "bob" },
      historyPolicy: "all",
    });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:alice",
      transfer: "live_view",
    })).toMatchObject({ result: "allow", code: "same_domain_flow" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:shared",
      transfer: "snapshot",
    })).toMatchObject({ result: "ask", code: "private_to_shared_approval" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:bob",
      transfer: "snapshot",
    })).toMatchObject({ result: "deny", code: "cross_domain_not_permitted" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:acme",
      transfer: "snapshot",
    })).toMatchObject({ result: "deny", code: "target_domain_mandatory_deny" });

    service.putPermit({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      operation: "transfer:snapshot",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:shared",
      transfer: "snapshot",
    })).toMatchObject({ result: "ask", code: "private_to_shared_approval" });

    service.putPermit({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      operation: "transfer:work_copy",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:shared",
      transfer: "work_copy",
    })).toMatchObject({ result: "allow", code: "authority_allow" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:bob",
      transfer: "work_copy",
    })).toMatchObject({ result: "deny", code: "cross_domain_not_permitted" });

    service.putPermit({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:key",
      operation: "transfer:snapshot",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:key",
      targetDomainId: "domain:shared",
      transfer: "snapshot",
    })).toMatchObject({ result: "block", code: "credential_non_personal_block" });

    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:key",
      targetDomainId: "domain:bob",
      transfer: "snapshot",
    })).toMatchObject({ result: "block", code: "credential_cross_personal_block" });
  });

  it("does not let flow defaults bypass an App or agent install ceiling", () => {
    for (const subject of [
      { type: "app" as const, id: "note-exporter" },
      { type: "agent" as const, id: "note-helper" },
    ]) {
      expect(service.decideFlow({
        subject,
        resourceId: "resource:private-note",
        targetDomainId: "domain:alice",
        transfer: "live_view",
      })).toMatchObject({ result: "deny", code: "install_permit_missing" });
      expect(service.decideFlow({
        subject,
        resourceId: "resource:private-note",
        targetDomainId: "domain:shared",
        transfer: "live_view",
      })).toMatchObject({ result: "deny", code: "install_permit_missing" });
    }

    service.putPermit({
      subject: { type: "app", id: "note-exporter" },
      resourceId: "resource:private-note",
      operation: "transfer:live_view",
      mode: "ask",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.decideFlow({
      subject: { type: "app", id: "note-exporter" },
      resourceId: "resource:private-note",
      targetDomainId: "domain:shared",
      transfer: "live_view",
    })).toMatchObject({ result: "ask", code: "approval_required" });
  });

  it("fails source-domain mandatory flow conditions closed before any flow baseline", () => {
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      targetDomainId: "domain:acme",
      transfer: "live_view",
    })).toMatchObject({ result: "deny", code: "mandatory_policy_context_missing" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      targetDomainId: "domain:shared",
      transfer: "live_view",
    })).toMatchObject({ result: "deny", code: "mandatory_policy_context_missing" });
    expect(service.decideFlow({
      subject: { type: "user", id: "alice" },
      resourceId: "resource:expense",
      targetDomainId: "domain:acme",
      transfer: "live_view",
      facts: { export_hold: false },
    })).toMatchObject({ result: "allow", code: "same_domain_flow" });
  });

  it("validates domain/resource/authority coherence and opaque external references", () => {
    expect(() => service.upsertDomain({
      id: "studio:forged-domain",
      kind: "personal",
      title: "Reserved",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    })).toThrow(/reserved Studio/);
    expect(() => service.upsertResource({
      id: "studio:runner-account:alice",
      uri: "object://notes/alice/reserved",
      owner: "alice",
      domainId: "domain:alice",
      kind: "note",
      title: "Reserved",
      sensitivity: "normal",
      externalRef: { system: "notes", id: "note:reserved" },
    })).toThrow(/reserved Studio/);
    expect(() => service.upsertResource({
      id: "resource:wrong-owner",
      uri: "object://notes/bob/wrong-owner",
      owner: "bob",
      domainId: "domain:alice",
      kind: "note",
      title: "Wrong",
      sensitivity: "normal",
      externalRef: { system: "notes", id: "note:wrong" },
    })).toThrow(/same owner/);
    expect(() => service.upsertResource({
      id: "resource:secret-value",
      uri: "object://secrets/alice/forbidden",
      owner: "alice",
      domainId: "domain:alice",
      kind: "secret",
      title: "No",
      sensitivity: "credential",
      externalRef: { system: "vault", id: "sk-secretvalue" },
    })).toThrow(/never a secret/);
    expect(() => service.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId: "resource:private-note",
      operation: "read",
      mode: "allow",
      authority: { kind: "owner", id: "mallory" },
      source: "user",
      createdBy: "mallory",
    })).toThrow(/resource owner/);
  });

  it("rewrites alias subtrees while exact permits remain pinned to canonical resources", () => {
    service.upsertResource({
      id: "resource:archived-note",
      uri: "file://octopus/alice/archive/42",
      owner: "alice",
      domainId: "domain:alice",
      kind: "note",
      title: "Archived note",
      sensitivity: "sensitive",
      externalRef: { system: "notes", id: "note:archive:42" },
    });
    service.putResourceAlias({
      owner: "alice",
      uri: "file://legacy/alice/notes",
      targetUri: "file://octopus/alice/notes",
      createdBy: "alice",
    });

    const legacyRef = "file://legacy/alice/notes/42";
    expect(service.getResource(legacyRef)?.id).toBe("resource:private-note");
    service.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId: legacyRef,
      operation: "read",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(service.listPermits({ resourceId: "resource:private-note" })).toHaveLength(1);

    service.putResourceAlias({
      owner: "alice",
      uri: "file://legacy/alice/notes",
      targetUri: "file://octopus/alice/archive",
      createdBy: "alice",
    });
    expect(service.getResource(legacyRef)?.id).toBe("resource:archived-note");
    expect(service.listPermits({ resourceId: "resource:private-note" })).toHaveLength(1);
    expect(service.listPermits({ resourceId: legacyRef })).toHaveLength(0);
    expect(service.listResourceAliases({ owner: "alice" })).toEqual([
      expect.objectContaining({
        uri: "file://legacy/alice/notes",
        targetUri: "file://octopus/alice/archive",
      }),
    ]);
  });

  it("rejects alias overlap, cycles, and cross-owner targets", () => {
    service.upsertDomain({
      id: "domain:bob",
      kind: "personal",
      title: "Bob private",
      authority: { kind: "owner", id: "bob" },
      historyPolicy: "all",
    });
    service.upsertResource({
      id: "resource:bob-note",
      uri: "file://octopus/bob/notes/1",
      owner: "bob",
      domainId: "domain:bob",
      kind: "note",
      title: "Bob note",
      sensitivity: "sensitive",
      externalRef: { system: "notes", id: "note:bob:1" },
    });
    service.putResourceAlias({
      owner: "alice",
      uri: "file://legacy/alice",
      targetUri: "file://octopus/alice",
      createdBy: "alice",
    });
    expect(() => service.putResourceAlias({
      owner: "alice",
      uri: "file://legacy/alice/notes",
      targetUri: "file://octopus/alice/notes",
      createdBy: "alice",
    })).toThrow(/overlaps active alias/);
    expect(() => service.putResourceAlias({
      owner: "alice",
      uri: "file://foreign/alice",
      targetUri: "file://octopus/bob",
      createdBy: "alice",
    })).toThrow(/same owner/);

    service.putResourceAlias({
      owner: "alice",
      uri: "file://alternate/alice",
      targetUri: "file://legacy/alice",
      createdBy: "alice",
    });
    expect(() => service.putResourceAlias({
      owner: "alice",
      uri: "file://legacy/alice",
      targetUri: "file://alternate/alice",
      createdBy: "alice",
    })).toThrow(/cycle/);
  });

  it("marks a revoke before synchronously notifying cleanup consumers", () => {
    service.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId: "resource:private-note",
      operation: "read",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    let seen: string | undefined;
    service.onChanged((event) => {
      if (event.kind === "permit-revoked") {
        seen = service.decideAccess({
          subject: { type: "user", id: "bob" },
          resourceId: "resource:private-note",
          operation: "read",
        }).result;
      }
    });
    service.onChanged(() => { throw new Error("cleanup failed"); });
    const revoked = service.revokePermit({
      subject: { type: "user", id: "bob" },
      resourceId: "resource:private-note",
      operation: "read",
      authority: { kind: "owner", id: "alice" },
      revokedBy: "alice",
    });
    expect(revoked?.revokedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(seen).toBe("deny");
    expect(service.listPermits({ resourceId: "resource:private-note" })).toEqual([]);
    expect(service.listPermits({ resourceId: "resource:private-note", includeRevoked: true }))
      .toEqual([expect.objectContaining({ id: revoked?.id, revokedBy: "alice" })]);
  });
});
