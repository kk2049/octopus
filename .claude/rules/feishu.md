---
paths:
  - "packages/bot/src/channel/**/*"
  - "packages/bot/src/feishu/**/*"
  - "plugins/feishu*/**/*"
---

# Feishu

- Card header titles use `{ tag: "plain_text", content }`; card Markdown uses
  `{ tag: "div", text: { tag: "lark_md", content } }`.
- Keep display elements outside forms; forms contain form controls and submit
  actions. Parse callback identity from `operator.open_id` and
  `context.open_chat_id`.
- Use Task API v2 only. Do not fall back to v1 on an empty result.
- OAuth must use the same application id/secret as the Feishu MCP integration.
- Critical `result`, `error`, and `status_change` events bypass throttling.
  Feishu `text` and `result` update the existing progress card rather than
  creating an unrelated message.
