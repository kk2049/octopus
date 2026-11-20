import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue, localizedLabels } from "../../i18n/ui-text.js";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import type { ArchFrontendModule } from "../ArchitecturePage.js";
import styles from "../ArchitecturePage.module.css";

const SEARCH_ROWS = localizedLabels(() => ([
  uiText("工单 #95 · 架构模块实景图"),
  uiText("部署检查 · lht-val15"),
  uiText("Session Plus · 工作区"),
]));

const TREE_ROWS = localizedLabels((): Readonly<Record<string, readonly string[]>> => ({
  "session.roster-tree/v1": ["▾ octopus", uiText("  工单 #95"), uiText("  日常秘书"), uiText("▸ 已归档")],
  "session.directory-index/v1": [uiText("▾ 工单 #95"), uiText("  ◉ 对话"), "  ▾ ticket-95", "    ArchitecturePage.tsx"],
  "workspace.file-tree/v1": ["▾ src", "  ▸ pages", "  App.tsx", "README.md"],
  "crdt.doc-list/v1": [uiText("发布检查清单"), uiText("架构方案"), uiText("周报草稿")],
  "deck.outline/v1": [uiText("01 · 架构现状"), uiText("02 · 自动发现"), uiText("03 · 验收")],
  "data.list/v1": [uiText("架构页面"), uiText("模块目录"), uiText("自动分析快照")],
}));

const BOARD = [
  "♜", "♞", "♝", "♛", "♚", "♝", "♞", "♜",
  "♟", "♟", "♟", "♟", "♟", "♟", "♟", "♟",
  "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "",
  "", "", "", "", "♙", "", "", "",
  "", "", "", "", "", "♘", "", "",
  "♙", "♙", "♙", "♙", "", "♙", "♙", "♙",
  "♖", "♘", "♗", "♕", "♔", "♗", "", "♖",
];

const SLIDES = localizedLabels(() => ([
  { kicker: "OCTOPUS", title: uiText("架构会自己生长"), body: uiText("模块来自当前源码，而不是一张过期清单。") },
  { kicker: "VIEW MODULES", title: uiText("最小示例"), body: uiText("每个前端模组都展示可操作的真实内容。") },
  { kicker: "DELIVERY", title: uiText("合入后验证"), body: uiText("GitLab CI 在 lht-val15 异步完成全量检查。") },
]));

function DemoFrame({ module, children }: { module: ArchFrontendModule; children: ReactNode }) {
  useDashboardLanguage();
  return (
    <section className={styles.moduleDemo} aria-label={uiText("{v0} 的交互最小示例", { v0: module.title })}>
      <header className={styles.moduleDemoChrome}>
        <span>{uiText("交互最小示例")}</span>
        <strong>{module.title}</strong>
      </header>
      <div className={styles.moduleDemoBody}>{children}</div>
    </section>
  );
}

/**
 * A capability-free, in-memory example of the contribution selected in the
 * architecture catalog. These controls intentionally do not import or execute
 * an untrusted View inside the trusted Dashboard origin; they render semantic
 * sample content and interactions without a Host, identity, port, or resource.
 */
