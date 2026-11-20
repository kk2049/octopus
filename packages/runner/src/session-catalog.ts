/** Runner-local validation for Host-selected Sessions+ split sessions. */

import { isAgentProvider, type AgentProvider } from "./agent-runtime.js";
import { LaunchJournal } from "./launch-journal.js";

export const SESSION_CATALOG_SELECTION_MAX = 500;

export interface AuthorizedSessionCatalogSelection {
  source: AgentProvider;
  ids: string[];
}

/**
 * Resolve a bounded Host selection against durable local launch evidence.
 *
 * No scan root, owner, path or title is accepted from the request. New rows
 * match the Host-minted catalog correlation written at launch. Pre-v67 rows
 * match only when the Host supplies the exact tuple it backfilled from its
 * former execution binding. A ticket transcript has neither form of placement
 * evidence and therefore cannot enter the returned set.
 */
export async function authorizedSessionCatalogSelection(
  home: string,
  args: Readonly<Record<string, unknown>>,
): Promise<AuthorizedSessionCatalogSelection> {
  const source = String(args.source ?? "");
  if (!isAgentProvider(source)) throw new Error("Sessions+ session catalog source 无效");
  const raw = Array.isArray(args._octopus_session_catalog)
    ? args._octopus_session_catalog
    : [];
  if (raw.length > SESSION_CATALOG_SELECTION_MAX) {
    throw new Error(`Sessions+ session catalog 最多接受 ${SESSION_CATALOG_SELECTION_MAX} 条`);
  }
  const journal = new LaunchJournal(home);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const row = catalogEntry(value);
    if (!row || seen.has(row.id)) continue;
    let placement;
    try {
      placement = await journal.sessionPlacement(row.id);
    } catch {
      // Corrupt or unreadable evidence authorizes nothing; another valid row
      // in the same bounded request may still be served.
      continue;
    }
    if (!placement || placement.source !== source) continue;
    const exactPlacement = placement.execution_device === row.executionDevice
      && placement.workspace_id === row.workspaceId;
    const correlated = row.catalogId
      ? placement.version === 2 && placement.catalog_id === row.catalogId
      : exactPlacement;
    if (!correlated || !exactPlacement) continue;
    seen.add(row.id);
    ids.push(row.id);
  }
  return { source, ids };
}

interface CatalogEntry {
  id: string;
  catalogId: string | null;
  executionDevice: string;
  workspaceId: string;
}

function catalogEntry(value: unknown): CatalogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const catalogId = typeof row.catalog_id === "string" ? row.catalog_id.trim() : "";
  const executionDevice = typeof row.execution_device === "string" ? row.execution_device.trim() : "";
  const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id.trim() : "";
  if (!id || Buffer.byteLength(id, "utf8") > 200) return null;
  if (catalogId && !/^spc_[0-9a-f]{64}$/.test(catalogId)) return null;
  if (!executionDevice || Buffer.byteLength(executionDevice, "utf8") > 64) return null;
  if (!/^ws_[0-9a-f]{24}$/.test(workspaceId)) return null;
  return { id, catalogId: catalogId || null, executionDevice, workspaceId };
}
