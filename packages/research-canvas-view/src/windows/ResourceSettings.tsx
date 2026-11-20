import { useEffect, useState } from "react";
import type { Json, ResearchNode } from "@claude-bot/research-canvas-contract";
import { requestId, type Call } from "../client.js";
export function ResourceSettings({
  node,
  call,
}: {
  node: ResearchNode;
  call: Call;
}) {
  const [resources, setResources] = useState<
      {
        id: string;
        kind: string;
        title: string;
        config: Record<string, Json>;
      }[]
    >([]),
    [resource, setResource] = useState(""),
    [model, setModel] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [provider, setProvider] = useState("codex"),
    [session, setSession] = useState(""),
    [effort, setEffort] = useState(""),
    [account, setAccount] = useState("@default");
  const choice = resources.find((item) => item.id === resource),
    native = choice?.kind === "session";
  useEffect(() => {
    let current = true;
    void call<{ resources: typeof resources }>("resources_list")
      .then((answer) => {
        if (current) setResources(answer.resources);
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [call]);
  return (
    <details className="rv-settings">
      <summary>绑定项目共享资源</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          try {
            await call("resource_bind", {
              request: requestId(),
              node: node.id,
              data: {
                kind:
                  node.type === "group"
                    ? "group"
                    : native
                      ? "session"
                      : "agent",
                resource,
                config:
                  node.type === "group"
                    ? {}
                    : native
                      ? {
                          device: choice!.config.device,
                          workspace: choice!.config.workspace,
                          label: choice!.config.label,
                          directory: choice!.config.directory,
                          provider,
                          session,
                          model,
                          effort,
                          account: provider === "codex" ? account : "",
                        }
                      : { model, ...(effort ? { effort } : {}) },
              },
            });
          } catch (error) {
            setError(String(error));
          } finally {
            setPending(false);
          }
        }}
      >
        <p>手动调用与监听沿用此资源；项目成员的触发身份另行记录。</p>
        {node.type === "group" ? (
          <label>
            群 ID
            <input
              required
              value={resource}
              onChange={(event) => setResource(event.target.value)}
              placeholder="oc_…"
            />
          </label>
        ) : (
          <>
            <label>
              运行资源
              <select
                required
                value={resource}
                onChange={(event) => {
                  setResource(event.target.value);
                  const choice = resources.find(
                    (item) => item.id === event.target.value,
                  );
                  setModel(String(choice?.config.model ?? ""));
                }}
              >
                <option value="">选择已授权资源</option>
                {resources
                  .filter((item) => ["agent", "session"].includes(item.kind))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
            {native && (
              <>
                <label>
                  CLI
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                  >
                    <option>codex</option>
                    <option>claude</option>
                    <option>omp</option>
                  </select>
                </label>
                <p>
                  共享工作区：
                  {String(
                    choice?.config.directory ?? choice?.config.workspace ?? "",
                  )}
                </p>
                <label>
                  已有会话 ID（可选）
                  <input
                    value={session}
                    onChange={(event) => setSession(event.target.value)}
                  />
                </label>
                {provider === "codex" && (
                  <label>
                    新会话及监听账号
                    <input
                      value={account}
                      onChange={(event) => setAccount(event.target.value)}
                      placeholder="@default 或 a、b…"
                    />
                  </label>
                )}
                <p>
                  已有会话保留原账号。每条监听连接会在此工作区创建独立会话；项目成员可读取其中引用的文件。
                </p>
              </>
            )}
            <label>
              模型
              <input
                required={!native}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={native ? "CLI 默认模型" : ""}
              />
            </label>
            <label>
              推理强度
              <select
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
              >
                <option value="">默认</option>
                {(native
                  ? ["low", "medium", "high", "xhigh", "max"]
                  : ["minimal", "low", "medium", "high", "max"]
                ).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <button disabled={pending} className="rv-primary">
          {pending ? "绑定中…" : "绑定到项目"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
