import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionsReply, TerminalSnapshot, WorkspaceGroup } from "@claude-bot/agent-sessions-contract";
import { AvButton, StatusChip } from "@claude-bot/agent-view-react/ui";

const POLL_MS = 700;

interface TerminalTarget {
  id: string;
  label: string;
}

interface OpenTerminal {
  device: string;
  id: string;
}

export interface RemoteTerminalProps {
  device: string;
  workspaces?: WorkspaceGroup;
  refusal: string;
  onRefreshWorkspaces(): void;
  onOpen(device: string, workspaceId: string): Promise<SessionsReply>;
  onRead(device: string, terminalId: string): Promise<SessionsReply>;
  onSend(device: string, terminalId: string, input: string): Promise<SessionsReply>;
  onClose(device: string, terminalId: string): Promise<SessionsReply>;
}

/** One mounted panel owns at most one approved terminal lease for one device. */
export function RemoteTerminal(props: RemoteTerminalProps) {
  const { device } = props;
  const targets = useMemo(() => terminalTargets(device, props.workspaces), [device, props.workspaces]);
  const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
  const selectedId = workspaceOverride ?? targets[0]?.id ?? "";
  const selected = targets.find((target) => target.id === selectedId) ?? null;
  const unavailable = props.workspaces?.device === device && props.workspaces.terminal?.available === false
    ? props.workspaces.terminal.reason || "这台设备的远端终端不可用；请刷新工作区。"
    : "";
  const [terminal, setTerminalState] = useState<OpenTerminal | null>(null);
  const terminalRef = useRef<OpenTerminal | null>(null);
  const [screen, setScreen] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [message, setMessage] = useState("");
  const requestRevision = useRef(0);
  const autoOpened = useRef(false);
  const closing = useRef(false);
  const readRef = useRef(props.onRead);
  const closeRef = useRef(props.onClose);
  readRef.current = props.onRead;
  closeRef.current = props.onClose;

  const setTerminal = useCallback((next: OpenTerminal | null): void => {
    terminalRef.current = next;
    setTerminalState(next);
  }, []);

  // A narrow workspace may rebind this mounted module to another device. That
  // semantic boundary retires the old lease and every late answer before the
  // new device is allowed to initialise its own default.
  useEffect(() => {
    requestRevision.current += 1;
    const previous = terminalRef.current;
    if (previous) void closeRef.current(previous.device, previous.id);
    terminalRef.current = null;
    setTerminalState(null);
    setWorkspaceOverride(null);
    setScreen("");
    setInput("");
    setMessage("");
    setPollPaused(false);
    busyRef.current = false;
    setBusy(false);
    autoOpened.current = false;
    closing.current = false;
  }, [device]);

  // Closing a Dock tab is the end of this panel's ownership. Release the live
  // shell once; never retry cleanup or let a late answer revive the panel.
  useEffect(() => () => {
    requestRevision.current += 1;
    const current = terminalRef.current;
    terminalRef.current = null;
    if (current && !closing.current) void closeRef.current(current.device, current.id);
  }, []);

  useEffect(() => {
    if (!terminal || busy || pollPaused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const revision = ++requestRevision.current;
      try {
        const reply = await readRef.current(terminal.device, terminal.id);
        if (cancelled || revision !== requestRevision.current) return;
        const next = terminalSnapshot(reply);
        if (!next) {
          setMessage(reply.message || "远端终端刷新失败；请手动重试。");
          setPollPaused(true);
          return;
        }
        setScreen(next.screen);
        if (next.closed) {
          setTerminal(null);
          setMessage("远端终端已结束。");
          return;
        }
        timer = setTimeout(() => void poll(), POLL_MS);
      } catch {
        if (!cancelled && revision === requestRevision.current) {
          setMessage("远端终端暂时没有回应；请手动重试。");
          setPollPaused(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, pollPaused, setTerminal, terminal]);

  const open = useCallback(async (): Promise<void> => {
    if (!selected || unavailable || busyRef.current || terminalRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setPollPaused(false);
    const revision = ++requestRevision.current;
    try {
      const reply = await props.onOpen(device, selected.id);
      const next = terminalSnapshot(reply);
      if (revision !== requestRevision.current) {
        if (next && !next.closed) void closeRef.current(device, next.terminalId);
        return;
      }
      if (!next) {
        setMessage(reply.message || "远端终端没有打开。");
        return;
      }
      if (next.closed) {
        setMessage("远端终端已经结束。");
        return;
      }
      setTerminal({ device, id: next.terminalId });
      setScreen(next.screen);
    } catch {
      if (revision === requestRevision.current) setMessage("远端终端暂时没有回应；不会自动重试。");
    } finally {
      if (revision === requestRevision.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [device, props.onOpen, selected, setTerminal, unavailable]);

  // The device-row click already expressed the open intent. Once its first
  // trusted workspace choice is present, spend exactly one proposal. Refusal
  // is a terminal answer until the reader explicitly presses retry.
  useEffect(() => {
    if (!selected || unavailable || autoOpened.current) return;
    autoOpened.current = true;
    void open();
  }, [open, selected, unavailable]);

  const readNow = async (): Promise<void> => {
    const current = terminalRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    const revision = ++requestRevision.current;
    try {
      const reply = await props.onRead(current.device, current.id);
      if (revision !== requestRevision.current) return;
      const next = terminalSnapshot(reply);
      if (!next) {
        setMessage(reply.message || "远端终端刷新失败。");
        return;
      }
      setScreen(next.screen);
      setPollPaused(false);
      if (next.closed) {
        setTerminal(null);
        setMessage("远端终端已结束。");
      }
    } catch {
      if (revision === requestRevision.current) setMessage("远端终端暂时没有回应；不会自动重试。");
    } finally {
      if (revision === requestRevision.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const send = async (): Promise<void> => {
    const current = terminalRef.current;
    const command = input;
    if (!current || !command.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    const revision = ++requestRevision.current;
    try {
      const reply = await props.onSend(current.device, current.id, command);
      if (revision !== requestRevision.current) return;
      const next = terminalSnapshot(reply);
      if (!next) {
        setMessage(reply.message || "终端输入没有送达。");
        return;
      }
      setInput("");
      setScreen(next.screen);
      setPollPaused(false);
      if (next.closed) {
        setTerminal(null);
        setMessage("远端终端已结束。");
      }
    } catch {
      if (revision === requestRevision.current) setMessage("终端输入没有得到回应；不会自动重发。");
    } finally {
      if (revision === requestRevision.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const close = async (): Promise<void> => {
    const current = terminalRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    closing.current = true;
    setBusy(true);
    setMessage("");
    const revision = ++requestRevision.current;
    try {
      const reply = await props.onClose(current.device, current.id);
      if (revision !== requestRevision.current) return;
      if (!reply.ok) {
        setMessage(reply.message || "远端终端没有关闭。");
        return;
      }
      setTerminal(null);
      setScreen("");
      setInput("");
      setPollPaused(false);
      setMessage("远端终端已结束。");
    } catch {
      if (revision === requestRevision.current) setMessage("远端终端没有确认关闭。");
    } finally {
      closing.current = false;
      if (revision === requestRevision.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const visibleMessage = message || props.refusal;
  return (
    <section
      className="remote-terminal-panel"
      data-device={device}
      data-av-remote-terminal
      aria-label={`${device} 远端终端`}
    >
      <header className="remote-terminal-header">
        <div className="remote-terminal-title">
          <span aria-hidden="true">›_</span>
          <strong>{device}</strong>
        </div>
        {busy && !terminal ? <StatusChip busy word="正在打开终端" tone="info" /> : null}
        {terminal ? <StatusChip icon="●" word="快速通道已开启" tone="ok" /> : null}
        <span className="remote-terminal-spacer" />
        {terminal && pollPaused ? <AvButton disabled={busy} onClick={() => void readNow()}>重试刷新</AvButton> : null}
        {terminal ? <AvButton disabled={busy} onClick={() => void close()}>结束终端</AvButton> : null}
      </header>

      <div className="remote-terminal-body">
        {unavailable && !terminal ? (
          <div className="remote-terminal-empty">
            <p role="note">{unavailable}</p>
            <AvButton disabled={busy} onClick={props.onRefreshWorkspaces}>刷新工作区</AvButton>
          </div>
        ) : !targets.length && !terminal ? (
          <div className="remote-terminal-empty">
            <p>{props.workspaces?.device === device
              ? "这台物理机当前没有可作为起点的已登记工作区。"
              : "尚未取得这台设备的工作区列表；请等待查询完成，或刷新重试。"}</p>
            <AvButton disabled={busy} onClick={props.onRefreshWorkspaces}>刷新工作区</AvButton>
          </div>
        ) : null}

        {targets.length > 1 && !terminal ? (
          <label className="remote-terminal-workspace">
            <span>起始工作区</span>
            <select
              value={selectedId}
              disabled={busy}
              onChange={(event) => {
                setWorkspaceOverride(event.currentTarget.value);
                setMessage("");
              }}
            >
              {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>
          </label>
        ) : null}

        {selected && !unavailable && !terminal && !busy ? (
          <div className="remote-terminal-handshake">
            <AvButton onClick={() => void open()}>{visibleMessage ? "重试打开" : "打开终端"}</AvButton>
            <AvButton onClick={props.onRefreshWorkspaces}>刷新工作区</AvButton>
            <p>
              起点：{selected.label}。真实 shell 可以离开起始工作区；首次打开需要批准，
              批准后点击「重试打开」接入，闲置 30 分钟自动结束。
            </p>
          </div>
        ) : null}

        {terminal ? (
          <>
            <pre className="remote-terminal-screen" data-av-remote-terminal-screen role="log" aria-live="off">
              {screen || "终端已连接，等待 shell 输出…"}
            </pre>
            <form
              className="remote-terminal-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                value={input}
                maxLength={16 * 1024}
                rows={2}
                aria-label="终端输入"
                placeholder="输入 shell 命令；Enter 提交，Shift+Enter 换行"
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <AvButton htmlType="submit" disabled={busy || !input.trim()}>
                {busy ? "执行中…" : "执行"}
              </AvButton>
            </form>
          </>
        ) : null}

        {visibleMessage ? (
          <p className="remote-terminal-error" data-av-remote-terminal-error role="note">{visibleMessage}</p>
        ) : null}
      </div>
    </section>
  );
}

function terminalTargets(device: string, group: WorkspaceGroup | undefined): TerminalTarget[] {
  if (!group || (group.device && group.device !== device)) return [];
  return (group.workspaces ?? []).map((workspace) => ({ id: workspace.id, label: workspace.label || workspace.display }));
}

function terminalSnapshot(reply: SessionsReply): TerminalSnapshot | null {
  if (!reply.ok || !reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)) return null;
  const row = reply.result as Record<string, unknown>;
  const terminalId = typeof row.terminal_id === "string" ? row.terminal_id : "";
  const screen = typeof row.screen === "string" ? row.screen : "";
  if (!/^term_[0-9a-f]{48}$/.test(terminalId) || screen.length > 128 * 1024 || typeof row.closed !== "boolean") return null;
  return { terminalId, screen, closed: row.closed };
}
