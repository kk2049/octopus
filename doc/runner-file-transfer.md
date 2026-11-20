# Runner 文件互传

本机 Codex、Claude、OMP 可通过 Octopus MCP，在同一账号的已登记 Runner
workspace 之间复制普通文件。两台机器只需能连接 Octopus，无需彼此 SSH 或开放入站端口。

## 使用

先调用 `octopus_list_execution_targets`。`targets` 列出远端，
`local_target` 列出当前发起 Runner 及其 workspace；两端都需显示
`file_transfer: true`，否则先更新对应 Runner。

调用 `octopus_copy_file`：

```json
{
  "source_device": "远端返回的精确 device",
  "source_workspace_id": "远端返回的精确 workspace_id",
  "source_path": "results/data.bin",
  "destination_workspace_id": "local_target 返回的精确 workspace_id",
  "destination_path": "analysis/data.bin"
}
```

省略 `destination_device` 时，目标是当前发起 MCP 的 Runner。
推送本机文件时把 `source_device` 设为 `local_target.device`；
传给另一台远端时显式填写其 `destination_device`。

返回 `transfer_id` 后，用 `octopus_get_file_transfer` 查询同一个 ID，
直到 `completed`；需要终止时用 `octopus_cancel_file_transfer`。
字节数使用十进制字符串，完成回执包含最终 SHA-256。
文件内容只经过传输通道，不进入 MCP 文本或模型上下文。

目标父目录必须存在；目录先在源端打包，再复制归档。
路径为 workspace 内的 POSIX 相对路径，Windows 也使用正斜杠。
绝对路径、上级路径、符号链接和 Windows 特殊设备/备用数据流路径均拒绝。

## 大文件与覆盖

没有文件总大小或总传输时长上限。每块最多 1 MiB，各端按块处理；
接收端写同目录私有暂存文件，完成校验后原子发布。
单次 RPC 超时 30 秒；目标旧文件的整份摘要计算也在后台运行，状态查询保持有界。

默认 `expected_digest: "absent"`，只创建新文件，期间出现同名文件也不覆盖。
替换已有文件时先取得目标完整 SHA-256，传入
`expected_digest: "sha256:<64 位小写十六进制>"`。目标被并发修改时拒绝替换。
替换保留原权限位；新文件默认仅当前用户读写。
创建操作要求目标文件系统支持同目录硬链接，如 NTFS、APFS、ext4。

## 授权与失败处理

- 发起设备遵守 Dashboard 的 disabled/manual/full_access 策略。
  manual 对整次复制生成一张审批，展示两端设备、workspace、路径和覆盖前提。
  `approval_required` 返回原传输 ID 和审批 ID；批准后查询原传输，勿重新提交。
- 使用独立的 `runner-file-transfer-v1` capability Object，不扩大旧文件或执行授权。
  服务端从已认证连接绑定 owner 和发起设备；状态与取消仅供同账号原发起设备使用。
- 每块前后检查授权。相关设备撤权、发起 Runner 断连或 Gateway 重启都会停止旧任务。
  目标 Runner 断开站点连接时关闭该站点的流，其他站点的流独立。
- 关闭 MCP 子进程不会取消服务端传输；同一发起 Runner 的新客户端可查询原 ID。
  回执仅在当前 Gateway 进程保存，最多最近 256 条，完成后一小时过期。
- 失败/取消清理暂存文件；断链时清理为尽力执行，空闲句柄五分钟后回收。
  Runner 被强制杀死可能留下 `.octopus-transfer-<UUID>.part`；
  确认无传输后可手动移除，不影响原目标文件。
- `indeterminate` 表示提交已发出但结果无法确认。先检查目标及摘要，不自动重放。
  暂不支持断点续传或跨 Gateway 重启恢复。
- 并发限制为每账号 4 个、Gateway 共 8 个，只约束同时占用的资源，不限制文件大小。

实现入口：`packages/bot/src/runner-file-transfer/` 与
`packages/runner/src/file-transfer.ts`。typed-port-kit 导出 MCP 描述与参数定义；
原始二进制 RPC 仅供可信 capability adapter 使用。
