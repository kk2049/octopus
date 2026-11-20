import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * 剖面 6 · 演进 — the commit-range view. A draggable two-handle range selector
 * over the commit axis, then two answers for the selected span:
 *
 *   架构变化   the set difference between the archived snapshots nearest each
 *              endpoint (or an honest "no architecture history in this range")
 *   代码变化   `git log A..B --numstat` aggregated onto the module vocabulary
 *
 * PERFORMANCE CONTRACT: dragging never computes anything server-side. The
 * diff request fires only after the drag ends (and debounced for keyboard
 * steps), and the server answers it from archived files plus one git log —
 * the 19-minute analyzer run is never on this path.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { ErrorBox, Loading, StaleDataBanner, Status } from "../../ui/misc.js";
import styles from "../ArchitecturePage.module.css";
import { StatusBadge } from "./bits.js";
import {
  archDiffEmpty,
  axisCommits,
  clampRange,
  fmtDelta,
  fmtSigned,
  indexAtOffset,
  moduleLabel,
  nextCommitsCursor,
  positionPercent,
  safeDiff,
  shortDate,
  shortSha,
  snapshotIndices,
  stepIndex,
  type EvoArchitectureDiff,
  type EvoCodeSummary,
  type EvoCommit,
  type EvoCommitsCursor,
  type EvoCommitsResponse,
  type EvoDiffResponse,
  type EvoSnapshot,
  type EvoSnapshotsResponse,
} from "./evolution.js";

/** First commit-axis window, then each explicit "load older" window. */
const COMMITS_FIRST = 200;
const COMMITS_OLDER = 500;
/** Keyboard steps settle briefly before the diff request fires. */
const APPLY_DEBOUNCE_MS = 250;
const RESIZED_LISTED = 12;

type Handle = "from" | "to";

// ── The range selector ──────────────────────────────────────────────────────

function RangeSelector({
  axis,
  marks,
  range,
  onRange,
  onDragging,
}: {
  axis: EvoCommit[];
  marks: Map<number, EvoSnapshot>;
  range: [number, number];
  onRange: (next: [number, number]) => void;
  onDragging: (dragging: boolean) => void;
}) {
  useDashboardLanguage();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<Handle | null>(null);

  const moveTo = (which: Handle, clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const index = indexAtOffset(clientX - rect.left, rect.width, axis.length);
    onRange(
      clampRange(which === "from" ? [index, range[1]] : [range[0], index], axis.length, which),
    );
  };

  const handleProps = (which: Handle) => {
    const at = which === "from" ? range[0] : range[1];
    const commit = axis[at];
    return {
      role: "slider" as const,
      tabIndex: 0,
      "aria-label": which === "from" ? uiText("范围起点") : uiText("范围终点"),
      "aria-valuemin": 0,
      "aria-valuemax": axis.length - 1,
      "aria-valuenow": at,
      "aria-valuetext": commit ? `${shortSha(commit.sha)} · ${shortDate(commit.date)} · ${commit.subject}` : "",
      title: commit ? `${shortSha(commit.sha)} ${commit.subject}` : "",
      style: { left: `${positionPercent(at, axis.length)}%` },
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = which;
        onDragging(true);
        moveTo(which, event.clientX);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        if (draggingRef.current === which) moveTo(which, event.clientX);
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        draggingRef.current = null;
        onDragging(false);
      },
      onLostPointerCapture: () => {
        draggingRef.current = null;
        onDragging(false);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        const next = stepIndex(at, event.key, axis.length);
        if (next === at && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        onRange(
          clampRange(which === "from" ? [next, range[1]] : [range[0], next], axis.length, which),
        );
      },
    };
  };

  const left = positionPercent(range[0], axis.length);
  const right = positionPercent(range[1], axis.length);
  return (
    <div className={styles.evoTrackWrap}>
      <div ref={trackRef} className={styles.evoTrack}>
        <div className={styles.evoFill} style={{ left: `${left}%`, width: `${right - left}%` }} />
        {[...marks.entries()].map(([at, snap]) => (
          <span
            key={snap.commit}
            className={snap.current ? `${styles.evoMark} ${styles.evoMarkCurrent}` : styles.evoMark}
            style={{ left: `${positionPercent(at, axis.length)}%` }}
            title={uiText("架构快照 {v0} · {v1}{v2}", { v0: shortSha(snap.commit), v1: snap.generatedAt, v2: snap.dirty ? " · dirty" : "" })}
          />
        ))}
        <div className={`${styles.evoHandle} ${styles.evoHandleFrom}`} {...handleProps("from")} />
        <div className={`${styles.evoHandle} ${styles.evoHandleTo}`} {...handleProps("to")} />
      </div>
      <div className={styles.evoAxisLabels}>
        <span>{shortDate(axis[0]?.date ?? "")} {uiText(" 最早")}</span>
        <span>{shortDate(axis[axis.length - 1]?.date ?? "")} {uiText(" 最新")}</span>
      </div>
    </div>
  );
}

