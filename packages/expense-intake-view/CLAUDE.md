# Expense Intake View — 凭据收件与逐笔复核

schema-3 共享 App，但 submitter 与 manager 收到不同的 viewer-scoped projection，
并渲染两棵真正不同的 DOM。v2 的 `ExpenseWorkbench.tsx` 拥有收件和逐笔复核
交互，不再把两类人强行塞进一个通用 workflow 模块。

## 不可协商的边界

- 不要把 identity 或 role 放进 action params；它们只来自可信 viewer/actor 上下文。
- submitter 只能收到自己的状态、历史、附件名和大小；不得投影原始附件或提取字段。
- manager 可收到提取文本和附件元数据，但不收到 base64 PDF。View 绝不把投影字符串
  当 HTML、URL 或脚本解释。
- React 只做提交前的快速格式反馈；workflow 策略、PDF 魔数/大小/封套验证和最终裁决
  都在 `app/`。
- PDF 内容只在用户明确提交后读取；上限 180 KiB（184,320 bytes），pending 时不重复提交。

`examples/expense-intake-v2.preview.tsx` 是只连 fixture 的 custom-root 预览入口；
`src/pack.ts` 故意不声明 module manifests/assets，因此通用打包器发布现有的七资产
custom-root profile。这只改变 View 的构成方式，不改变 iframe + MessagePort +
Trusted Host/Gate 的安全边界。
