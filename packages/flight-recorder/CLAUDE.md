# Flight Recorder — 业务无关的前端语义事件流

> 2026-08-15 新增(工单 #138,P1)。
> 设计与词表:`doc/development/frontend-observability-design.md` §3。

## 一句话

有界环形缓冲里的语义事件(`FlightEvent`):谁提议了什么、一帧投影带了哪些集合多少行、
异常 UI 状态何时翻转。**记摘要不记内容**;每个字段在入口处限幅。一键 `export()` 出
带版本的 JSON blob,供断言引擎、修复工单与 agent 分析消费。

## 不可协商的边界

- **零依赖**。可信 dashboard host 与不可信 Agent View 运行时都会 import 本包,
  任何依赖都会进入 App View bundle。
- **不持有授权、不缓存 capability 结果、不碰网络**。它只是某个 surface 自己的内存,
  导出是显式动作。
- **delta 只收 primitive**:对象一律丢弃而不是字符串化——字符串化正是 payload 混进
  摘要的走私通道。
- **summariser 只有一份**(`projection-summary.ts`):两个发射方各自算摘要,就是两条
  大体一致的时间线,对分析 agent 比没有更糟。集合缺席与 0 行是两个不同事实。

## 测试

```bash
npx vitest run packages/flight-recorder --maxWorkers=1
npx tsc --noEmit -p packages/flight-recorder/tsconfig.json
```
