/**
 * `/doc-key#i=dsi_…` — the claim page of a Feishu document's access keys
 * (`packages/bot/src/feishu/doc-share.ts`).
 *
 * Someone who cannot see the document's Octopus card (outside the tenant,
 * say) takes a key here, within the card owner's ceiling and limits. There is
 * no Dashboard login: the link's secret is the authority. It lives in the URL
 * fragment, which no request carries. This page reads it once, takes it out of
 * the address bar and history before asking anything, and sends it only in the
 * bodies of the docs add-on's two same-origin claim calls. The key's token
 * arrives once, in the claim's answer, and lives only in this component.
 */

import { useEffect, useRef, useState } from "react";
import { LanguagePicker } from "../app/LanguagePicker.js";
import { api, errorText } from "../lib/api.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiMessage, uiText, uiValue, type UiTextValue } from "../i18n/ui-text.js";
import { UiAlert, UiButton, UiCard, UiForm, UiFormItem, UiInput, UiRadio, UiTabs } from "../ui-kit/primitives.js";
import styles from "./DocKeyPage.module.css";

/** The docs add-on's claim calls; they answer only this origin's own pages. */
const CLAIM = "/api/feishu/docs-addon/";
const SECRET = /^dsi_[A-Za-z0-9_-]{43}$/;

type Rights = "read" | "write";
interface InviteInfo { doc_title: string; self_serve: "off" | Rights }
interface Connect { claude: string; codex: string; endpoint: string; token: string }
interface Claimed { share: { label: string; rights: Rights }; connect: Connect }
interface Status { text: UiTextValue; bad: boolean }

