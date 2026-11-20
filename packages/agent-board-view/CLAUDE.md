# `@claude-bot/agent-board-view` — 通用棋盘格模块

> **2026-08-11（ADR 0007 前端配套）**：一个模块 `board.grid/v1`。ADR 原则 5 把它点名为
> 「通用」的样板：`board.grid` 是，`chess-board` 不是。象棋、围棋、跳棋、五子棋共用这一份
> 实现，靠 composition 配置区分——不靠代码分支。

## 这个包是什么

| 文件 | 职责 |
|---|---|
| `src/manifests.ts` | manifest + `config` 声明（纯数据；contract id 来自 data 包的 `/port` 入口） |
| `src/lib/board.ts` | 防御式读取器：`unknown` 进、带 status 出；只认几何，不认含义 |
| `src/components/BoardGrid.tsx` | 纯展示：ARIA grid/row/gridcell、roving tabindex、方向键 + Enter/Space |
| `src/modules.tsx` | 读实例配置、经 `app-data/v1` 读投影、持有选择态、发 `config.action` 提议 |
| `src/board-view.css` | 颜色全部来自 `--av-*` 令牌；选中/高亮/焦点用三个不同通道 |

复用 `@claude-bot/agent-data-view` 的 port 与 provider（与 `agent-deck-view` 同一先例）：
一个 App 挂**一个** `AppDataProvider`，data.\* 与 board.\* 模块共享同一份投影订阅。
不自建 port、不自建 context。

## 投影契约（宽容读取）

`config.source` 指向投影里的盘面对象：

```jsonc
{
  "rows": 3,            // 1..32 的整数，否则 malformed / too_large
  "cols": 3,
  "cells": [            // 可省略（空盘）；必须是数组
    { "r": 0, "c": 0, "glyph": "●", "label": "甲", "tone": "info" }
  ]
}
```

- 坐标 0 起始；`r`/`c` 越界或不是整数的条目**跳过**；重复位置后写的赢。
- `glyph`（≤8 字符）是格内文本；`label`（≤80）是无障碍名，缺省用 glyph 再用 `"r,c"`；
  `tone` 限 `ok/warn/error/info/neutral`，别的按 neutral。未知字段一律忽略。
- **没有 cells 条目的位置仍然渲染成可交互的格子**——落子和落点本来就是空格。
- 整体形状不对 → 一句话状态（missing / malformed / too_large），永不 crash。
- `config.highlights`（可选）指向数组，元素 `{r,c}` 或 `"r,c"`；`config.disabled`
  （可选）指向布尔，严格 `=== true` 才禁用。

## 交互与 wire

- `mode: "cell"`：点一下 → `propose(action, { r: "2", c: "1" })`。
- `mode: "move"`（默认）：第一下选起点（视图本地态，可见），再点同格取消；点别的格 →
  `propose(action, { from: "0,0", to: "1,1" })` 并**在发出时**清选择。
- 参数是扁平短字符串（2 键，远在 8 键 × 512 字符界内）。坐标原样回显投影里的数字。
- `inflight` 提议作为权威投影之上的 overlay：源格留半透明残影，目标格显示待确认 glyph，
  并用约 180ms 的浮层位移衔接；`prefers-reduced-motion` 下直接切换。忙碌期间忽略新的激活。
- 提议被拒绝 → 反向撤回后渲染 ledger 的有界原文，可手动清除并在 6 秒后自动清除；
  `snapshot.refusal` 仍作为没有对应 ledger 条目的兼容提示上屏。

## 通用性红线（不可协商）

模块**不知道**它在画什么游戏：没有规则、没有回合、没有胜负、没有合法性判断，也没有任何
游戏词汇——`architecture.test.ts` 的 "knows no game" 用词表钉住这一条。**不合法的提议照发**：
判它的是后端的规则门（SES 纯函数），拒绝以 refusal 事件回来，这正是 ADR 0007 的两道门。
想要「显示可走的格子」？让 App 后端把它投影出来、用 `highlights` 绑上——不要来改这里。

## 测试

```bash
npx vitest run --project agent-board-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-board-view/tsconfig.json
```

| 套件 | 钉住什么 |
|---|---|
| `lib/board.test.ts` | 读取器对每种坏形状的回答；跳过与截断；越界拒绝而不是截取 |
| `config.test.ts` | 声明与读取是同一份列表；manifest 合法；必填仅 source/action |
| `modules.test.tsx` | 两种交互模式端到端（fixture port）；键盘路径；高亮/禁用/拒绝；坏投影不 crash；一实现两盘的组合验收；配置写错在 link 期被拒 |
| `architecture.test.ts` | 依赖边界（无受信侧/无传输/无 SDK 根入口/无字面 action/无身份/无通道）+ 无游戏词汇 |
