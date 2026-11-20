import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, localizedLabels } from "../i18n/ui-text.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PermissionStudioApplyRequest,
  PermissionStudioApplyResponse,
  PermissionStudioEditableMode,
  PermissionStudioExplainRequest,
  PermissionStudioExplainResponse,
  PermissionStudioExplanation,
  PermissionStudioPermit,
  PermissionStudioProjection,
} from "../contract.js";
import { api, errorText, query } from "../lib/api.js";
import { Dialog } from "../ui/Dialog.js";
import {
  UiAlert,
  UiButton,
  UiCard,
  UiEmpty,
  UiRadio,
  UiTag,
  type UiTagTone,
} from "../ui-kit/primitives.js";
import { ResourceBrowser } from "./ResourceBrowser.js";
import styles from "./PermissionStudio.module.css";

const EDITABLE_MODES = localizedLabels((): ReadonlyArray<{
  mode: PermissionStudioEditableMode;
  label: string;
}> => ([
  { mode: "deny", label: uiText("拒绝") },
  { mode: "ask", label: uiText("每次询问") },
  { mode: "allow", label: uiText("允许") },
]));

function editableMode(mode: PermissionStudioPermit["mode"]): PermissionStudioEditableMode | null {
  return mode === "deny" || mode === "ask" || mode === "allow" ? mode : null;
}

function modeTone(mode: PermissionStudioPermit["mode"]): UiTagTone {
  if (mode === "allow") return "success";
  if (mode === "ask") return "warning";
  if (mode === "block") return "danger";
  return "neutral";
}

