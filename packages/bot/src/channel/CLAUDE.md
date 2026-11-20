# channel/ — 飞书账号授权与租户目录

v2 的聊天 Channel 层(`FeishuProvider`、`WebSocketProvider`、卡片渲染、CLI 前端)
已随 v2 组合根于 2026-10-15 下线。本目录只剩两个现行模块:

- `feishu-oauth.ts` — `FeishuAuthManager`:用户级飞书授权的令牌存取与续期,bootstrap-v3 用它为飞书网关解析"以谁的身份"。
- `feishu-directory.ts` — `FeishuDirectory`:/admin 飞书成员浏览所需的租户目录读取;bootstrap-v3 目前不构造它(/admin 显示"未配置飞书")。

## 飞书 OAuth Device Flow

`feishu-oauth.ts` 实现 RFC 8628 设备授权：
1. `startDeviceAuth()` → 返回 device_code + user_code + verification_uri
2. 用户在浏览器授权
3. `pollForToken()` → 轮询获取 user_access_token
4. Token 过期自动通过 refresh_token 续期

**关键**：`refreshUserToken()` 必须检查 API 错误响应（`code !== 0`），否则 `data.data` 为 undefined 时 crash。

**并发续期**：refresh token 只能用一次。`getUserToken` 对同一用户同时只发起一次续期，其余调用等待同一个结果；不要绕过它去直接调用 `refreshUserToken`。
