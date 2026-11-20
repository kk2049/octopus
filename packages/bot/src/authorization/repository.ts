import type Database from "better-sqlite3";
import { resourceUriPrefixes } from "./namespace.js";
import type {
  AppInstallDefaultProfile,
  AuthorityRef,
  AuthorizationDomain,
  AuthorizationResource,
  AuthorizationResourceAlias,
  AuthorizationSubject,
  ExactPermit,
  HistoryPolicy,
  PermitMode,
  PermitSource,
  ResourceSensitivity,
  StoredAppInstallDefaults,
} from "./types.js";

interface DomainRow {
  id: string;
  kind: AuthorizationDomain["kind"];
  title: string;
  authority_type: AuthorityRef["kind"];
  authority_id: string;
  history_policy: HistoryPolicy;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: string;
  uri: string;
  owner: string;
  domain_id: string;
  kind: string;
  title: string;
  sensitivity: ResourceSensitivity;
  external_system: string;
  external_id: string;
  created_at: string;
  updated_at: string;
}
interface AliasRow {
  id: string;
  owner: string;
  alias_uri: string;
  target_uri: string;
  created_by: string;
  created_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}


interface PermitRow {
  id: string;
  subject_type: AuthorizationSubject["type"];
  subject_id: string;
  resource_id: string;
  operation: string;
  mode: PermitMode;
  authority_type: AuthorityRef["kind"];
  authority_id: string;
  source: PermitSource;
  created_by: string;
  created_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

interface DefaultsRow {
  owner: string;
  profile_version: number;
  profile_json: string;
  updated_by: string;
  updated_at: string;
}

export interface PermitQuery {
  resourceId?: string;
  subject?: AuthorizationSubject;
  operation?: string;
  includeRevoked?: boolean;
  limit?: number;
}

export interface ExactPermitKey {
  subject: AuthorizationSubject;
  resourceId: string;
  operation: string;
  authority: AuthorityRef;
}

function mapDomain(row: DomainRow): AuthorizationDomain {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    authority: { kind: row.authority_type, id: row.authority_id },
    historyPolicy: row.history_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResource(row: ResourceRow): AuthorizationResource {
  return {
    id: row.id,
    uri: row.uri,
    owner: row.owner,
    domainId: row.domain_id,
    kind: row.kind,
    title: row.title,
    sensitivity: row.sensitivity,
    externalRef: { system: row.external_system, id: row.external_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapAlias(row: AliasRow): AuthorizationResourceAlias {
  return {
    id: row.id,
    owner: row.owner,
    uri: row.alias_uri,
    targetUri: row.target_uri,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  };
}


function mapPermit(row: PermitRow): ExactPermit {
  return {
    id: row.id,
    subject: { type: row.subject_type, id: row.subject_id },
    resourceId: row.resource_id,
    operation: row.operation,
    mode: row.mode,
    authority: { kind: row.authority_type, id: row.authority_id },
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  };
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(2_000, Math.floor(limit ?? 1_000)));
}

/** SQL-only persistence boundary for canonical authorization intent. */
export class AuthorizationRepository {
  constructor(private readonly db: Database.Database) {}

  getDomain(id: string): AuthorizationDomain | undefined {
    const row = this.db.prepare("SELECT * FROM authorization_domains WHERE id = ?").get(id) as DomainRow | undefined;
    return row ? mapDomain(row) : undefined;
  }

  listDomains(limit?: number): AuthorizationDomain[] {
    const rows = this.db.prepare(
      "SELECT * FROM authorization_domains ORDER BY kind, title, id LIMIT ?",
    ).all(clampLimit(limit)) as DomainRow[];
    return rows.map(mapDomain);
  }

  upsertDomain(domain: AuthorizationDomain): AuthorizationDomain {
    this.db.prepare(
      `INSERT INTO authorization_domains (
         id, kind, title, authority_type, authority_id, history_policy, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         history_policy = excluded.history_policy,
         updated_at = excluded.updated_at`,
    ).run(
      domain.id,
      domain.kind,
      domain.title,
      domain.authority.kind,
      domain.authority.id,
      domain.historyPolicy,
      domain.createdAt,
      domain.updatedAt,
    );
    return this.getDomain(domain.id)!;
  }

  getResource(id: string): AuthorizationResource | undefined {
    const row = this.db.prepare("SELECT * FROM authorization_resources WHERE id = ?").get(id) as ResourceRow | undefined;
    return row ? mapResource(row) : undefined;
  }
  getResourceByUri(uri: string): AuthorizationResource | undefined {
    const row = this.db.prepare("SELECT * FROM authorization_resources WHERE uri = ?").get(uri) as ResourceRow | undefined;
    return row ? mapResource(row) : undefined;
  }


  getResourceByExternalRef(system: string, id: string): AuthorizationResource | undefined {
    const row = this.db.prepare(
      "SELECT * FROM authorization_resources WHERE external_system = ? AND external_id = ?",
    ).get(system, id) as ResourceRow | undefined;
    return row ? mapResource(row) : undefined;
  }

  listResources(options: { owner?: string; domainId?: string; limit?: number } = {}): AuthorizationResource[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.owner) {
      clauses.push("owner = ?");
      params.push(options.owner);
    }
    if (options.domainId) {
      clauses.push("domain_id = ?");
      params.push(options.domainId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(clampLimit(options.limit));
    const rows = this.db.prepare(
      `SELECT * FROM authorization_resources${where} ORDER BY owner, domain_id, kind, title, id LIMIT ?`,
    ).all(...params) as ResourceRow[];
    return rows.map(mapResource);
  }

  upsertResource(resource: AuthorizationResource): AuthorizationResource {
    this.db.prepare(
      `INSERT INTO authorization_resources (
         id, uri, owner, domain_id, kind, title, sensitivity,
         external_system, external_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         sensitivity = CASE
           WHEN authorization_resources.sensitivity = 'credential' THEN 'credential'
           WHEN authorization_resources.sensitivity = 'sensitive' AND excluded.sensitivity = 'normal' THEN 'sensitive'
           ELSE excluded.sensitivity
         END,
         updated_at = excluded.updated_at`,
    ).run(
      resource.id,
      resource.uri,
      resource.owner,
      resource.domainId,
      resource.kind,
      resource.title,
      resource.sensitivity,
      resource.externalRef.system,
      resource.externalRef.id,
      resource.createdAt,
      resource.updatedAt,
    );
    return this.getResource(resource.id)!;
  }

  adoptResourceUri(id: string, expectedUri: string, uri: string, updatedAt: string): AuthorizationResource {
    const changed = this.db.prepare(
      `UPDATE authorization_resources
          SET uri = ?, updated_at = ?
        WHERE id = ? AND uri = ?`,
    ).run(uri, updatedAt, id, expectedUri);
    if (changed.changes !== 1) {
      throw new Error("authorization resource legacy URI adoption lost its expected source");
    }
    return this.getResource(id)!;
  }
  resourceOwnersAtOrBelow(uri: string): string[] {
    const lower = `${uri}/`;
    const upper = `${uri}0`;
    const rows = this.db.prepare(
      `SELECT DISTINCT owner FROM authorization_resources
        WHERE uri = ? OR (uri >= ? AND uri < ?)
        ORDER BY owner`,
    ).all(uri, lower, upper) as Array<{ owner: string }>;
    return rows.map((row) => row.owner);
  }

  getActiveAlias(uri: string): AuthorizationResourceAlias | undefined {
    const row = this.db.prepare(
      "SELECT * FROM authorization_resource_aliases WHERE alias_uri = ? AND revoked_at IS NULL",
    ).get(uri) as AliasRow | undefined;
    return row ? mapAlias(row) : undefined;
  }

  findActiveAliasFor(uri: string): AuthorizationResourceAlias | undefined {
    const prefixes = resourceUriPrefixes(uri);
    const placeholders = prefixes.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT * FROM authorization_resource_aliases
        WHERE revoked_at IS NULL AND alias_uri IN (${placeholders})
        ORDER BY length(alias_uri) DESC, alias_uri
        LIMIT 1`,
    ).get(...prefixes) as AliasRow | undefined;
    return row ? mapAlias(row) : undefined;
  }
  findActiveAliasOverlap(uri: string, excludeUri?: string): AuthorizationResourceAlias | undefined {
    const prefixes = resourceUriPrefixes(uri);
    const placeholders = prefixes.map(() => "?").join(",");
    const params: string[] = [...prefixes, `${uri}/`, `${uri}0`];
    const exclusion = excludeUri ? " AND alias_uri <> ?" : "";
    if (excludeUri) params.push(excludeUri);
    const row = this.db.prepare(
      `SELECT * FROM authorization_resource_aliases
        WHERE revoked_at IS NULL
          AND (alias_uri IN (${placeholders}) OR (alias_uri >= ? AND alias_uri < ?))
          ${exclusion}
        ORDER BY length(alias_uri) DESC, alias_uri
        LIMIT 1`,
    ).get(...params) as AliasRow | undefined;
    return row ? mapAlias(row) : undefined;
  }


  listAliases(options: {
    owner?: string;
    includeRevoked?: boolean;
    limit?: number;
  } = {}): AuthorizationResourceAlias[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.owner) {
      clauses.push("owner = ?");
      params.push(options.owner);
    }
    if (!options.includeRevoked) clauses.push("revoked_at IS NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(clampLimit(options.limit));
    const rows = this.db.prepare(
      `SELECT * FROM authorization_resource_aliases${where}
       ORDER BY alias_uri, created_at DESC, id DESC LIMIT ?`,
    ).all(...params) as AliasRow[];
    return rows.map(mapAlias);
  }

  putAlias(alias: AuthorizationResourceAlias): AuthorizationResourceAlias {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE authorization_resource_aliases
            SET revoked_by = ?, revoked_at = ?
          WHERE alias_uri = ? AND revoked_at IS NULL`,
      ).run(alias.createdBy, alias.createdAt, alias.uri);
      this.db.prepare(
        `INSERT INTO authorization_resource_aliases (
           id, owner, alias_uri, target_uri, created_by, created_at, revoked_by, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(alias.id, alias.owner, alias.uri, alias.targetUri, alias.createdBy, alias.createdAt);
    })();
    return this.getActiveAlias(alias.uri)!;
  }

  revokeAlias(
    owner: string,
    uri: string,
    revokedBy: string,
    revokedAt: string,
  ): AuthorizationResourceAlias | undefined {
    const current = this.getActiveAlias(uri);
    if (!current || current.owner !== owner) return undefined;
    this.db.prepare(
      `UPDATE authorization_resource_aliases
          SET revoked_by = ?, revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).run(revokedBy, revokedAt, current.id);
    return { ...current, revokedBy, revokedAt };
  }


  listPermits(query: PermitQuery = {}): ExactPermit[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.resourceId) {
      clauses.push("resource_id = ?");
      params.push(query.resourceId);
    }
    if (query.subject) {
      clauses.push("subject_type = ?", "subject_id = ?");
      params.push(query.subject.type, query.subject.id);
    }
    if (query.operation) {
      clauses.push("operation = ?");
      params.push(query.operation);
    }
    if (!query.includeRevoked) clauses.push("revoked_at IS NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(clampLimit(query.limit));
    const rows = this.db.prepare(
      `SELECT * FROM authorization_permits${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params) as PermitRow[];
    return rows.map(mapPermit);
  }

  getActivePermit(key: ExactPermitKey): ExactPermit | undefined {
    const row = this.db.prepare(
      `SELECT * FROM authorization_permits
        WHERE subject_type = ? AND subject_id = ? AND resource_id = ? AND operation = ?
          AND authority_type = ? AND authority_id = ? AND revoked_at IS NULL`,
    ).get(
      key.subject.type,
      key.subject.id,
      key.resourceId,
      key.operation,
      key.authority.kind,
      key.authority.id,
    ) as PermitRow | undefined;
    return row ? mapPermit(row) : undefined;
  }

  /** Replaces one exact active intent atomically while keeping the old row for audit. */
  putPermit(permit: ExactPermit): ExactPermit {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE authorization_permits
            SET revoked_by = ?, revoked_at = ?
          WHERE subject_type = ? AND subject_id = ? AND resource_id = ? AND operation = ?
            AND authority_type = ? AND authority_id = ? AND revoked_at IS NULL`,
      ).run(
        permit.createdBy,
        permit.createdAt,
        permit.subject.type,
        permit.subject.id,
        permit.resourceId,
        permit.operation,
        permit.authority.kind,
        permit.authority.id,
      );
      this.db.prepare(
        `INSERT INTO authorization_permits (
           id, subject_type, subject_id, resource_id, operation, mode,
           authority_type, authority_id, source, created_by, created_at,
           revoked_by, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        permit.id,
        permit.subject.type,
        permit.subject.id,
        permit.resourceId,
        permit.operation,
        permit.mode,
        permit.authority.kind,
        permit.authority.id,
        permit.source,
        permit.createdBy,
        permit.createdAt,
      );
    })();
    return this.getActivePermit(permit)!;
  }

  /** Marks first, returns the exact row that became ineffective. */
  revokePermit(key: ExactPermitKey, revokedBy: string, revokedAt: string): ExactPermit | undefined {
    const current = this.getActivePermit(key);
    if (!current) return undefined;
    this.db.prepare(
      "UPDATE authorization_permits SET revoked_by = ?, revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(revokedBy, revokedAt, current.id);
    return { ...current, revokedBy, revokedAt };
  }

  getAppInstallDefaults(owner: string): StoredAppInstallDefaults | undefined {
    const row = this.db.prepare(
      "SELECT * FROM authorization_owner_defaults WHERE owner = ?",
    ).get(owner) as DefaultsRow | undefined;
    if (!row) return undefined;
    const profile = JSON.parse(row.profile_json) as AppInstallDefaultProfile;
    return {
      owner: row.owner,
      profile,
      source: "saved",
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  setAppInstallDefaults(
    owner: string,
    profile: AppInstallDefaultProfile,
    updatedBy: string,
    updatedAt: string,
  ): StoredAppInstallDefaults {
    this.db.prepare(
      `INSERT INTO authorization_owner_defaults (owner, profile_version, profile_json, updated_by, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(owner) DO UPDATE SET
         profile_version = 1,
         profile_json = excluded.profile_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(owner, JSON.stringify(profile), updatedBy, updatedAt);
    return this.getAppInstallDefaults(owner)!;
  }
}
