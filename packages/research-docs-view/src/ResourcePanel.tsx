import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Call, DocsBoot } from "@claude-bot/research-docs-contract";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import { AgentWindow } from "../../research-canvas-view/src/windows/AgentWindow.js";
import { FileWindow } from "../../research-canvas-view/src/windows/FileWindow.js";
import { AudioWindow } from "../../research-canvas-view/src/windows/AudioWindow.js";
import { AudioUploadController } from "../../research-canvas-view/src/audio-upload.js";
import "../../research-canvas-view/src/audio.css";
import "../../research-canvas-view/src/windows/agent-window.css";
import { pluginFor, type ResourceProps } from "./plugins.js";
import { readAttachment } from "./attachments.js";
export function ResourcePanel({
  resource,
  call,
  boot,
  page,
  onClose,
  onNavigate,
}: {
  onNavigate: (resource: ResourceProps) => void;
  resource: ResourceProps;
  call: Call;
  boot: DocsBoot;
  page: string;
  onClose: () => void;
}) {
  const sourceCall = useCallback<Call>(
    (action, params = {}) =>
      call("source_call", { project: resource.project, action, params }),
    [call, resource.project],
  );
  const [node, setNode] = useState<ResearchNode | null>(null),
    [error, setError] = useState(""),
    [body, setBody] = useState(""),
    [path, setPath] = useState(""),
    [version, setVersion] = useState<string>();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const g = ++generation.current;
    setError("");
    try {
      const result = await sourceCall<{
        node?: ResearchNode;
        resource?: ResearchNode;
        ref?: string;
      }>("ref_describe", { ref: resource.node });
      if (g !== generation.current) return;
      const data = result.node ?? result.resource;
      if (data) setNode(data);
      else {
        // Resolve metadata by stable ID without reading any file or transcript.
        let after: string | undefined;
        for (let n = 0; n < 30; n++) {
          const graph = await call<{
            nodes: ResearchNode[];
            next: string | null;
          }>("source", { project: resource.project, after });
          if (g !== generation.current) return;
          const found = graph.nodes.find(
            (n) => n.id === resource.node || n.ref === resource.node,
          );
          if (found) {
            setNode(found);
            break;
          }
          if (!graph.next) throw new Error("引用的资源已从原项目移除");
          after = graph.next;
        }
      }
    } catch (e) {
      if (g === generation.current) setError(String(e));
    }
  }, [resource.node, sourceCall, call, resource.project]);
  useEffect(() => {
    if (!resource.file) void load();
    return () => {
      generation.current++;
    };
  }, [resource.file, load]);
  const audio = useMemo(
    () =>
      new AudioUploadController(
        sourceCall,
        resource.node,
        "docs:" + boot.viewer + ":" + resource.project,
      ),
    [sourceCall, resource.node, boot.viewer, resource.project],
  );
  useEffect(() => () => audio.close(), [audio]);
  useEffect(() => {
    if (!node || ["agent", "audio", "file"].includes(node.type)) return;
    let live = true;
    sourceCall<{ text?: string }>("document_read", {
      node: node.id,
      field: "text",
    })
      .then((r) => {
        if (live) setBody(r.text ?? node.summary);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [node, sourceCall]);
  const storageKey =
    "research-docs:" + boot.viewer + ":" + boot.space + ":" + resource.project;
  return (
    <aside className="rd-detail" aria-label="资料详情">
      <header>
        <div>
          <span className="rd-eyebrow">{pluginFor(resource.plugin).label}</span>
          <h2>{node?.title || resource.title}</h2>
        </div>
        <button aria-label="关闭资料" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="rd-detail-body rv-app">
        <p className="rd-detail-caption">
          {resource.file
            ? "保存在此文档中的附件"
            : "关联原始资料；文档中的引用不会复制或移动它。"}
        </p>
        {error && (
          <div className="rd-error" role="alert">
            {error}
            <button onClick={() => void load()}>重新读取</button>
          </div>
        )}
        {resource.file ? (
          <AttachmentViewer {...{ call, page, resource }} />
        ) : !node ? (
          <p role="status">正在读取资料…</p>
        ) : path ? (
          <>
            <button onClick={() => setPath("")}>← 返回会话</button>
            <FileWindow
              node={node}
              call={sourceCall}
              editable={false}
              source={{ node: node.id, path }}
              storageKey={storageKey}
              openVersion={setVersion}
              version={version}
            />
          </>
        ) : node.type === "agent" ? (
          <AgentWindow
            node={node}
            call={sourceCall}
            epoch={boot.sourceEpoch ?? 0}
            storageKey={storageKey}
            runnable={boot.role !== "viewer"}
            openFile={setPath}
          />
        ) : node.type === "file" ? (
          <FileWindow
            node={node}
            call={sourceCall}
            editable={boot.role !== "viewer"}
            storageKey={storageKey}
            openVersion={setVersion}
            version={version}
          />
        ) : node.type === "audio" ? (
          <AudioWindow
            node={node}
            call={sourceCall}
            controller={audio}
            editable={boot.role !== "viewer"}
            runnable={boot.role !== "viewer"}
            storageKey={storageKey}
            open={(id) =>
              onNavigate({
                plugin: "note",
                project: resource.project,
                node: id,
                title: "关联资料",
                summary: "",
                file: "",
                media: "",
                size: 0,
              })
            }
            openVersion={setVersion}
            version={version}
            epoch={boot.sourceEpoch ?? 0}
          />
        ) : (
          <Markdown>{body || node.summary}</Markdown>
        )}
      </div>
      {!resource.file && (
        <footer>
          <a
            href={
              "/apps/research-v2/open?instance=" +
              encodeURIComponent(resource.project) +
              "&researchNode=" +
              encodeURIComponent(resource.card || resource.node)
            }
            target="_blank"
            rel="noreferrer"
          >
            在原科研项目中打开 ↗
          </a>
        </footer>
      )}
    </aside>
  );
}
function AttachmentViewer({
  call,
  page,
  resource,
}: {
  call: Call;
  page: string;
  resource: ResourceProps;
}) {
  const [url, setUrl] = useState(""),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    ref = useRef(""),
    abort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (ref.current) URL.revokeObjectURL(ref.current);
    },
    [],
  );
  const load = async () => {
    setLoading(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const r = await readAttachment(
        call,
        page,
        resource.file,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      ref.current = URL.createObjectURL(r.blob);
      setUrl(ref.current);
      if (
        /^(text\/|application\/json)/.test(r.file.media) &&
        r.file.size < 1024 * 1024
      )
        setText(await r.blob.text());
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return (
    <div className="rd-attachment-view">
      <p>{resource.title}</p>
      {error && <p className="rd-error">{error}</p>}
      {!url ? (
        <button
          className="rd-primary"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "正在读取…" : "加载附件"}
        </button>
      ) : (
        <>
          {/^audio\//.test(resource.media) ? (
            <audio controls src={url} />
          ) : /^video\//.test(resource.media) ? (
            <video controls src={url} />
          ) : /^image\/(png|jpeg|webp|gif)$/.test(resource.media) ? (
            <img alt={resource.title} src={url} />
          ) : text ? (
            <pre>{text}</pre>
          ) : (
            <p>附件已就绪，可以下载后打开。</p>
          )}
          <a className="rd-download" href={url} download={resource.title}>
            下载 {resource.title} ↓
          </a>
        </>
      )}
    </div>
  );
}
