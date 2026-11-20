/**
 * `board.grid/v1`: instance config in, geometry rendered, proposals out.
 *
 * This layer reads the config, reads the projection through the App's one
 * `app-data/v1` port (the SAME provider the data.* modules share — a second
 * subscription over one projection would be a second chance to tear), holds the
 * view-local selection, and proposes `config.action`. Nothing here knows what a
 * grid is FOR: no side, no legality, no victory, no turn order. An activation
 * the rules would refuse is still proposed — the rule gate answers with a
 * bounded refusal, and that refusal is the sentence this module renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceConfig } from "@claude-bot/agent-module-contract";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { selectPath, useAppData, type AppDataProposal } from "@claude-bot/agent-data-view";
import { BoardGrid, type BoardGridProposal } from "./components/BoardGrid.js";
import { cellKey, readBoard, readHighlightSet, type BoardReadout } from "./lib/board.js";
import { BOARD_GRID_MANIFEST } from "./manifests.js";

function text(config: InstanceConfig | null, key: string, fallback = ""): string {
  const value = config?.[key];
  return typeof value === "string" && value ? value : fallback;
}

function BoardGridModule({ panel }: ModuleProps) {
  const { snapshot, submit, dismissProposal } = useAppData();
  const config = panel.config;
  const source = text(config, "source");
  const action = text(config, "action");
  // Anything that is not the one other mode is the default, like every other
  // lenient config value in these packages.
  const mode = text(config, "mode") === "cell" ? "cell" : "move";
  const highlightsPath = text(config, "highlights");
  const disabledPath = text(config, "disabled");

  const board = useMemo(() => readBoard(selectPath(snapshot.projection, source)), [snapshot.projection, source]);
  const highlights = useMemo(
    () =>
      readHighlightSet(
        highlightsPath ? selectPath(snapshot.projection, highlightsPath) : undefined,
        board.rows,
        board.cols,
      ),
    [board.cols, board.rows, highlightsPath, snapshot.projection],
  );
  // Strictly `true` disables; an absent path, a missing value or anything else
  // leaves the board interactive.
  const disabled = disabledPath ? selectPath(snapshot.projection, disabledPath) === true : false;
  const proposal = useMemo(
    () => readProposal(snapshot.proposals, action, board),
    [action, board, snapshot.proposals],
  );
  const refused = useMemo(
    () => latestRefusal(snapshot.proposals, action),
    [action, snapshot.proposals],
  );
  const busy = snapshot.proposals.some((entry) => entry.action === action && entry.phase === "inflight");

  const [selected, setSelected] = useState<string | null>(null);
  const [portNotice, setPortNotice] = useState("");

  /** Whether a late answer may still be written. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const propose = useCallback(
    (values: Record<string, string>) => {
      void submit(action, values).then(
        () => undefined,
        () => {
          // The port promises to resolve; a rejection is a broken port, and a
          // board stuck busy would be worse than an honest sentence.
          if (!live.current) return;
          setPortNotice("这次提议没有返回结果。");
        },
      );
    },
    [action, submit],
  );

  const onActivate = useCallback(
    (r: number, c: number) => {
      if (busy || disabled || !action) return;
      setPortNotice("");
      if (refused) dismissProposal(refused.rid);
      if (mode === "cell") {
        propose({ r: String(r), c: String(c) });
        return;
      }
      const key = cellKey(r, c);
      if (selected === null) {
        setSelected(key);
        return;
      }
      if (selected === key) {
        setSelected(null);
        return;
      }
      // Cleared on EMIT, not on the answer: the proposal is out either way, and
      // a refusal should leave the reader at a neutral board plus a sentence.
      setSelected(null);
      propose({ from: selected, to: key });
    },
    [action, busy, disabled, dismissProposal, mode, propose, refused, selected],
  );

  return (
    <BoardGrid
      rows={board.rows}
      cols={board.cols}
      cells={board.cells}
      highlights={highlights}
      selected={mode === "move" ? selected : null}
      disabled={disabled}
      busy={busy}
      status={board.status}
      source={source}
      booting={snapshot.projection === null}
      refusal={portNotice || (proposal?.phase === "refused" ? "" : refused?.message || snapshot.refusal)}
      refusalRid={proposal?.phase === "refused" ? null : refused?.rid ?? null}
      proposal={mode === "move" ? proposal : null}
      label={panel.label || source}
      onActivate={onActivate}
      onDismissProposal={dismissProposal}
    />
  );
}

function latestRefusal(proposals: readonly AppDataProposal[], action: string): AppDataProposal | null {
  if (!action) return null;
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.action === action && proposal.phase === "refused") return proposal;
  }
  return null;
}

function readProposal(
  proposals: readonly AppDataProposal[],
  action: string,
  board: BoardReadout,
): BoardGridProposal | null {
  if (!action || board.status !== "ok") return null;
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.action !== action) continue;
    const from = readCellKey(proposal.params.from, board.rows, board.cols);
    const to = readCellKey(proposal.params.to, board.rows, board.cols);
    if (!from || !to || from === to) continue;
    return {
      rid: proposal.rid,
      from,
      to,
      phase: proposal.phase,
      message: proposal.message,
      cell: board.cells.get(from) ?? { glyph: "", label: from, tone: "neutral" },
    };
  }
  return null;
}

function readCellKey(value: string | undefined, rows: number, cols: number): string | null {
  if (!value) return null;
  const match = /^(\d+),(\d+)$/.exec(value);
  if (!match) return null;
  const r = Number(match[1]);
  const c = Number(match[2]);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r >= rows || c >= cols) return null;
  return cellKey(r, c) === value ? value : null;
}

export const BOARD_GRID_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: BOARD_GRID_MANIFEST,
  component: BoardGridModule,
});

export const BOARD_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([BOARD_GRID_MODULE]);

/** Every config key the module actually reads. `config.test.ts` compares them. */
export const CONFIG_KEYS_READ = Object.freeze({
  grid: Object.freeze(["source", "action", "mode", "highlights", "disabled"]),
});