export function FrontendModuleDemo({ module }: { module: ArchFrontendModule }) {
  const language = useDashboardLanguage();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState("把圈圈图改成自动发现。");
  const [sent, setSent] = useState("");
  const [submitted, setSubmitted] = useState<UiTextValue>("");

  const searchRows = useMemo(
    () => SEARCH_ROWS().filter((row) => row.toLowerCase().includes(query.trim().toLowerCase())),
    [query, language],
  );

  if (module.preview === "search") {
    return (
      <DemoFrame module={module}>
        <label className={styles.demoSearchLabel}>
          <span>{uiText("搜索会话")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={uiText("标题或工单号")}
          />
        </label>
        <div className={styles.demoResultList}>
          {searchRows.map((row, index) => (
            <button type="button" key={row} data-active={selected === index} onClick={() => setSelected(index)}>
              <strong>{row}</strong><span>{index === 0 ? uiText("刚刚") : uiText("{v0} 小时前", { v0: index + 1 })}</span>
            </button>
          ))}
          {searchRows.length === 0 && <p className={styles.demoEmpty}>{uiText("没有匹配的会话")}</p>}
        </div>
      </DemoFrame>
    );
  }

  if (module.preview === "tree") {
    const rows = TREE_ROWS()[module.id] ?? [uiText("▾ 项目"), uiText("  模块说明"), uiText("  最小示例"), uiText("▸ 更多")];
    return (
      <DemoFrame module={module}>
        <div className={styles.demoTree}>
          {rows.map((row, index) => (
            <button type="button" key={`${row}:${index}`} data-active={selected === index} onClick={() => setSelected(index)}>
              {row}
            </button>
          ))}
        </div>
        <p className={styles.demoSelection}>{uiText("当前：")}{rows[selected]?.trim()}</p>
      </DemoFrame>
    );
  }

  if (module.preview === "chat") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const message = draft.trim();
      if (!message) return;
      setSent(message);
      setDraft("");
    };
    return (
      <DemoFrame module={module}>
        <div className={styles.demoChatLog}>
          <p data-side="user">{uiText("架构页面为什么一直没变化？")}</p>
          <p data-side="agent">{uiText("新包被合并进同一个未归属圆了。我会让它们自动分开展示。")}</p>
          {sent && <p data-side="user">{sent}</p>}
        </div>
        <form className={styles.demoComposer} onSubmit={submit}>
          <input aria-label={uiText("示例消息")} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
          <button type="submit">{uiText("发送")}</button>
        </form>
      </DemoFrame>
    );
  }

  if (module.preview === "document") {
    const editor = module.id === "workspace.editor/v1";
    const typst = module.id === "deck.typst/v1";
    return (
      <DemoFrame module={module}>
        <div className={styles.demoDocumentHead}>
          <strong>{typst ? "architecture.typ" : editor ? "ArchitecturePage.tsx" : uiText("架构模块说明.md")}</strong>
          <span>{editor || typst ? uiText("可编辑") : uiText("只读")}</span>
        </div>
        {editor || typst ? (
          <textarea
            className={styles.demoEditor}
            aria-label={uiText("{v0} 示例内容", { v0: module.title })}
            defaultValue={typst
              ? "#slide[\n  = 架构会自己生长\n  * 自动发现新模块\n]"
              : "export function ArchitecturePage() {\n  return <ModuleEcosystemView />;\n}"}
          />
        ) : (
          <article className={styles.demoDocument}>
            <h5>{uiText("模块地图")}</h5>
            <p>{uiText("每次分析都从当前 workspace 和源码重新计算模块体量。")}</p>
            <ul><li>{uiText("新包自动出现")}</li><li>{uiText("未知信任归属保持醒目")}</li></ul>
          </article>
        )}
      </DemoFrame>
    );
  }

  if (module.preview === "form") {
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setSubmitted(String(data.get("title") || "") || uiMessage("未命名任务"));
    };
    return (
      <DemoFrame module={module}>
        <form className={styles.demoForm} onSubmit={submit}>
          <label>{uiText("任务标题")}<input name="title" defaultValue={uiText("检查架构快照")} /></label>
          <label>{uiText("工作目录")}<input name="directory" defaultValue="ticket-95" /></label>
          <button type="submit">{module.id === "session.new/v1" ? uiText("启动 Agent") : uiText("提交")}</button>
        </form>
        {uiValue(submitted) && <p className={styles.demoNotice} role="status">{uiText("示例已接收：")}{uiValue(submitted)}</p>}
      </DemoFrame>
    );
  }

  if (module.preview === "board") {
    return (
      <DemoFrame module={module}>
        <div className={styles.demoBoard} aria-label={uiText("可点选的示例棋盘")}>
          {BOARD.map((piece, index) => (
            <button
              type="button"
              key={index}
              data-active={selected === index}
              aria-label={`${String.fromCharCode(97 + index % 8)}${8 - Math.floor(index / 8)}${piece ? ` ${piece}` : uiText(" 空格")}`}
              onClick={() => setSelected(index)}
            >
              {piece}
            </button>
          ))}
        </div>
        <p className={styles.demoSelection}>{uiText("已选择 ")}{String.fromCharCode(97 + selected % 8)}{8 - Math.floor(selected / 8)}</p>
      </DemoFrame>
    );
  }

  if (module.preview === "slides") {
    const slide = SLIDES()[selected % SLIDES().length]!;
    return (
      <DemoFrame module={module}>
        <div className={styles.demoSlides}>
          <nav aria-label={uiText("示例幻灯片")}>
            {SLIDES().map((entry, index) => (
              <button type="button" key={entry.title} data-active={selected === index} onClick={() => setSelected(index)}>
                <span>{index + 1}</span>{entry.title}
              </button>
            ))}
          </nav>
          <article>
            <small>{slide.kicker}</small>
            <h5>{slide.title}</h5>
            <p>{slide.body}</p>
          </article>
        </div>
      </DemoFrame>
    );
  }

  if (module.preview === "detail") {
    return (
      <DemoFrame module={module}>
        <div className={styles.demoDetailHead}><strong>{uiText("架构快照")}</strong><span>{uiText("当前版本")}</span></div>
        <dl className={styles.demoFacts}>
          <dt>{uiText("状态")}</dt><dd>{uiText("自动分析完成")}</dd>
          <dt>{uiText("提交")}</dt><dd className={styles.mono}>ticket/95-dev</dd>
          <dt>{uiText("模块")}</dt><dd>{uiText("按 workspace 实时发现")}</dd>
          <dt>{uiText("负责人")}</dt><dd>lht</dd>
        </dl>
      </DemoFrame>
    );
  }

  if (module.preview === "status") {
    return (
      <DemoFrame module={module}>
        <div className={styles.demoStatusList}>
          <button type="button" data-tone="ok"><span>✓</span><strong>{uiText("代码已提交")}</strong><small>{uiText("完成")}</small></button>
          <button type="button" data-tone="run"><span>↻</span><strong>GitLab CI</strong><small>{uiText("异步")}</small></button>
          <button type="button" data-tone="wait"><span>○</span><strong>{uiText("部署确认")}</strong><small>{uiText("待执行")}</small></button>
        </div>
      </DemoFrame>
    );
  }

  return (
    <DemoFrame module={module}>
      <div className={styles.demoPanel}>
        <span className={styles.demoPanelIcon}>◇</span>
        <div><strong>{module.title}</strong><p>{module.summary}</p></div>
        <button type="button" onClick={() => setSubmitted(uiMessage("已在示例中打开"))}>{uiText("打开")}</button>
      </div>
      {uiValue(submitted) && <p className={styles.demoNotice} role="status">{uiValue(submitted)}</p>}
    </DemoFrame>
  );
}