// ── The two result columns ──────────────────────────────────────────────────

function ArchDiffCard({ diff, unavailable }: { diff: EvoArchitectureDiff | null; unavailable?: string }) {
  useDashboardLanguage();
  if (diff === null) {
    return (
      <section className={styles.card}>
        <h3>{uiText("架构变化")}</h3>
        <p className={styles.muted}>{unavailable || uiText("该区间无历史架构快照，仅显示代码变化。")}</p>
      </section>
    );
  }
  const codeLocDelta = diff.totals.after.codeLoc - diff.totals.before.codeLoc;
  const filesDelta = diff.totals.after.files - diff.totals.before.files;
  return (
    <section className={styles.card}>
      <h3>{uiText("架构变化")}</h3>
      <p className={styles.muted}>
        {uiText("对比快照：")}<span className={styles.mono}>{shortSha(diff.base.commit)}</span>
        {diff.base.dirty && <span className={styles.dirty}>{uiText("未提交")}</span>} →{" "}
        <span className={styles.mono}>{shortSha(diff.head.commit)}</span>
        {diff.head.dirty && <span className={styles.dirty}>{uiText("未提交")}</span>}
        {" · "}{uiText("代码行 ")}{fmtSigned(codeLocDelta)} {uiText(" · 文件 ")}{fmtSigned(filesDelta)}
      </p>
      {archDiffEmpty(diff) && (
        <p className={styles.muted}>{uiText("两份快照之间没有模块、依赖或约束层面的变化。")}</p>
      )}

      {diff.modules.added.length > 0 && (
        <>
          <h4 className={styles.subhead}>{uiText("新增模块")}</h4>
          <ul className={styles.evoList}>
            {diff.modules.added.map((mod) => (
              <li key={mod.id}>
                <span className={styles.evoAdd}>+ {mod.id}</span>
                <span className={styles.muted}>
                  {mod.zone} · {mod.files} {uiText(" 文件 · ")}{mod.codeLoc} {uiText(" 行")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.modules.removed.length > 0 && (
        <>
          <h4 className={styles.subhead}>{uiText("移除模块")}</h4>
          <ul className={styles.evoList}>
            {diff.modules.removed.map((mod) => (
              <li key={mod.id}>
                <span className={styles.evoDel}>− {mod.id}</span>
                <span className={styles.muted}>
                  {mod.zone} · {mod.files} {uiText(" 文件 · ")}{mod.codeLoc} {uiText(" 行")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.modules.resized.length > 0 && (
        <>
          <h4 className={styles.subhead}>{uiText("模块规模变化")}</h4>
          <ul className={styles.evoList}>
            {diff.modules.resized.slice(0, RESIZED_LISTED).map((mod) => (
              <li key={mod.id}>
                <span className={styles.mono}>{mod.id}</span>
                <span className={mod.codeLocAfter >= mod.codeLocBefore ? styles.evoAdd : styles.evoDel}>
                  {fmtSigned(mod.codeLocAfter - mod.codeLocBefore)} {uiText(" 行")}</span>
                <span className={styles.muted}>
                  {mod.codeLocBefore} → {mod.codeLocAfter}
                  {mod.filesAfter !== mod.filesBefore && uiText(" · 文件 {v0} → {v1}", { v0: mod.filesBefore, v1: mod.filesAfter })}
                </span>
              </li>
            ))}
          </ul>
          {diff.modules.resized.length > RESIZED_LISTED && (
            <p className={styles.muted}>{uiText("… 另有 ")}{diff.modules.resized.length - RESIZED_LISTED} {uiText(" 个模块有规模变化")}</p>
          )}
        </>
      )}

      {(diff.dependencies.added.length > 0 || diff.dependencies.removed.length > 0) && (
        <>
          <h4 className={styles.subhead}>{uiText("依赖边")}</h4>
          <ul className={styles.evoList}>
            {diff.dependencies.added.map((edge) => (
              <li key={`+${edge.from}->${edge.to}`}>
                <span className={styles.evoAdd}>
                  + {edge.from} → {edge.to}
                </span>
                {edge.circular && <span className={`${styles.sev} ${styles.sevErr}`}>{uiText("环")}</span>}
              </li>
            ))}
            {diff.dependencies.removed.map((edge) => (
              <li key={`-${edge.from}->${edge.to}`}>
                <span className={styles.evoDel}>
                  − {edge.from} → {edge.to}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(diff.dependencies.becameCircular.length > 0 || diff.dependencies.becameAcyclic.length > 0) && (
        <>
          <h4 className={styles.subhead}>{uiText("环变化")}</h4>
          <ul className={styles.evoList}>
            {diff.dependencies.becameCircular.map((edge) => (
              <li key={`c${edge.from}->${edge.to}`}>
                <span className={styles.evoDel}>
                  {edge.from} → {edge.to} {uiText(" 进入循环")}</span>
              </li>
            ))}
            {diff.dependencies.becameAcyclic.map((edge) => (
              <li key={`a${edge.from}->${edge.to}`}>
                <span className={styles.evoAdd}>
                  {edge.from} → {edge.to} {uiText(" 脱离循环")}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(diff.constraints.changed.length > 0 ||
        diff.constraints.added.length > 0 ||
        diff.constraints.removed.length > 0) && (
        <>
          <h4 className={styles.subhead}>{uiText("约束")}</h4>
          <ul className={styles.evoList}>
            {diff.constraints.changed.map((c) => (
              <li key={c.id}>
                <span>{c.title}</span>
                <StatusBadge status={c.before} /> → <StatusBadge status={c.after} />
              </li>
            ))}
            {diff.constraints.added.map((c) => (
              <li key={`+${c.id}`}>
                <span className={styles.evoAdd}>+ {c.title}</span>
                <StatusBadge status={c.status} />
              </li>
            ))}
            {diff.constraints.removed.map((c) => (
              <li key={`-${c.id}`}>
                <span className={styles.evoDel}>− {c.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CodeChangeCard({ code }: { code: EvoCodeSummary }) {
  useDashboardLanguage();
  return (
    <section className={styles.card}>
      <h3>{uiText("代码变化")}</h3>
      <p className={styles.muted}>
        {code.commitCount} {uiText(" 个提交 · ")}<span className={styles.evoAdd}>+{code.additions}</span>{" "}
        <span className={styles.evoDel}>−{code.deletions}</span>
        {code.aggregatedCommits < code.commitCount &&
          uiText(" · 仅聚合最近 {v0} 个提交（范围过大，已截断）", { v0: code.aggregatedCommits })}
      </p>
      {code.modules.length === 0 && <p className={styles.muted}>{uiText("该区间没有文件改动。")}</p>}
      {code.modules.map((mod) => (
        <details key={mod.moduleId} className={styles.evoModule}>
          <summary>
            <span className={styles.evoModuleName}>{moduleLabel(mod.moduleId)}</span>
            <span className={styles.evoAdd}>+{mod.additions}</span>
            <span className={styles.evoDel}>−{mod.deletions}</span>
            <span className={styles.muted}>{mod.commits} {uiText(" 提交")}</span>
          </summary>
          <ul className={styles.evoFiles}>
            {mod.files.map((file) => (
              <li key={file.path}>
                <span className={styles.mono}>{file.path}</span>
                <span className={styles.muted}>{fmtDelta(file.additions, file.deletions)}</span>
              </li>
            ))}
          </ul>
          {mod.filesTotal > mod.files.length && (
            <p className={styles.muted}>{uiText("… 共 ")}{mod.filesTotal} {uiText(" 个文件，仅列出改动最大的 ")}{mod.files.length} {uiText(" 个")}</p>
          )}
        </details>
      ))}
      {code.commits.length > 0 && (
        <details className={styles.evoModule}>
          <summary>
            <span className={styles.evoModuleName}>{uiText("提交列表")}</span>
            <span className={styles.muted}>
              {code.commits.length < code.commitCount
                ? uiText("最新 {v0} / {v1} 个", { v0: code.commits.length, v1: code.commitCount })
                : uiText("{v0} 个", { v0: code.commits.length })}
            </span>
          </summary>
          <ul className={styles.evoFiles}>
            {code.commits.map((commit) => (
              <li key={commit.sha}>
                <span className={styles.mono}>{shortSha(commit.sha)}</span>
                <span className={styles.evoSubject}>{commit.subject}</span>
                <span className={styles.muted}>
                  {commit.author} · {shortDate(commit.date)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ── The cut ─────────────────────────────────────────────────────────────────

export function EvolutionView() {
  useDashboardLanguage();
  const client = useQueryClient();
  // Windows of one axis anchored on the first window's head: a landing between
  // two clicks cannot shift, repeat or skip a commit. Older windows load only
  // on the explicit button; nothing here prefetches or polls.
  const commitsQ = useInfiniteQuery({
    queryKey: ["architecture", "commits"],
    initialPageParam: null as EvoCommitsCursor | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(pageParam ? COMMITS_OLDER : COMMITS_FIRST) });
      if (pageParam) {
        query.set("head", pageParam.head);
        query.set("offset", String(pageParam.offset));
      }
      return api<EvoCommitsResponse>(`/api/architecture/commits?${query.toString()}`);
    },
    getNextPageParam: (last) => nextCommitsCursor(last),
  });
  const loadedCommits = useMemo(
    () => commitsQ.data?.pages.flatMap((page) => page.commits ?? []),
    [commitsQ.data?.pages],
  );
  const lastWindow = commitsQ.data?.pages.at(-1);
  const snapsQ = useQuery<EvoSnapshotsResponse>({
    queryKey: ["architecture", "snapshots"],
    queryFn: () => api<EvoSnapshotsResponse>("/api/architecture/snapshots"),
  });

  const axis = useMemo(() => axisCommits(loadedCommits), [loadedCommits]);
  const marks = useMemo(() => snapshotIndices(axis, snapsQ.data?.snapshots), [axis, snapsQ.data?.snapshots]);
  const snapshotCount = snapsQ.data?.snapshots?.length ?? 0;

  const [range, setRange] = useState<[number, number] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);

  // A new axis (first load, or an older window appended) resets to the full span.
  useEffect(() => {
    setRange(axis.length >= 2 ? [0, axis.length - 1] : null);
  }, [axis]);

  // Apply AFTER interaction settles — never during a drag.
  useEffect(() => {
    if (!range || dragging) return;
    const from = axis[range[0]]?.sha;
    const to = axis[range[1]]?.sha;
    if (!from || !to || from === to) return;
    const timer = setTimeout(() => setApplied({ from, to }), APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [range, dragging, axis]);

  const diffQ = useQuery<EvoDiffResponse>({
    queryKey: ["architecture", "diff", applied?.from ?? "", applied?.to ?? ""],
    enabled: applied !== null,
    queryFn: () => api<EvoDiffResponse>(`/api/architecture/diff?from=${applied!.from}&to=${applied!.to}`),
  });
  const diff = useMemo(() => safeDiff(diffQ.data), [diffQ.data]);

  if (commitsQ.isLoading) return <Loading what={uiText("读取提交历史…")} />;
  if (!commitsQ.data && commitsQ.error) return <ErrorBox>{errorText(commitsQ.error)}</ErrorBox>;
  if (axis.length < 2) {
    return (
      <section className={styles.card}>
        <h3>{uiText("演进")}</h3>
        <p className={styles.muted}>{uiText("提交历史不足两个提交，无法选择范围。")}</p>
      </section>
    );
  }

  const fromCommit = range ? axis[range[0]] : undefined;
  const toCommit = range ? axis[range[1]] : undefined;

  return (
    <div>
      {commitsQ.error && (
        <StaleDataBanner
          message={errorText(commitsQ.error)}
          dataUpdatedAt={commitsQ.dataUpdatedAt}
        />
      )}
      <section className={styles.card}>
        <div className={styles.rowTitle}>
          <h3>{uiText("提交范围")}</h3>
          <span className={styles.muted}>
            {uiText("最近 ")}{axis.length} {uiText(" 个提交")}{lastWindow?.truncated && !commitsQ.hasNextPage ? uiText("（更早的历史未载入）") : ""} {uiText(" · ◆ 架构快照 ×")}{snapshotCount}
          </span>
          <span className={styles.grow} />
          {commitsQ.hasNextPage && (
            <UiButton disabled={commitsQ.isFetchingNextPage} onClick={() => void commitsQ.fetchNextPage()}>
              {commitsQ.isFetchingNextPage ? uiText("正在载入更早的历史…") : uiText("载入更早的历史")}
            </UiButton>
          )}
          <UiButton
            onClick={() => {
              void client.invalidateQueries({ queryKey: ["architecture", "commits"] });
              void client.invalidateQueries({ queryKey: ["architecture", "snapshots"] });
            }}
          >
            {uiText("重新载入")}</UiButton>
        </div>
        <RangeSelector
          axis={axis}
          marks={marks}
          range={range ?? [0, axis.length - 1]}
          onRange={setRange}
          onDragging={setDragging}
        />
        {fromCommit && toCommit && range && (
          <p className={styles.muted}>
            <span className={styles.mono}>{shortSha(fromCommit.sha)}</span>（{shortDate(fromCommit.date)}）→{" "}
            <span className={styles.mono}>{shortSha(toCommit.sha)}</span>（{shortDate(toCommit.date)}）·{" "}
            {range[1] - range[0]} {uiText(" 个提交")}{diffQ.isFetching && <Status> {uiText(" 计算中…")}</Status>}
          </p>
        )}
        {snapshotCount <= 1 && (
          <p className={styles.muted}>
            {uiText("目前只有 ")}{snapshotCount} {uiText(" 份架构快照：架构对比需要两份；新运行版本会自动分析并留档，也可手工重新分析。")}</p>
        )}
      </section>

      {diffQ.error && diffQ.data && (
        <StaleDataBanner message={errorText(diffQ.error)} dataUpdatedAt={diffQ.dataUpdatedAt} />
      )}
      {diff ? (
        <div className={styles.evoCols}>
          <ArchDiffCard diff={diff.architecture} unavailable={diff.architectureUnavailable} />
          <CodeChangeCard code={diff.code} />
        </div>
      ) : diffQ.error ? (
        <ErrorBox>{errorText(diffQ.error)}</ErrorBox>
      ) : (
        applied === null && <p className={styles.muted}>{uiText("拖动手柄选择范围后，这里显示该区间的架构与代码变化。")}</p>
      )}
    </div>
  );
}
