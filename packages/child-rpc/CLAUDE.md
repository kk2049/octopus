# Child RPC — 继承 IPC 的最小监督协议

这个包只解决 Node 父子进程的进程控制与有界 request/reply：ready 握手、关联 id、超时、并发与
单帧大小上限、诊断输出、优雅停止及信号升级。

单帧上限（默认 2 MiB）是**窗口**，不是一次调用能携带的总量：超过一帧的 request/response 由发送方
按 UTF-8 JSON 字节切成有序 `part` 帧（base64，每帧大小可证明不超过上限），接收方按 id 重组后再分发。
不超过一帧的消息与旧协议逐字节相同。单帧本身超限仍是协议违规：父进程停止该子进程。

不可改变的边界：

- 只使用 `fork()` 继承的 IPC descriptor；不监听 TCP/Unix socket，不生成 bearer token。
- descriptor 是通道绑定，不是用户身份；本包没有 owner、App、权限或 capability 语义。
- production 调用方必须显式传最小环境；这个包不会继承或补齐秘密。
- 非法消息、超限单帧与拼不回原消息的分片 fail closed；子进程错误只返回稳定 code，不把任意诊断文本当协议。
- `src/test-child.ts` 与进程内替代物只用于测试，不能成为生产降级路径。

若新服务需要认证、路由发现或网络传输，应在其自己的边界设计里解决，不要把这里扩成通用 RPC
平台。
