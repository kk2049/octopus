import { useEffect, useRef, useState } from "react";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import { MediaPreview } from "@claude-bot/agent-file-preview";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { fromBase64 } from "../collaboration.js";
import { WHOLE_FILE_PREVIEW_BYTES, WHOLE_TEXT_BYTES, sendChunks, sha256Of } from "../file-upload.js";
import { persist, stored, requestId, type Call } from "../client.js";
import { saveText } from "../text-save.js";

interface FileInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  version: number;
}
interface FilePart {
  file: FileInfo;
  data: string;
  next: number | null;
}
const isPlain = (file: Pick<FileInfo, "mime" | "name">) =>
  /^(text\/|application\/(json|xml))/.test(file.mime) ||
  /\.(md|txt|csv|json|ya?ml|py|[cm]?[jt]sx?|rs|go|sh|log)$/i.test(file.name);
/** A whole-file view renders from all of the bytes; the protocol itself has no total. */
const previewBudget = (file: Pick<FileInfo, "mime" | "name">) => isPlain(file) ? WHOLE_TEXT_BYTES : WHOLE_FILE_PREVIEW_BYTES;
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
export function FileWindow({
  node,
  call,
  version,
  editable,
  source,
  storageKey,
  openVersion,
}: {
  node: ResearchNode;
  call: Call;
  version?: string;
  editable: boolean;
  source?: { node: string; path: string };
  storageKey: string;
  openVersion(version: string): void;
  open?(node: string): void;
  runnable?: boolean;
}) {
  const [file, setFile] = useState<FileInfo | null>(null),
    [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null),
    [url, setUrl] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [draft, setDraft] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [dragging, setDragging] = useState(false),
    [deferred, setDeferred] = useState(false);
  const linked = !source && Boolean(node.data.workspace);
  const outgoing = useRef<{ request: string; text: string } | null>(null);
  const save = async () => {
    if (draft === null || saving) return;
    const submitted = outgoing.current ?? { request: requestId(), text: draft };
    outgoing.current = submitted;
    setSaving(true); setError("");
    try {
      // A file of any size: one call, or staged past one call's window.
      const answer = await saveText<{ status: string; message?: string }>(call, "file_write",
        { request: submitted.request, node: node.id }, submitted.text);
      if (answer.status !== "saved") {
        outgoing.current = null;
        throw new Error(answer.message ?? "保存结果未确认，请重新读取文件");
      }
      outgoing.current = null;
      setDraft(current => current === submitted.text ? null : current);
      await read();
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  };
  const generation = useRef(0),
    [versions, setVersions] = useState<FileInfo[]>([]);
  const loadVersions = async () => {
    try {
      let after: string | undefined;
      const files: FileInfo[] = [];
      do {
        const page = await call<{ files: FileInfo[]; next: string | null }>(
          "file_versions",
          { node: node.id, after },
        );
        files.push(...page.files);
        after = page.next ?? undefined;
      } while (after);
      setVersions(files.sort((a, b) => b.version - a.version));
    } catch (error) {
      setError(String(error));
    }
  };
  /** Past the view's budget the whole file is loaded only on request; the read itself has no total. */
  const read = async (whole = false) => {
    const ticket = ++generation.current;
    setPending(true);
    setError("");
    setDeferred(false);
    try {
      const chunks: Uint8Array[] = [];
      let cursor: number | undefined,
        selected = version,
        info: FileInfo | null = null;
      do {
        const part = await call<FilePart>(
          source ? "session_file_read" : "resource_read",
          {
            node: source?.node ?? node.id,
            ...(source ? { path: source.path } : {}),
            cursor,
            version: selected,
          },
        );
        if (ticket !== generation.current) return;
        info = part.file;
        selected = info.id;
        if (!whole && cursor === undefined && info.bytes > previewBudget(info)) {
          setFile(info);
          setBytes(null);
          setDeferred(true);
          return;
        }
        chunks.push(fromBase64(part.data));
        cursor = part.next ?? undefined;
        setProgress(`读取 ${cursor ?? info.bytes} / ${info.bytes} 字节`);
      } while (cursor !== undefined);
      const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      setFile(info);
      setBytes(data);
    } catch (error) {
      if (ticket === generation.current) setError(String(error));
    } finally {
      if (ticket === generation.current) setPending(false);
    }
  };
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, [node.id, version, source?.path]);
  useEffect(() => {
    if (!bytes || !file) return;
    const value = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [bytes, file]);
  const upload = async (selected: File) => {
    if (pending || !editable || version || linked || source) return;
    const ticket = generation.current;
    setPending(true);
    setError("");
    try {
      if (node.type === "audio" && !selected.type.startsWith("audio/") && !/\.(m4a|mp3|wav|ogg|flac|aac|webm|mp4)$/i.test(selected.name))
        throw new Error("请选择可识别的录音文件（m4a、mp3、wav、flac 等）");
      // Hash and send bounded windows of the File; the page never holds all of it.
      setProgress("正在计算文件校验值…");
      const sha256 = (await sha256Of(selected))!;
      const resumeKey = `${storageKey}:upload:${node.id}:${sha256}:${selected.name}`,
        uploadRequest = stored(resumeKey, "") || requestId();
      persist(resumeKey, uploadRequest);
      const begin = await call<{ upload: { id: string; received: number } }>(
        "file_begin",
        {
          request: uploadRequest,
          node: node.id,
          data: {
            name: selected.name,
            mime: selected.type || "application/octet-stream",
            bytes: selected.size,
            sha256,
          },
        },
      );
      await sendChunks(call, begin.upload.id, selected, begin.upload.received, () => true,
        received => setProgress(`上传 ${received} / ${selected.size} 字节`));
      await call<{ file: FileInfo }>("file_commit", {
        request: `${uploadRequest}:commit`,
        upload: begin.upload.id,
      });
      persist(resumeKey, "");
      if (ticket !== generation.current) return;
      await read();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  };
  const plain = file && isPlain(file);
  const content = bytes && plain ? new TextDecoder().decode(bytes) : "";
  return (
    <div className={`rv-file-window${dragging ? " rv-file-dragging" : ""}`}
      onDragOver={event => { if (editable && !version && !linked && !source) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); const selected = event.dataTransfer.files[0]; if (selected) void upload(selected); }}>
      <div className="rv-inline">
        <span>
          {file
            ? `${file.name} · ${source || linked ? file.sha256.slice(0, 16) : `v${file.version}`}`
            : "尚未上传"}
        </span>
        {editable && !version && !linked && !source && (
          <label className="rv-upload">
            {node.type === "audio" ? "上传录音" : "上传版本"}
            <input
              aria-label={node.type === "audio" ? "上传录音" : "上传文件"}
              accept={node.type === "audio" ? "audio/*,.m4a,.flac,.webm,.mp4" : undefined}
              type="file"
              disabled={pending}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void upload(chosen);
              }}
            />
          </label>
        )}
        {file && !source && !linked && (
          <select
            aria-label="历史版本"
            value=""
            onFocus={() => void loadVersions()}
            onChange={(event) => {
              if (event.target.value) openVersion(event.target.value);
            }}
          >
            <option value="">打开历史版本…</option>
            {versions.map((item) => (
              <option key={item.id} value={item.id}>
                v{item.version} · {item.name}
              </option>
            ))}
          </select>
        )}
        {linked && <button disabled={pending || saving} onClick={() => void read()}>刷新文件</button>}
        {linked && editable && plain && draft === null &&
          <button disabled={pending || saving} onClick={() => setDraft(content)}>编辑文件</button>}
        {file && url && (
          <a href={url} download={file.name}>
            下载
          </a>
        )}
      </div>
      {node.type === "audio" && !file && <p className="rv-upload-hint">将录音拖到这里，或选择文件上传。录音大小不限，按分块上传并可续传；完整稿、纪要与候选待办会保留来源。</p>}
      {draft !== null && <div className="rv-file-editor">
        <textarea aria-label="文件正文" value={draft} disabled={saving}
          onChange={event => setDraft(event.target.value)} rows={18} />
        <div className="rv-inline">
          <button disabled={pending || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存到工作区"}</button>
          <button disabled={saving} onClick={() => { setDraft(null); outgoing.current = null; }}>取消编辑</button>
        </div>
      </div>}
      {pending && <p role="status">{progress || "准备中…"}</p>}
      {deferred && file && !pending && (
        <p role="status">
          此文件 {mebibytes(file.bytes)}，超过自动预览的 {mebibytes(previewBudget(file))}；需要时再整份载入。{" "}
          <button onClick={() => void read(true)}>载入预览 / 下载</button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button disabled={pending} onClick={() => void read()}>
            重新读取
          </button>
        </p>
      )}
      {file &&
        bytes &&
        (node.type === "audio" || file.mime.startsWith("audio/") ? (
          <audio controls src={url} preload="metadata" />
        ) : file.mime === "application/pdf" ||
          file.mime.startsWith("image/") ? (
          <MediaPreview
            label={file.name}
            text=""
            state={{
              status: "idle",
              message: "",
              code: "",
              receivedBytes: file.bytes,
              totalBytes: file.bytes,
            }}
            onDownload={() => {
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = file.name;
              anchor.click();
            }}
            document={{ label: file.name, mediaType: file.mime }}
            url={url}
            data={bytes}
            ready
            streaming={false}
            unsupported={false}
          />
        ) : file.mime.startsWith("video/") ? (
          <video controls src={url} />
        ) : /\.md$/i.test(file.name) ? (
          <Markdown>{content}</Markdown>
        ) : plain ? (
          <pre className="rv-source">{content}</pre>
        ) : (
          <p>此文件可下载后打开。</p>
        ))}
    </div>
  );
}
