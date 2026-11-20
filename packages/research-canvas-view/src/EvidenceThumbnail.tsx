import { useEffect, useRef, useState } from "react";
import { nodeMetadata, type ResearchNode } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";
import { fromBase64 } from "./collaboration.js";
import { BlobCollector } from "./file-upload.js";
import { THUMBNAIL_BUDGET_BYTES } from "./budgets.js";

const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
type ImagePart = { file: { id: string; mime: string; bytes: number; sha256: string }; data: string; next: number | null };
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Images are existing graph resources, read with the viewer's ordinary authorization.
 * No report/Markdown URL becomes a network destination. Every chunk pins one version.
 */
export function EvidenceThumbnail({ node, call, open }: { node: ResearchNode; call: Call; open(id: string): void }) {
  const [image, setImage] = useState<{ url: string; hash: string } | null>(null), [error, setError] = useState("");
  const [deferred, setDeferred] = useState(0), [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0), generation = useRef(0);
  const meta = nodeMetadata(node), previewVersion = typeof meta.previewVersion === "string" ? meta.previewVersion : undefined;
  useEffect(() => {
    const ticket = ++generation.current; let objectUrl = "";
    setImage(null); setError(""); setDeferred(0);
    const read = async () => {
      try {
        if (node.type !== "file" || node.archived) throw new Error("图表来源暂不可用");
        let version = previewVersion, expected: ImagePart["file"] | undefined, cursor: number | undefined;
        const collected = new BlobCollector();
        do {
          const part = await call<ImagePart>("resource_read", { node: node.id, cursor, version });
          if (ticket !== generation.current) return;
          if (version && part.file.id !== version) throw new Error("图表版本已变化，请刷新重试");
          if (!IMAGE_MIME.test(part.file.mime)) throw new Error("此图表不是支持的图片，请打开来源查看");
          if (!Number.isSafeInteger(part.file.bytes) || part.file.bytes < 1) throw new Error("图片大小无效，请打开来源查看");
          if (expected && (part.file.bytes !== expected.bytes || part.file.mime !== expected.mime || part.file.sha256 !== expected.sha256)) throw new Error("图表版本已变化，请刷新重试");
          if (!expected && !requested && part.file.bytes > THUMBNAIL_BUDGET_BYTES) { setDeferred(part.file.bytes); return; }
          expected = part.file; version = part.file.id;
          const bytes = fromBase64(part.data);
          if (!bytes.length || collected.size + bytes.length > part.file.bytes) throw new Error("图表内容不完整，请打开来源查看");
          collected.add(bytes);
          if (part.next !== null && (!Number.isSafeInteger(part.next) || part.next !== collected.size || part.next <= (cursor ?? 0) || collected.size >= part.file.bytes)) throw new Error("图表分片无效，请刷新重试");
          cursor = part.next ?? undefined;
        } while (cursor !== undefined);
        if (!expected || collected.size !== expected.bytes) throw new Error("图表内容不完整，请打开来源查看");
        objectUrl = URL.createObjectURL(collected.blob(expected.mime));
        setImage({ url: objectUrl, hash: expected.sha256 });
      } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    };
    void read();
    return () => { generation.current++; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [node.id, node.type, node.archived, node.resourceVersion, previewVersion, call, retry, requested]);
  return <figure className="rv-evidence-thumbnail">
    <button className="rv-evidence-image" onClick={event => { event.stopPropagation(); open(node.id); }} aria-label={`打开关键图表：${node.title}`}>
      {image ? <img src={image.url} alt={node.summary || node.title} /> : <span>{error ? "预览暂不可用" : deferred ? `图表 ${mebibytes(deferred)}` : "正在读取图表…"}</span>}
    </button>
    {deferred > 0 && !image && <button onClick={event => { event.stopPropagation(); setRequested(true); }}>载入预览（{mebibytes(deferred)}）</button>}
    <figcaption>{node.title}{image && <small title={image.hash}>来源快照 · {image.hash.slice(0, 12)}</small>}</figcaption>
    {error && <><small role="alert">{error}</small><button onClick={event => { event.stopPropagation(); setRetry(value => value + 1); }}>重试图表预览</button></>}
  </figure>;
}
