# Agent View Preview — 草稿 View 的本机预览

> 2026-08-11 自 `@claude-bot/agent-view-react` 拆出（原 `./preview` 子入口）；
> 行为逐字未变。独立成包的理由与当年独立成入口相同：released bundle 伸手拿
> 「最顺手的 import」也拿不到 fixture——一个把 fixture 编译进去的 View 会自问自答。

## 一句话

`pnpm run app:preview -- <plan 文件>`：一个草稿组合或自定义 App root 几秒内出现在 loopback 端口上，
数据全部来自 fixture——没有 Host、没有授权、不写任何东西。

## 文件

| 文件 | 职责 |
|---|---|
| `src/fixture-client.ts` | `createFixtureAgentViewClient()`：没有通道的 `AgentViewClient`。**不模拟**批准、capability、身份、撤销、握手与 fuse——假装模拟那些就是在教作者「我的 App 已被授权」。纯浏览器代码，jsdom 测试也在用 |
| `src/plan.ts` | 两种互斥输入：`definePreviewPlan()` 保持模块组合走 `StandardApp`；`defineCustomPreview()` 让 bespoke root 在同一个 fixture Provider 下直接 render |
| `src/cli.ts` | `app:preview` 的运行时：Vite dev server + resolver alias（**不写生成文件**），`fs.allow` 只放宽到仓库根 |
| `src/app/` | 预览入口：与生产相同的 Provider / ErrorBoundary / `StandardApp`，仅传输换成 fixture |

## 三条不可协商

- **不写盘。** plan 经 resolver alias 到达，预览不留下任何一个之后的构建可能捡走的
  文件。
- **不接真实后端。** 两种 View profile 都只接 fixture；能两头接的 harness 离「一个 flag 之差预览生产数据」只有一步，
  而被预览的是不可信 publisher 代码。接开发实例是列明的 future work。
- **默认 loopback。** `--host` 才是显式 opt-in；公网演示归 8920-8939 窗口。

## 消费者与依赖方向

本包依赖 `@claude-bot/agent-view-react`（`.`、`./shell`、`./workspace` 三个公开
入口，不再有目录内相对 import）。反向只有 devDependency：`agent-view-react` 的
`StandardApp.test.tsx`、`agent-data-view` 与 `showcase-view` 的测试和 `examples/`
plan 文件用 fixture client——开发期循环，pnpm workspace 允许，生产 bundle 不含。

## 测试

`src/plan.test.ts` 锁定组合型 plan 的向后兼容和自定义 root 不被转译成
composition；fixture client 的行为另由消费它的 jsdom 测试（`StandardApp.test.tsx`、
`example.test.tsx`、`modules.test.tsx`）证明。CLI 由 `pnpm run app:preview` 的真实使用覆盖。typecheck：
`npx tsc --noEmit -p packages/agent-view-preview/tsconfig.json`。
