# Chess View — 国际象棋（交互先行的共享 App）

> SDK 与布局内核：`packages/agent-view-react/CLAUDE.md`
> 实验记录：`doc/experiments/interaction-first/README.md`

## 一句话

schema 4 的双人对弈 / 人工智障电脑对弈 + 观众共享 App。v2 不再把棋室强行翻译成通用面板：
`ChessRoom.tsx` 拥有产品特有的 DOM 与交互，但仍只通过 SDK 读权威投影、发送
proposal。规则、席位、回合与最终动作裁决仍在可信侧；安全边界没有因为换了
DOM 形状而改变。

## 交互与权限

- `viewer_role` 决定白方、黑方或真正只读的观战 DOM；View 不从用户参数推测角色。
- 后端只向当前行棋方投影 `legal_moves`。View 用它做选择反馈，`chess.js` 仍在后端二次判定。
- 黑方只翻转呈现顺序，`move {from,to}` 始终使用权威投影的 canonical `行,列` 坐标。
- pending 期间不乐观移动棋子；refusal 保留选择以便重试；终局移除走子/认输动作。
- 默认玩家对战；白方只能在尚未走子时选择电脑模式，电脑固定执黑。本局黑方真人可观战、评论。
- `luna` 使用既有 shared App agent 平面，精确声明 `gpt-5.6-luna` / `max`；模型端点、白名单和预算由部署配置决定。
- View 只在自己的走子确认后自动请求一次电脑应手；打开页面和投影刷新不自动请求。长时间无落子或请求被拒时可手动重试。
- `computer_move` 同时检查可信 agent 身份、电脑模式、回合、`position_id` 和合法性；重开局也递增局面编号，迟到结果不能复用。

## 文件

| 文件 | 职责 |
|---|---|
| `app/app.yaml` | schema 4：既有角色/动作、对手选择、电脑请求与走子动作、Luna 声明与提示词 |
| `app/actions.ts` | 规则门（门 2）：chess.js 判合法、`ctx.actor.role` 判回合；拒绝 = throw |
| `app/projection.ts` | FEN → 盘面、角色化合法着、状态、座位；归属来自可信 `by` 戳 |
| `src/ChessRoom.tsx` | 产品交互根：棋盘、座次、棋谱、桌边讨论和动作生命周期 |
| `examples/chess-v2.preview.tsx` | 自定义 root + fixture 的无 Host 预览入口 |
| `src/pack.ts` | 通用打包器的配置（`pnpm run app:pack:chess` 经 `app-pack-cli.ts` 按路径加载） |
| `src/paths.ts` | Node 侧：产物位置 + 自定义 root 的 digest 清单 |

`chess.js`（^1.4.0，BSD-2-Clause）只被 `app/` 两个后端文件 import，打包期由
`bundleAppBackend` 内联进沙箱资产；View bundle 不含它，运行时依旧零 import。

## 构建与测试

```bash
pnpm --filter @claude-bot/chess-view build
npx tsc --noEmit -p packages/chess-view/tsconfig.json
npx vitest run --project chess-view --maxWorkers=1
pnpm run app:pack:chess -- --out /tmp/chess.json
```

`src/pack.test.ts` 证明通用打包器接受七资产 custom-root profile；dist 未构建或
已陈旧时大声跳过。改动 digest root 后必须重建 dist，否则打包与测试 fail-closed。

## 已知边界

- 兵升变自动成后；无悔棋、无提和（和棋只有规则和：将死/逼和/三次重复等）。
- 玩家对战由任一座位在终局后确认重开，电脑模式由白方确认；没有双方同意协议。
- 电脑应手复用后台 `openai-loop`，不启动 coding CLI，不在 View / SES 中放端点或凭据。
- 电脑模式保留到重新开局；在新局尚未走子时可以切回玩家对战。没有随机走子兜底、难度选择或电脑执白。
- 队列接受只代表请求已提交，不代表模型正在运行。60 秒尚未落子时显示手动恢复；后台失败/预算记录仍归通用 Agent 平面。
