import type { AgentBinding, AgentExecutableStatus } from "./agent-executables.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Local CLI guidance only. Inventory deliberately never exports installation paths. */
export function executableRecovery(
  state: AgentExecutableStatus,
  binding?: AgentBinding,
  uid = process.getuid?.(),
): { explanation: string; steps: string[]; repair?: { condition: string; command: string }; trust?: { condition: string; command: string } } | undefined {
  if (state.reason !== "unsafe_permissions" || !state.detail) return undefined;
  const detail = state.detail;
  const own = uid !== undefined && detail.uid === uid;
  const entry = binding?.entry ?? (state.candidates.length === 1 ? state.candidates[0]?.entry : undefined);
  const pathSafe = detail.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(detail.path);
  const repair = own && pathSafe && ["group_writable", "world_writable"].includes(detail.rule)
    ? { condition: "仅当这是本人的个人安装、无需保留该写权限时执行；不要递归改权限或修改共享安装。",
        command: `chmod ${detail.rule === "world_writable" ? "go-w" : "g-w"} -- ${quote(detail.path)}` }
    : undefined;
  const trust = detail.stage !== "registry" && detail.rule !== "world_writable"
    && entry?.startsWith("/") && !/[\x00-\x1f\x7f]/.test(entry)
    ? { condition: "共享安装确需保留权限时，由设备主人确认信任该安装的所有者及组成员；他们可以替换程序。世界可写路径不允许例外。",
        command: `octopus-runner agents bind ${state.provider} ${quote(entry)}${binding?.interpreter ? ` --interpreter ${quote(binding.interpreter)}` : ""} --trust-installation` }
    : undefined;
  return {
    explanation: "Runner 会以当前用户身份运行这个程序。程序、解释器或上级目录可被其他用户替换时，会影响该用户的登录凭据与工作区；已登录不等于安装路径可信。",
    steps: [
      `先核对 detail 中的触发路径、uid/gid、mode 和 rule；本次触发规则为 ${detail.rule}。`,
      ...(own ? [] : ["该路径不属于当前用户；请安装到本人目录或联系实际安装管理者，不要对系统或他人目录直接 chmod/chown。"]),
      ...(detail.stage === "registry" ? ["注册表元数据必须保持私有，安装信任选项不适用于它。"] : []),
      "修复后重新运行 octopus-runner agents list；若还有其他触发路径，逐项核对。检查通过后等待下一次资产上报（约一分钟），刷新网页设备资产再创建会话。",
    ],
    ...(repair ? { repair } : {}), ...(trust ? { trust } : {}),
  };
}