export function DocKeyPage() {
  useDashboardLanguage();
  const secret = useRef<string | null>(null);
  const opening = useRef<Promise<InviteInfo> | null>(null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [status, setStatus] = useState<Status>({ text: uiMessage("正在读取领取链接…"), bad: false });
  const [label, setLabel] = useState("");
  const [rights, setRights] = useState<Rights>("write");
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<Claimed | null>(null);

  useEffect(() => {
    let alive = true;
    if (secret.current === null) {
      secret.current = new URLSearchParams(window.location.hash.slice(1)).get("i") ?? "";
      window.history.replaceState(null, "", window.location.pathname);
    }
    const invite = secret.current;
    if (!SECRET.test(invite)) {
      setStatus({ text: uiMessage("链接不完整：请向文档所有者要完整的领取链接（# 后面的部分也要带上）"), bad: true });
      return;
    }
    // Once, however often React mounts this (StrictMode mounts twice).
    opening.current ??= api<InviteInfo>(`${CLAIM}invite-info`, { method: "POST", json: { invite } });
    opening.current.then((found) => {
      if (!alive) return;
      setInfo(found);
      if (found.self_serve === "off") {
        setStatus({ text: uiMessage("文档所有者现在没有开放自助领取，不能领取访问密钥"), bad: true });
        return;
      }
      setRights(found.self_serve);
      setStatus({ text: "", bad: false });
    }, (error: unknown) => {
      if (alive) setStatus({ text: errorText(error), bad: true });
    });
    return () => { alive = false; };
  }, []);

  const claim = async () => {
    const name = label.replace(/\s+/g, " ").trim();
    if (!name) {
      setStatus({ text: uiMessage("请先填一个名字"), bad: true });
      return;
    }
    setBusy(true);
    setStatus({ text: uiMessage("正在领取…"), bad: false });
    try {
      const answer = await api<Claimed>(`${CLAIM}invite-claim`, { method: "POST", json: { invite: secret.current, label: name, rights } });
      setClaimed(answer);
      setStatus({
        text: uiMessage("已领取「{label}」（{rights}）。", { label: answer.share.label, rights: uiMessage(answer.share.rights === "write" ? "读写" : "只读") }),
        bad: false,
      });
    } catch (error) {
      setStatus({ text: errorText(error), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const open = info !== null && info.self_serve !== "off" && claimed === null;
  return (
    <div className={styles.wrap}>
      <UiCard className={styles.box}>
        <p className={styles.brand}>{uiText("Octopus 文档协作")}</p>
        <h1>{uiText("领取访问密钥")}</h1>
        {info ? <p className={styles.doc}>{uiText("文档：《{title}》", { title: info.doc_title || uiText("飞书文档") })}</p> : null}
        <LanguagePicker className={styles.languagePick} />
        {status.text ? <p className={status.bad ? styles.bad : styles.status} role="status" aria-live="polite">{uiValue(status.text)}</p> : null}
        {open ? (
          <UiForm layout="vertical" requiredMark={false} onFinish={() => void claim()}>
            <UiFormItem label={uiText("名字")} htmlFor="doc-key-label">
              <UiInput id="doc-key-label" value={label} maxLength={60} autoComplete="off" autoFocus
                placeholder={uiText("例如你的名字，或这个 Agent 的用途")} onChange={(event) => setLabel(event.target.value)} />
            </UiFormItem>
            <fieldset className={styles.rights}>
              <legend>{uiText("权限")}</legend>
              <UiRadio name="rights" value="write" checked={rights === "write"} disabled={info.self_serve !== "write"} onChange={() => setRights("write")}>
                <span>
                  <b>{uiText("读写")}</b>
                  <small>{info.self_serve === "write" ? uiText("Agent 可以读取并修改这篇文档") : uiText("文档所有者只开放了只读密钥")}</small>
                </span>
              </UiRadio>
              <UiRadio name="rights" value="read" checked={rights === "read"} onChange={() => setRights("read")}>
                <span>
                  <b>{uiText("只读")}</b>
                  <small>{uiText("Agent 只能读取这篇文档")}</small>
                </span>
              </UiRadio>
            </fieldset>
            <UiButton htmlType="submit" tone="primary" loading={busy} block>{uiText("领取密钥")}</UiButton>
            <p className={styles.hint}>
              {uiText("密钥让你的 Agent（Claude Code、Codex 或其他 MCP 客户端）经 Octopus 访问这一篇飞书文档，碰不到别的文档；文档所有者随时可以终止它。")}
            </p>
          </UiForm>
        ) : null}
        {claimed ? <WaysIn connect={claimed.connect} /> : null}
      </UiCard>
    </div>
  );
}

/** The new key's ways in, shown this once. */
function WaysIn({ connect }: { connect: Connect }) {
  return (
    <section className={styles.done}>
      <UiAlert tone="warning" title={uiText("密钥只显示这一次，等同密码。")}>
        {uiText("请现在保存，或直接运行下面的命令；不要把它发到群聊或文档里。离开或刷新这个页面后就看不到了。")}
      </UiAlert>
      <UiTabs
        items={[
          { key: "claude", label: "Claude Code", children: <Way hint={uiText("在终端运行，之后在任何项目里都能用：")} value={connect.claude} copy={uiText("复制命令")} /> },
          { key: "codex", label: "Codex", children: <Way hint={uiText("在终端运行，把连接写进 ~/.codex/config.toml，然后重启 Codex：")} value={connect.codex} copy={uiText("复制命令")} /> },
          {
            key: "other",
            label: uiText("其他客户端"),
            children: (
              <>
                <Way hint={uiText("MCP 地址（Streamable HTTP）：")} value={connect.endpoint} copy={uiText("复制地址")} />
                <Way hint={uiText("每个请求都带上这个请求头：")} value={`Authorization: Bearer ${connect.token}`} copy={uiText("复制请求头")} />
              </>
            ),
          },
        ]}
      />
      <p className={styles.hint}>{uiText("接入后，Agent 会看到以 feishu_shared_doc_ 开头的工具。")}</p>
    </section>
  );
}

/** One line to copy: through the clipboard, or, where the browser refuses, selected for copying by hand. */
function Way({ hint, value, copy }: { hint: string; value: string; copy: string }) {
  const box = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState<"copied" | "selected" | null>(null);
  const select = () => {
    const selection = window.getSelection();
    if (!box.current || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(box.current);
    selection.removeAllRanges();
    selection.addRange(range);
    setDone("selected");
  };
  const onCopy = () => {
    if (!navigator.clipboard) { select(); return; }
    navigator.clipboard.writeText(value).then(() => setDone("copied"), select);
  };
  return (
    <div className={styles.way}>
      <p>{hint}</p>
      <pre ref={box} className={styles.code}>{value}</pre>
      <UiButton onClick={onCopy}>{done === "copied" ? uiText("已复制") : done === "selected" ? uiText("已选中，请手动复制") : copy}</UiButton>
    </div>
  );
}