function ExplainChain({ explanation }: { explanation: PermissionStudioExplanation }) {
  useDashboardLanguage();
  return (
    <div className={styles.explanation} aria-label={uiText("服务端 EXPLAIN")}>
      <div className={styles.verdict}>{explanation.verdict}</div>
      {explanation.summary ? <p>{explanation.summary}</p> : null}
      <ol className={styles.steps}>
        {explanation.steps.map((step, index) => (
          <li key={`${step.stage}:${index}`} data-stage={step.stage}>
            <span className={styles.stepNumber}>{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
              {step.verdict ? <UiTag>{step.verdict}</UiTag> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PermissionStudio({ owner }: { owner: string }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const [selectedPermitId, setSelectedPermitId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<PermissionStudioEditableMode | null>(null);
  const [preview, setPreview] = useState<PermissionStudioExplainResponse | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    kind: "ok" | "pending";
    message: string;
  } | null>(null);
  const generationRef = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const studio = useQuery({
    queryKey: ["permissions", "studio", owner],
    queryFn: () =>
      api<PermissionStudioProjection>(
        `/api/permissions/studio${query({ username: owner })}`,
      ),
  });

  const projection = studio.data;
  const allPermits = useMemo(
    () => [...(projection?.permits ?? []), ...(projection?.appDefaults.permits ?? [])],
    [projection],
  );
  const selectedPermit = selectedPermitId
    ? allPermits.find((permit) => permit.id === selectedPermitId) ?? null
    : null;

  useEffect(() => {
    if (mutationError) errorRef.current?.focus();
  }, [mutationError]);

  const explain = useMutation({
    mutationFn: ({
      permit,
      mode,
    }: {
      generation: number;
      permit: PermissionStudioPermit;
      mode: PermissionStudioEditableMode;
    }) => {
      const body: PermissionStudioExplainRequest = {
        username: owner,
        resource_id: permit.resourceId,
        holder_id: permit.holderId,
        operation: permit.operation,
        proposed_mode: mode,
      };
      return api<PermissionStudioExplainResponse>("/api/permissions/studio/explain", {
        method: "POST",
        json: body,
      });
    },
    retry: false,
    onSuccess: (next, variables) => {
      if (
        variables.generation !== generationRef.current ||
        variables.permit.id !== selectedPermitId
      ) {
        return;
      }
      setPreview(next);
      setMutationError(null);
      setResult(null);
    },
    onError: (err, variables) => {
      if (
        variables.generation !== generationRef.current ||
        variables.permit.id !== selectedPermitId
      ) {
        return;
      }
      setMutationError(errorText(err));
    },
  });

  const apply = useMutation({
    mutationFn: ({ proposalId }: { generation: number; permitId: string; proposalId: string }) => {
      const body: PermissionStudioApplyRequest = {
        username: owner,
        proposal_id: proposalId,
      };
      return api<PermissionStudioApplyResponse>("/api/permissions/studio/apply", {
        method: "POST",
        json: body,
      });
    },
    retry: false,
    onSuccess: async (next, variables) => {
      if (
        variables.generation !== generationRef.current ||
        variables.permitId !== selectedPermitId
      ) {
        return;
      }
      if (next.status === "refused") {
        setMutationError(next.message);
        return;
      }
      if (next.status === "pending") {
        setResult({ kind: "pending", message: next.message });
        return;
      }
      setMutationError(null);
      setPreview(null);
      setResult({ kind: "ok", message: next.message });
      await client.invalidateQueries({ queryKey: ["permissions", "studio", owner] });
      void client.invalidateQueries({ queryKey: ["permissions", "subjects", owner] });
      void client.invalidateQueries({ queryKey: ["permissions", "audit", owner] });
      if (variables.generation !== generationRef.current) return;
      const refreshed = client.getQueryData<PermissionStudioProjection>([
        "permissions",
        "studio",
        owner,
      ]);
      const current = [
        ...(refreshed?.permits ?? []),
        ...(refreshed?.appDefaults.permits ?? []),
      ].find((permit) => permit.id === variables.permitId);
      if (current) setDraftMode(editableMode(current.mode));
    },
    onError: (err, variables) => {
      if (
        variables.generation !== generationRef.current ||
        variables.permitId !== selectedPermitId
      ) {
        return;
      }
      setMutationError(errorText(err));
    },
  });

  const openPermit = (permit: PermissionStudioPermit) => {
    generationRef.current += 1;
    setSelectedPermitId(permit.id);
    setDraftMode(editableMode(permit.mode));
    setPreview(null);
    setMutationError(null);
    setResult(null);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    generationRef.current += 1;
    setDrawerOpen(false);
  };

  const changeDraft = (mode: PermissionStudioEditableMode) => {
    generationRef.current += 1;
    setDraftMode(mode);
    setPreview(null);
    setMutationError(null);
    setResult(null);
  };

  const previewExplanation: PermissionStudioExplanation | null = preview
    ? { verdict: preview.verdict, summary: preview.summary, steps: preview.steps }
    : selectedPermit?.explanation ?? null;

  const resourceById = useMemo(
    () => new Map((projection?.resources ?? []).map((resource) => [resource.id, resource])),
    [projection],
  );
  const holderById = useMemo(
    () => new Map((projection?.holders ?? []).map((holder) => [holder.id, holder])),
    [projection],
  );
  const selectedIsAppDefault = Boolean(
    selectedPermit &&
      projection?.appDefaults.permits.some((permit) => permit.id === selectedPermit.id),
  );
  const selectedResourceTitle = selectedPermit
    ? resourceById.get(selectedPermit.resourceId)?.title ??
      (selectedIsAppDefault ? projection?.appDefaults.title : selectedPermit.resourceId)
    : "";
  const selectedHolderTitle = selectedPermit
    ? holderById.get(selectedPermit.holderId)?.title ??
      (selectedIsAppDefault ? uiText("新 App") : selectedPermit.holderId)
    : "";

  return (
    <section className={styles.studio} aria-labelledby="permission-studio-title">
      <div className={styles.heading}>
        <div>

          <h2 id="permission-studio-title">{uiText("权限观测")}</h2>
          <p>{uiText("沿资源目录查看授权对象、操作和裁决原因。")}</p>
        </div>
        <UiButton loading={studio.isFetching} onClick={() => void studio.refetch()}>
          {uiText("刷新投影")}</UiButton>
      </div>

      {studio.isPending ? (
        <UiCard className={styles.stateCard}>{uiText("正在加载服务端权限投影…")}</UiCard>
      ) : studio.isError ? (
        <UiAlert tone="error" title={uiText("权限观测加载失败")}>
          {errorText(studio.error)}{uiText("。不会自动重试；请手动刷新。")}</UiAlert>
      ) : null}
      {projection ? (
        <>
          {(projection.coverage?.notices ?? []).map((notice) => (
            <UiAlert key={notice} tone="warning" title={uiText("投影范围提示")}>
              {notice}
            </UiAlert>
          ))}
          <ResourceBrowser projection={projection} onOpen={openPermit} />
          <details className={styles.defaultsCard}><summary>{uiText("新 App 授权草稿默认值")}</summary>
<UiCard>
            <div className={styles.cardHeading}>
              <div>
                <h3>{projection.appDefaults.title}</h3>
                <p>{projection.appDefaults.description}</p>
              </div>
              <UiTag tone="info">{uiText("新 App 默认")}</UiTag>
            </div>
            <UiAlert tone="info">
              {uiText("这里只设置新 App 草稿默认值，不影响已安装 App。")}</UiAlert>
            <div className={styles.defaultPermits}>
              {projection.appDefaults.permits.map((permit) => (
                <UiButton
                  key={permit.id}
                  className={styles.defaultPermit}
                  onClick={() => openPermit(permit)}
                >
                  <span>{permit.operationLabel}</span>
                  <UiTag tone={modeTone(permit.mode)}>{permit.mode}</UiTag>
                  <small>{permit.verdict}</small>
                </UiButton>
              ))}
            </div>
          </UiCard></details>

          {projection.permits.some((permit) => permit.compatibility) ? (
            <UiAlert tone="info" title={uiText("兼容投影")}>
              {uiText("兼容来源仍由原控制面管理；是否可编辑由服务端决定。")}</UiAlert>
          ) : null}
        </>
      ) : null}

      <Dialog
        open={drawerOpen}
        onOpenChange={(next) => {
          if (!next) closeDrawer();
        }}
        variant="drawer"
        width={560}
        title={
          selectedPermit
            ? `${selectedHolderTitle} → ${selectedResourceTitle}`
            : uiText("权限解释")
        }
        description={
          selectedPermit
            ? selectedPermit.operationLabel
            : undefined
        }
        footer={
          selectedPermit?.editable ? (
            <div className={styles.drawerFooter}>
              <UiButton onClick={closeDrawer} disabled={explain.isPending || apply.isPending}>
                {uiText("关闭")}</UiButton>
              <UiButton
                onClick={() => {
                  if (!selectedPermit || !draftMode) return;
                  explain.mutate({
                    generation: generationRef.current,
                    permit: selectedPermit,
                    mode: draftMode,
                  });
                }}
                loading={explain.isPending}
                disabled={!draftMode || apply.isPending || result?.kind === "pending"}
              >
                {uiText("预演并解释")}</UiButton>
              {preview?.proposal_id ? (
                <UiButton
                  tone="primary"
                  loading={apply.isPending}
                  disabled={explain.isPending || result?.kind === "pending"}
                  onClick={() =>
                    apply.mutate({
                      generation: generationRef.current,
                      permitId: selectedPermit.id,
                      proposalId: preview.proposal_id!,
                    })
                  }
                >
                  {uiText("应用此提案")}</UiButton>
              ) : null}
            </div>
          ) : (
            <UiButton onClick={closeDrawer}>{uiText("关闭")}</UiButton>
          )
        }
      >
        {selectedPermit && previewExplanation ? (
          <div className={styles.drawerBody}>
            <div className={styles.decisionMeta}>
              <UiTag tone={modeTone(selectedPermit.mode)}>{selectedPermit.mode}</UiTag>
              <span>{selectedPermit.verdict}</span>
              {selectedPermit.compatibility ? <UiTag tone="info">{uiText("兼容")}</UiTag> : null}
            </div>

            <ExplainChain explanation={previewExplanation} />

            {selectedPermit.editable ? (
              <fieldset className={styles.modeEditor}>
                <legend>{uiText("拟议模式")}</legend>
                {EDITABLE_MODES().map(({ mode, label }) => (
                  <UiRadio
                    key={mode}
                    name={`permission-mode-${selectedPermit.id}`}
                    value={mode}
                    checked={draftMode === mode}
                    onChange={() => changeDraft(mode)}
                  >
                    {label}
                  </UiRadio>
                ))}
              </fieldset>
            ) : (
              <UiAlert tone="info" title={uiText("只读")}>
                {selectedPermit.readonlyReason ?? uiText("服务端未将这项裁决标记为可编辑。")}
              </UiAlert>
            )}

            {preview && !preview.proposal_id && selectedPermit.editable ? (
              <UiAlert tone="warning" title={uiText("仅解释")}>
                {uiText("服务端没有签发可应用的提案；当前预演保持只读。")}</UiAlert>
            ) : null}
            {result ? (
              <UiAlert
                tone={result.kind === "ok" ? "success" : "warning"}
                title={result.kind === "ok" ? uiText("已应用 · 已重新请求投影") : uiText("仍在处理")}
              >
                {result.message}
                {result.kind === "pending" ? uiText("。不会自动刷新。") : null}
              </UiAlert>
            ) : null}
            {mutationError ? (
              <div ref={errorRef} tabIndex={-1}>
                <UiAlert tone="error" title={uiText("服务端拒绝")}>
                  {mutationError}{uiText("。草稿已保留，可重新预演。")}</UiAlert>
              </div>
            ) : null}
          </div>
        ) : (
          <UiEmpty>{uiText("这项服务端投影已不可用，请关闭后重新选择。")}</UiEmpty>
        )}
      </Dialog>
    </section>
  );
}
