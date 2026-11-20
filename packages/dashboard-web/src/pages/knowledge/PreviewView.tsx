import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/** 试算启动包 — what a ticket agent would be handed for this requirement text. */
import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { Markdown } from "../../ui/Markdown.js";
import { ErrorBox } from "../../ui/misc.js";
import { UiButton } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import type { WikiPreview } from "./types.js";

export function PreviewView() {
  useDashboardLanguage();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const preview = useMutation({
    mutationFn: () => api<WikiPreview>("/api/knowledge/preview", { method: "POST", json: { title, body } }),
  });
  return (
    <>
      <p className={styles.lead}>{uiText("粘贴需求，预览工单 agent 获得的知识上下文。")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) preview.mutate();
        }}
      >
        <input className={styles.searchInput} style={{ width: "100%", marginBottom: 8 }} placeholder={uiText("标题（可选）")} value={title} onChange={(event) => setTitle(event.target.value)} aria-label={uiText("标题")} />
        <textarea className={styles.textarea} placeholder={uiText("需求正文")} value={body} onChange={(event) => setBody(event.target.value)} aria-label={uiText("需求正文")} />
        <div className={styles.actions}>
          <UiButton htmlType="submit" disabled={!body.trim() || preview.isPending}>
            {preview.isPending ? uiText("装配中…") : uiText("试算")}
          </UiButton>
          {preview.data && <span className={styles.reviewState}>{preview.data.chars} {uiText(" 字符 · ")}{preview.data.included} {uiText(" 条记录")}</span>}
        </div>
      </form>
      {preview.error && <ErrorBox>{errorText(preview.error)}</ErrorBox>}
      {preview.data && (
        <>
          <div className={styles.chips} style={{ margin: "12px 0" }}>
            {preview.data.capabilities.map((item) => (
              <Link key={item.id} className={styles.chip} to={`/knowledge?v=capability&id=${encodeURIComponent(item.id)}`} title={item.why.join("；")}>
                {item.id} · {item.certainty}
              </Link>
            ))}
          </div>
          <div className={styles.packText}>
            <Markdown>{preview.data.text}</Markdown>
          </div>
        </>
      )}
    </>
  );
}
