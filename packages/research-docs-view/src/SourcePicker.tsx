import { useEffect, useState } from "react";
import type { Call } from "@claude-bot/research-docs-contract";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import {
  pluginFor,
  plugins,
  resourceFromNode,
  type ResourceProps,
} from "./plugins.js";
export function SourcePicker({
  call,
  onInsert,
  onClose,
  onImport,
}: {
  call: Call;
  onInsert: (r: ResourceProps) => void;
  onClose: () => void;
  onImport: (project: string, nodes: ResearchNode[]) => Promise<void>;
}) {
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]),
    [project, setProject] = useState(""),
    [nodes, setNodes] = useState<ResearchNode[]>([]),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    call<{ projects: { id: string; title: string }[] }>("sources")
      .then((r) => {
        if (alive) setProjects(r.projects);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [call]);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    setBusy(true);
    setError("");
    setNodes([]);
    void (async () => {
      try {
        let after: string | undefined;
        const result: ResearchNode[] = [];
        for (let i = 0; i < 50; i++) {
          const page = await call<{
            nodes: ResearchNode[];
            next: string | null;
          }>("source", { project, after });
          if (!alive) return;
          result.push(...page.nodes.filter((n) => !n.archived));
          if (!page.next) {
            setNodes(result);
            return;
          }
          after = page.next;
        }
        throw new Error("项目超过本次读取范围，请从原科研平台精简后再导入");
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project, call]);
  const filtered = nodes.filter(
    (n) =>
      (!kind || plugins.find((p) => p.accepts(n))?.id === kind) &&
      [n.title, n.summary]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div
      className="rd-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="插入科研元件"
        className="rd-modal rd-picker"
      >
        <header>
          <div>
            <span className="rd-eyebrow">让资料成为正文的一部分</span>
            <h2>插入科研元件</h2>
          </div>
          <button onClick={onClose} aria-label="关闭插入面板">
            ×
          </button>
        </header>
        <div className="rd-modal-content">
          <label>
            来源项目
            <select
              aria-label="来源项目"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">选择一个已授权项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <input
            autoFocus
            aria-label="搜索来源资料"
            placeholder="搜索文件、Agent、会议或任务…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="rd-filter-row">
            <button aria-pressed={!kind} onClick={() => setKind("")}>
              全部
            </button>
            {plugins.map((p) => (
              <button
                key={p.id}
                aria-pressed={kind === p.id}
                onClick={() => setKind(p.id)}
              >
                {p.icon} {p.label}
              </button>
            ))}
          </div>
          {error && (
            <p className="rd-error" role="alert">
              {error}
            </p>
          )}
          {busy ? (
            <p role="status">正在读取项目资料目录…</p>
          ) : (
            <div className="rd-source-list">
              {filtered.slice(0, 150).map((n) => {
                const item = resourceFromNode(project, n);
                return (
                  <button
                    key={n.id}
                    onClick={() =>
                      onInsert({ ...item.props, file: "", media: "", size: 0 })
                    }
                  >
                    <span className="rd-source-icon">
                      {pluginFor(item.props.plugin).icon}
                    </span>
                    <span>
                      <strong>{n.title}</strong>
                      <small>
                        {n.summary || pluginFor(item.props.plugin).label}
                      </small>
                    </span>
                    <span>＋</span>
                  </button>
                );
              })}
              {project && filtered.length === 0 && (
                <p className="rd-muted">没有匹配的资料。</p>
              )}
              {!project && (
                <p className="rd-empty-hint">
                  选择来源后，将文件和 Agent 放进文档。原项目的授权继续有效。
                </p>
              )}
            </div>
          )}
        </div>
        <footer>
          <span>这里只引用资料。打开 Agent 后才可发送任务。</span>
          <button
            disabled={!nodes.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onImport(project, nodes);
                onClose();
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            把项目整理成文档
          </button>
        </footer>
      </section>
    </div>
  );
}
