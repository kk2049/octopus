import { useEffect, useMemo, useRef, useState } from 'react';
import { PROMPT_MAX_BYTES, utf8Bytes, type AgentApi, type LaunchOptions, type LaunchProvider, type ShareResult } from './protocol';
import { Icon, Notice, providerName } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message : '操作没有完成，请重试';
type Phase = 'form' | 'starting' | 'placing';

/**
 * Start a new agent for this document. Device, directory, CLI, model and
 * effort are all first-level choices: they decide what the agent is, so none
 * hides behind an "advanced" toggle. The document's text goes along as the
 * agent's starting context unless the owner unticks it.
 */
export function NewAgent({ api, doc, docTitle, readDocument, onPlaced, onCancel }: {
  api: AgentApi;
  /** The document's token, so the agent can read it again itself. */
  doc?: string;
  docTitle: string;
  readDocument(): Promise<string>;
  /** Writes the card's Record for the new session's share. */
  onPlaced(binding: ShareResult['binding']): Promise<void>;
  onCancel(): void;
}) {
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [error, setError] = useState('');
  const [task, setTask] = useState(docTitle ? `根据这篇文档《${docTitle}》，` : '');
  const [title, setTitle] = useState('');
  const [device, setDevice] = useState('');
  const [directory, setDirectory] = useState('');
  const [provider, setProvider] = useState<LaunchProvider>('codex');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [withDoc, setWithDoc] = useState(true);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState('');
  const request = useRef<{ key: string; id: string } | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    let live = true;
    api.launchOptions().then((value) => {
      if (!live) return;
      setOptions(value);
      const d = value.defaults;
      const online = value.devices.filter((row) => row.online && row.providers.length);
      const chosenDevice = online.find((row) => row.device === d.device) ?? online[0];
      setDevice(chosenDevice?.device ?? '');
      const p = chosenDevice?.providers.includes(d.provider) ? d.provider : chosenDevice?.providers[0] ?? d.provider;
      setProvider(p);
      setModel(d.model[p] ?? '');
      setEffort(d.effort[p] ?? 'xhigh');
      setDirectory(d.directory ?? value.directories.find((row) => row.device === chosenDevice?.device)?.path ?? '');
    }, (e) => { if (live) setError(message(e)); });
    return () => { live = false; stopped.current = true; };
  }, [api]);

  const row = options?.devices.find((d) => d.device === device);
  const directories = useMemo(() => options?.directories.filter((d) => d.device === device) ?? [], [options, device]);
  const pickProvider = (next: LaunchProvider) => {
    setProvider(next);
    if (options) { setModel(options.defaults.model[next] ?? ''); setEffort(options.defaults.effort[next] ?? 'xhigh'); }
  };
  const pickDevice = (next: string) => {
    setDevice(next);
    const target = options?.devices.find((d) => d.device === next);
    if (target && !target.providers.includes(provider) && target.providers[0]) pickProvider(target.providers[0]);
    if (!directory || !options?.directories.some((d) => d.device === next && d.path === directory)) {
      setDirectory(options?.directories.find((d) => d.device === next)?.path ?? directory);
    }
  };
  const dirProblem = !directory.trim() ? '请填写工作目录' : directory.startsWith('/') || directory === '~' || directory.startsWith('~/') ? '' : '写绝对路径，或以 ~/ 开头';
  const ready = Boolean(options && row?.online && row.providers.includes(provider) && task.trim() && !dirProblem && phase === 'form');

  async function start() {
    if (!ready) return;
    setError(''); setPhase('starting'); setProgress('正在把任务交给设备…');
    try {
      const text = withDoc ? await readDocument().catch(() => '') : '';
      // The whole text goes when it can fit one prompt; otherwise only its size, and the agent reads the document itself.
      const bytes = utf8Bytes(text);
      const docPart = !withDoc ? {} : bytes <= PROMPT_MAX_BYTES ? { docText: text } : { docBytes: bytes };
      const form = { device, directory: directory.trim(), provider, model, effort, task: task.trim(), title: (title.trim() || firstLine(task)).slice(0, 60), ...(doc ? { doc } : {}), docTitle, ...docPart };
      // The same form retried after a failure keeps its request id: the device joins the first launch.
      const key = JSON.stringify(form);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const { id } = await api.launch({ ...form, requestId: request.current.id });
      const started = Date.now();
      for (;;) {
        if (stopped.current) return;
        const status = await api.launchStatus(id);
        if (status.state === 'ready' && status.binding) {
          setPhase('placing'); setProgress('正在放进文档…');
          await onPlaced(status.binding);
          return;
        }
        if (status.state === 'failed') throw new Error(status.message);
        setProgress(status.message);
        if (Date.now() - started > 120_000) throw new Error('设备还在启动 Agent。稍后可以在“放入已有会话”的列表里找到它。');
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (e) { setError(message(e)); setPhase('form'); }
  }

  if (!options) {
    return <section className="launch" aria-label="新建 Agent">
      {error ? <Notice tone="error" action={<button className="link" onClick={onCancel}>返回</button>}>{error}</Notice>
        : <div className="viewer-empty"><span className="spinner"/>正在读取你的设备…</div>}
    </section>;
  }

  return <section className="launch" aria-label="新建 Agent">
    <div className="launch-body">
      <h2>新建一个 Agent，放进这篇文档</h2>
      <label className="field" htmlFor="launch-task">任务<span>新 Agent 的第一条指令</span></label>
      <textarea id="launch-task" className="input textarea" rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="例如：根据这篇文档里的实验计划，先跑通基线并汇报结果"/>
      <label className="check"><input type="checkbox" checked={withDoc} onChange={(e) => setWithDoc(e.target.checked)}/>把这篇文档的正文作为它的起始上下文</label>

      <div className="grid">
        <div>
          <label className="field" htmlFor="launch-device">设备</label>
          <select id="launch-device" className="input" value={device} onChange={(e) => pickDevice(e.target.value)}>
            {options.devices.map((d) => <option key={d.device} value={d.device} disabled={!d.online || !d.providers.length}>{d.label}{d.reason ? ` · ${d.reason}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="field" htmlFor="launch-dir">工作目录</label>
          <input id="launch-dir" className="input mono" list="launch-dirs" value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="~/projects/paper"/>
          <datalist id="launch-dirs">{directories.map((d) => <option key={d.path} value={d.path}/>)}</datalist>
        </div>
      </div>
      {dirProblem && directory && <p className="field-hint warn">{dirProblem}</p>}

      <span className="field">Agent</span>
      <div className="segmented" role="radiogroup" aria-label="Agent">
        {(['claude', 'codex'] as const).map((p) => <button key={p} role="radio" aria-checked={provider === p} className={provider === p ? 'is-on' : ''}
          disabled={!row?.providers.includes(p)} onClick={() => pickProvider(p)}>{providerName(p)}</button>)}
      </div>

      <div className="grid">
        <div>
          <label className="field" htmlFor="launch-model">模型</label>
          <select id="launch-model" className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            {options.models[provider].map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            <option value="">Runner 默认（不指定）</option>
            {model && !options.models[provider].some((m) => m.value === model) && <option value={model}>{model}（上次使用）</option>}
          </select>
        </div>
        <div>
          <span className="field">思考强度</span>
          <div className="segmented small" role="radiogroup" aria-label="思考强度">
            {options.efforts[provider].map((e) => <button key={e.value} role="radio" aria-checked={effort === e.value} className={effort === e.value ? 'is-on' : ''} onClick={() => setEffort(e.value)}>{e.label}</button>)}
          </div>
        </div>
      </div>

      <label className="field" htmlFor="launch-title">卡片标题<span>文档读者看到的名字</span></label>
      <input id="launch-title" className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder={firstLine(task) || '新的 Agent'}/>

      <p className="launch-note"><Icon name="eye" size={13}/>以完全授权启动，不需要逐次批准；你会收到飞书通知。文档读者可以实时只读观看它的对话。</p>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
    <footer className="launch-foot">
      {phase !== 'form' ? <span className="launch-progress"><span className="spinner small"/>{progress}</span> : <span/>}
      <div className="row-actions">
        <button className="btn" disabled={phase !== 'form'} onClick={onCancel}>取消</button>
        <button className="btn btn-primary" disabled={!ready} onClick={() => void start()}><Icon name="plus" size={14}/>创建并放进文档</button>
      </div>
    </footer>
  </section>;
}

function firstLine(text: string): string {
  return text.replace(/^根据这篇文档《[^》]*》[，,]?/, '').split('\n')[0].trim().slice(0, 60);
}
