import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MeetingOptions, MeetingSummarySelection, ResearchNode } from "@claude-bot/research-canvas-contract";
import { AudioUploadControl } from "../AudioCardPreview.js";
import { AudioUploadController, audioSize, meetingMetadata, uploadPending, type AudioFileInfo } from "../audio-upload.js";
import { fromBase64 } from "../collaboration.js";
import { BlobCollector } from "../file-upload.js";
import { persist, requestId, stored, type Call } from "../client.js";
import { DiscussionSourceResults, useDiscussionSource } from "./DiscussionSourceWindow.js";

interface MeetingRequest { action: "audio_transcribe" | "source_summarize"; params: Record<string, unknown> }
export function AudioWindow({ node, call, controller, editable, runnable, storageKey, open, version, openVersion, epoch = 0 }: {
  node: ResearchNode; call: Call; controller: AudioUploadController; editable: boolean; runnable: boolean; storageKey: string;
  open(id: string): void; version?: string; openVersion(version: string): void; epoch?: number;
}) {
  const upload = useSyncExternalStore(controller.subscribe, controller.snapshot), meta = meetingMetadata(node), key = `${storageKey}:meeting:${node.id}`;
  const [options, setOptions] = useState<MeetingOptions | null>(null), [optionsError, setOptionsError] = useState("");
  const [selection, setSelection] = useState<MeetingSummarySelection>(() => stored(key + ":selection", { kind: "none" }));
  const [files, setFiles] = useState<AudioFileInfo[]>([]), [fileError, setFileError] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [outgoing, setOutgoing] = useState<MeetingRequest | null>(() => stored(key + ":request", null));
  const request = useRef(outgoing), sending = useRef(false), generation = useRef(0), fileRead = useRef(0), optionsRead = useRef(0);
  const [mediaPending, setMediaPending] = useState(false), [mediaError, setMediaError] = useState(""), [url, setUrl] = useState("");
  const mediaGeneration = useRef(0), objectUrl = useRef("");
  const sourceState = useDiscussionSource(call, node.id, epoch), source = sourceState.source;
  const latest = [upload.file, ...files].filter((item): item is AudioFileInfo => Boolean(item)).sort((a, b) => b.version - a.version)[0];
  const file = version ? files.find(item => item.id === version) : latest && latest.version >= (meta.fileVersion ?? 0) ? latest : undefined;
  const currentSource = Boolean(source && file && source.sourceVersion === file.id);
  const completeTranscript = currentSource && Boolean(source?.integrity?.complete);
  const canStartTranscription = !currentSource || source?.stage === "uploaded";
  const fileVersion = file?.version ?? (!version ? meta.fileVersion : undefined), fileName = file?.name ?? (!version ? meta.fileName : undefined), bytes = file?.bytes ?? meta.bytes;
  const choose = (value: MeetingSummarySelection) => { setSelection(value); persist(key + ":selection", value); };
  const loadOptions = useCallback(async () => {
    const ticket = generation.current, read = ++optionsRead.current;
    try { const result = await call<MeetingOptions>("meeting_options", { node: node.id }); if (ticket === generation.current && read === optionsRead.current) { setOptions(result); setOptionsError(""); } }
    catch (reason) { if (ticket === generation.current && read === optionsRead.current) setOptionsError(String(reason)); }
  }, [call, node.id]);
  const loadFiles = useCallback(async () => {
    const ticket = generation.current, read = ++fileRead.current;
    try {
      let after: string | undefined; const result: AudioFileInfo[] = [];
      // Only older explicitly selected versions need more metadata pages.
      for (let page = 0; page < 20; page++) {
        const answer = await call<{ files: AudioFileInfo[]; next: string | null }>("file_versions", { node: node.id, after });
        if (ticket !== generation.current || read !== fileRead.current) return;
        result.push(...answer.files);
        if (!version || result.some(item => item.id === version) || !answer.next) break;
        after = answer.next;
      }
      setFiles(result.sort((a, b) => b.version - a.version)); setFileError(version && !result.some(item => item.id === version) ? "此历史录音暂不可用。" : "");
    } catch (reason) { if (ticket === generation.current && read === fileRead.current) setFileError(String(reason)); }
  }, [call, node.id, version]);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [call, node.id, version]);
  useEffect(() => { void loadOptions(); }, [loadOptions, fileVersion]);
  useEffect(() => { void loadFiles(); }, [loadFiles, meta.fileVersion]);
  useEffect(() => () => { mediaGeneration.current++; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  useEffect(() => {
    mediaGeneration.current++; setMediaPending(false); setMediaError(""); setUrl("");
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; }
  }, [file?.id]);
  const loadAudio = async () => {
    if (!file || mediaPending) return;
    const ticket = ++mediaGeneration.current; setMediaPending(true); setMediaError("");
    try {
      // Loaded only on request; windows are folded into a Blob as they arrive, so any length plays.
      const collected = new BlobCollector(); let cursor: number | undefined;
      do {
        const answer = await call<{ file: AudioFileInfo; data: string; next: number | null }>("resource_read", { node: node.id, version: file.id, cursor });
        if (ticket !== mediaGeneration.current) return;
        if (answer.file.id !== file.id) throw new Error("录音版本已变化，请重新选择录音。");
        const chunk = fromBase64(answer.data);
        if (collected.size + chunk.byteLength > file.bytes) throw new Error("录音长度异常，请重新读取文件信息。");
        if (answer.next !== null && (!Number.isSafeInteger(answer.next) || answer.next <= (cursor ?? 0) || answer.next > file.bytes)) throw new Error("录音读取进度异常，请重试。");
        collected.add(chunk); cursor = answer.next ?? undefined;
      } while (cursor !== undefined);
      if (collected.size !== file.bytes) throw new Error("录音尚未完整读取，请重试。");
      const value = URL.createObjectURL(collected.blob(file.mime)); objectUrl.current = value; setUrl(value);
    } catch (reason) { if (ticket === mediaGeneration.current) setMediaError(String(reason)); }
    finally { if (ticket === mediaGeneration.current) setMediaPending(false); }
  };
  const submit = async (action: MeetingRequest["action"]) => {
    if (sending.current) return;
    const submitted = request.current ?? { action, params: action === "audio_transcribe"
      ? { request: requestId(), node: node.id, version: fileVersion, summary: selection }
      : { request: requestId(), node: node.id, version: source?.sourceVersion, selection } };
    request.current = submitted; setOutgoing(submitted); persist(key + ":request", submitted);
    const ticket = generation.current; sending.current = true; setPending(true); setError("");
    try {
      const result = await call<{ run?: unknown; source?: unknown; status?: string; message?: string }>(submitted.action, submitted.params);
      if (ticket !== generation.current) return;
      if (result.status === "not_started") {
        request.current = null; setOutgoing(null); persist(key + ":request", null);
        setError(result.message || "本次处理未开始，请检查选择后重新提交。");
        return;
      }
      if (!(submitted.action === "audio_transcribe" ? result.run : result.source)) throw new Error("处理请求结果未确认，请重试确认原请求。");
      request.current = null; setOutgoing(null); persist(key + ":request", null);
      await sourceState.refresh(true);
    } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    finally { sending.current = false; if (ticket === generation.current) setPending(false); }
  };
  const optionValue = selection.kind === "agent" ? `agent:${selection.agent}` : selection.kind === "codex" ? `codex:${selection.resource}` : "none";
  const selectedSource = selection.kind === "codex" && options?.mayBind ? options.sources.find(item => item.id === selection.resource) : undefined;
  const selectionAvailable = selection.kind === "none" || selection.kind === "agent" ? selection.kind === "none" || Boolean(options?.agents.some(item => item.id === selection.agent)) : Boolean(selectedSource);
  const frozen = !runnable || pending || Boolean(outgoing) || sourceState.active || Boolean(version) || (!canStartTranscription && !completeTranscript);
  return <div className="rv-audio-window">
    <ol className="rv-audio-flow" aria-label="录音处理步骤"><li>上传录音</li><li>语音转文字</li><li>生成可编辑纪要</li><li>确认下发任务</li></ol>
    <section aria-label="会议录音文件">
      <h3>1. 会议录音</h3>
      <p className="rv-audio-file">{fileName || "还没有上传录音"}{fileName && bytes !== undefined && <small>{audioSize(bytes)}{version ? " · 历史版本" : ""}</small>}</p>
      {!version && <AudioUploadControl controller={controller} editable={editable} hasFile={Boolean(fileName)} />}
      {fileName && <div className="rv-inline">
        {!url && <button disabled={!file || mediaPending} onClick={() => void loadAudio()}>{mediaPending ? "正在加载录音…" : "加载播放器 / 下载录音"}</button>}
        {mediaPending && <button onClick={() => { mediaGeneration.current++; setMediaPending(false); }}>停止加载</button>}
        {url && <a href={url} download={file?.name}>下载录音</a>}
        <details><summary>录音版本</summary><button onClick={() => void loadFiles()}>刷新文件信息</button>{files.map(item => <button key={item.id} onClick={() => openVersion(item.id)}>v{item.version} · {item.name}</button>)}</details>
      </div>}
      {url && <audio controls preload="none" src={url} aria-label="会议录音播放器" />}
      {fileError && <p role="alert">{fileError}<button onClick={() => void loadFiles()}>重新读取文件信息</button></p>}
      {mediaError && <p role="alert">{mediaError}</p>}
    </section>
    {!version && <section aria-label="转写与纪要设置">
      <h3>2. 转写与纪要</h3>
      <label className="rv-meeting-choice">纪要整理方式
        <select value={optionValue} disabled={frozen || !options} onChange={event => {
          const value = event.target.value;
          choose(value.startsWith("agent:") ? { kind: "agent", agent: value.slice(6) } : value.startsWith("codex:") ? { kind: "codex", resource: value.slice(6) } : { kind: "none" });
        }}>
          <option value="none">先只转文字，稍后整理纪要</option>
          {options?.agents.map(agent => <option key={agent.id} value={`agent:${agent.id}`}>Agent · {agent.title}</option>)}
          {options?.mayBind && options.sources.map(item => <option key={item.id} value={`codex:${item.id}`}>Codex · {item.title}</option>)}
          {!selectionAvailable && <option value={optionValue}>上次选择暂不可用，请重新选择</option>}
        </select>
      </label>
      {selection.kind === "codex" && selectedSource && <div className="rv-meeting-fields">
        <label>Codex 账号<select disabled={frozen} value={selection.account ?? ""} onChange={event => choose({ ...selection, account: event.target.value || undefined })}><option value="">来源默认账号</option>{selectedSource.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        {!!selectedSource.models.length && <label>模型<select disabled={frozen} value={selection.model ?? ""} onChange={event => choose({ ...selection, model: event.target.value || undefined })}><option value="">来源默认模型</option>{selectedSource.models.map(model => <option key={model}>{model}</option>)}</select></label>}
        {!!selectedSource.efforts.length && <label>推理强度<select disabled={frozen} value={selection.effort ?? ""} onChange={event => choose({ ...selection, effort: event.target.value || undefined })}><option value="">来源默认强度</option>{selectedSource.efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label>}
      </div>}
      <p className="rv-meeting-note">{completeTranscript ? "完整转写已保存。选择整理来源即可生成或重新整理中文纪要和任务建议，建议保持待审。" : !canStartTranscription ? "当前录音已经开始处理；待完整转写保存后，可选择来源整理纪要。" : selection.kind === "none" ? "本次只生成带讲话人标签的完整转写。" : "转写完成后，由所选 Agent 整理中文纪要和任务建议。纪要可以编辑，任务建议保持待审。"}</p>
      {canStartTranscription && options && !options.transcription.available && <p role="status">暂时不能开始语音转文字：{options.transcription.status}<button onClick={() => void loadOptions()}>刷新可用服务</button></p>}
      {optionsError && <p role="alert">{optionsError}<button onClick={() => void loadOptions()}>重新读取可用来源</button></p>}
      {!options && !optionsError && <p role="status">正在读取可用转写服务与 Agent…</p>}
      <div className="rv-inline">
        {!outgoing && canStartTranscription && !completeTranscript && <button className="rv-audio-primary" disabled={frozen || sourceState.pending || Boolean(sourceState.error) || !fileVersion || uploadPending(upload) || !options?.transcription.available || !selectionAvailable}
          onClick={() => void submit("audio_transcribe")}>{selection.kind === "none" ? "开始语音转文字" : "开始转写并整理纪要"}</button>}
        {!outgoing && completeTranscript && source?.transcript && <button disabled={frozen || selection.kind === "none" || !selectionAvailable}
          onClick={() => void submit("source_summarize")}>{source.minutes ? "重新整理纪要与任务建议" : "从完整转写生成纪要与任务建议"}</button>}
        {outgoing && <button className="rv-audio-primary" disabled={!runnable || pending} onClick={() => void submit(outgoing.action)}>{pending ? "正在确认请求…" : "重试确认上次处理请求"}</button>}
      </div>
      {outgoing && !pending && <p className="rv-muted">上次请求尚未确认。重试保留原录音、整理方式和请求，不重复创建任务。</p>}
      {pending && <p role="status">正在提交处理请求…</p>}
      {error && <p role="alert">{error}</p>}
      {!runnable && <p className="rv-muted">当前身份可查看材料；开始处理和下发任务需要运行权限。</p>}
    </section>}
    <section aria-label="纪要与任务建议"><h3>3. 纪要与任务建议</h3>
      {source && !currentSource && <p role="note">下方保留的是此前录音的处理结果。当前录音需要完成自己的转写后再整理与下发。</p>}
      <DiscussionSourceResults {...{ node, call, open, storageKey }} editable={editable && currentSource && !version} runnable={runnable && currentSource && !version} {...sourceState} allowRetry={currentSource && !completeTranscript && !version && !outgoing} />
    </section>
  </div>;
}
