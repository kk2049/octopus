/**
 * TCB 预算：让「可信代码在长大」这件事变得刺眼。
 *
 * 为什么需要它：上一轮把必须可信的面从零涨到约一千行，而**没有任何一步是错的**
 * ——每一行都有理由（要持久化、要审计、要参数校验、要批准流程）。膨胀不是因为
 * 有人偷懒，是因为没有任何东西在反抗。这个测试就是那个反抗。
 *
 * 它**永不失败、永不阻塞**。它只做两件事：
 *
 *   1. 算出从 `entries` 出发、沿**值导入**的传递闭包 —— 也就是授权判定真正会
 *      执行到的全部代码。把逻辑挪进一个新文件躲不过去。
 *   2. 与 `tcb-budget.json` 的 baseline 比。涨过 tolerance，就把准入标准打到
 *      测试者面前。
 *
 * 该怎么办，见下面 `ADMISSION`。
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = path.join(HERE, "..", "tcb-budget.json");

interface Budget {
  entries: string[];
  tolerance: number;
  baseline: Record<string, number>;
  critical: string[];
  justifications: Array<{ file: string; lines: number; why: string; recorded_at?: string }>;
}

/** 准入标准。短，因为它要在被人真正读一遍的时刻出现。 */
const ADMISSION = `
  一个问题：这段代码错了，A 账户能不能碰到 B 的资源？

  能 —— 它就该在 TCB 里，把理由记进 tcb-budget.json 的 justifications。
  不能 —— 搬出去。以下四条是「不能」的常见形态，也是四条搬法：

  1. 它只是读图之后给出一个更窄的答案。
     → 做成 TCB 的**输入**（一个声明、一个参数），让调用方提供，TCB 只做交集。
       先例：effect 类与 autoAllow 的默认值算法在 service，不在 core。

  2. 最坏后果是「多执行一次」/「少问一次人」/「结果不可判定」。
     → 那是同意与幂等，不是隔离。判据：这段代码只能**重放** TCB 已经封存过的
       坐标，不能构造新坐标。先例：311 行的批准状态机在 approval.ts。

  3. 它要看参数内容、字节数、时钟，或者要碰真实资源。
     → 授权判定只看图。这些搬去 objects / adapter / service。

  4. 它是同一个事实的第二份表示（缓存、镜像、索引、快照）。
     → 删掉一份。两份表示要同步，而同步 bug 会**伪装成**授权 bug：上一轮持久化
       层修的四个缺陷，一个授权 bug 都没有，全是同步 bug。

  搬不动的，在 justifications 里一行一条写清「为什么这行必须可信」，并把
  baseline 调到新值 —— 那是一次刻意的人类动作，不该顺手做。
`;

function codeLines(file: string): number {
  let n = 0;
  let inBlock = false;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    if (inBlock) {
      if (s.includes("*/")) inBlock = false;
      continue;
    }
    if (s.startsWith("/*")) {
      if (!s.includes("*/")) inBlock = true;
      continue;
    }
    if (s.startsWith("//") || s.startsWith("*")) continue;
    n++;
  }
  return n;
}

/**
 * 一条 import 是不是纯类型导入。
 *
 * 这是闭包算得准不准的关键：`import type` 编译后什么都不剩，所以它引到的文件不在
 * 授权判定的执行路径上。`store.ts` 就是这样被排除的 —— 它是一组接口声明。
 */
function isTypeOnly(clause: string): boolean {
  const c = clause.trim();
  if (c.startsWith("type ")) return true;
  const braces = /^\{([\s\S]*)\}$/.exec(c);
  if (!braces) return false; // 默认导入或 namespace 导入：当作值
  return braces[1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .every((x) => x.startsWith("type "));
}

/**
 * 一份源码里的本地**值**导入。
 *
 * 子句里不许出现引号或分号：否则非贪婪匹配会把**上一条**完整的 import 吞进来，于是
 * `import { randomUUID } from "node:crypto"` 会把紧随其后的
 * `import type ... from "./store.js"` 误判成值导入。第一版就是这么把纯接口文件
 * store.ts 算成可信代码的。
 */
export function localValueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+((?:[^"';])*?)\s*from\s+"([^"]+)"/gm)) {
    const spec = m[2];
    if (!spec.startsWith(".")) continue;
    if (isTypeOnly(m[1])) continue;
    out.push(path.normalize(spec.replace(/\.js$/, ".ts")));
  }
  return out;
}

/** 从入口出发、沿值导入的传递闭包。 */
function valueClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const file = path.join(HERE, name);
    if (!fs.existsSync(file)) continue;
    seen.add(name);
    queue.push(...localValueImports(fs.readFileSync(file, "utf8")));
  }
  return seen;
}

/**
 * 直写 stderr，**不用 `console.warn`**。
 *
 * vitest 的默认 reporter 会把通过测试里的 console 输出吞掉 —— 实测过：`console.warn`
 * 只在 `--reporter=verbose` 下出现。一个看不见的警告等于没有警告，而这个机制的
 * 全部作用就是被人看见。`process.stderr.write` 不经 console 拦截，默认 reporter 下
 * 照样打出来。
 */
function warn(title: string, body: string): void {
  const bar = "━".repeat(78);
  process.stderr.write(`\n${bar}\n  ${title}\n${bar}\n${body}\n${bar}\n\n`);
}

describe("TCB 预算", () => {
  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")) as Budget;

  /**
   * 唯一一条会失败的：`isTypeOnly` 的分类。
   *
   * 它测的是**我自己的度量工具**，不是任何政策。这里错了，闭包就算错了，而一个
   * 算错的数字比没有数字更糟 —— 第一版的正则会把上一条 import 吞进来，于是纯类型
   * 的 `store.ts` 被算成可信代码。
   */
  it("import 分类正确（闭包算得准的前提）", () => {
    expect(isTypeOnly("type { A }")).toBe(true);
    expect(isTypeOnly("{ type A, type B }")).toBe(true);
    expect(isTypeOnly("{ A }")).toBe(false);
    expect(isTypeOnly("{ A, type B }")).toBe(false); // 混合 = 值导入
    expect(isTypeOnly("* as ns")).toBe(false);

    // 第一版的 bug，钉在合成源码上而不是钉在 core.ts 现在的样子上 —— 后者会让
    // 「给 core.ts 加一条正当的本地值导入」变成一次测试失败。
    expect(
      localValueImports(
        [
          'import { randomUUID } from "node:crypto";',
          'import type { CapabilityStore } from "./store.js";',
          "import {",
          "  ApprovalEvidence,",
          "  type AuditRecord,",
          '} from "./types.js";',
          'import { hashArgs } from "./canonical.js";',
        ].join("\n"),
      ),
    ).toEqual(["types.ts", "canonical.ts"]);
  });

  /**
   * 规模与登记。**永不失败、永不阻塞。**
   *
   * 阻塞会让人去改 baseline 而不是去读代码，那正好毁掉这个机制的全部作用。它只
   * 在该被读一遍的时刻，把准入标准放到测试者眼前。
   */
  it("可信闭包的规模与登记", () => {
    const closure = [...valueClosure(budget.entries)].sort();
    const now: Record<string, number> = {};
    for (const f of closure) now[f] = codeLines(path.join(HERE, f));

    const declared = Object.keys(budget.baseline);
    const unregistered = closure.filter((f) => !declared.includes(f));
    const stale = declared.filter((f) => !closure.includes(f));
    const total = Object.values(now).reduce((a, b) => a + b, 0);
    const baseTotal = Object.values(budget.baseline).reduce((a, b) => a + b, 0);
    const delta = total - baseTotal;
    const criticalNow = budget.critical.reduce((a, f) => a + (now[f] ?? 0), 0);
    const covered = budget.justifications.reduce((a, j) => a + j.lines, 0);

    const table = closure
      .map((f) => {
        const d = (now[f] ?? 0) - (budget.baseline[f] ?? 0);
        const mark = budget.critical.includes(f) ? "‼" : " ";
        const flag = declared.includes(f) ? "" : "  ← 未登记";
        const dd = d === 0 ? "" : d > 0 ? `(+${d})` : `(${d})`;
        return `  ${mark} ${f.padEnd(16)} ${String(now[f]).padStart(4)} 行  ${dd}${flag}`;
      })
      .join("\n");
    const head =
      `  可信闭包 ${total} 行（baseline ${baseTotal}${delta === 0 ? "" : delta > 0 ? `, +${delta}` : `, ${delta}`}）\n`
      + `  其中隔离关键（‼）${criticalNow} 行 —— 「错了就是跨账户」的部分\n\n${table}`;

    // 最响的一条：有文件**新进了**可信路径。这正是该读一遍准入标准的时刻。
    if (unregistered.length) {
      warn(
        `⚠  有文件新进了可信路径且未登记：${unregistered.join(", ")}`,
        `${head}\n\n  把逻辑挪进新文件不会让它离开 TCB —— 闭包会跟过去。\n${ADMISSION}`,
      );
      return;
    }
    if (stale.length) {
      warn(`·  预算表里有已不在闭包里的文件，可以删掉：${stale.join(", ")}`, head);
      return;
    }
    if (delta > budget.tolerance) {
      if (covered >= delta) {
        // 已记录理由：不复读准入标准，但**仍然显示** —— 让扩张被静默正常化，是
        // 这里唯一要防的事。
        warn(
          `⚠  TCB 已扩张 ${delta} 行，理由已记录 —— 请确认这些理由现在还成立`,
          `${head}\n\n` + budget.justifications.map((j) => `  · ${j.file} +${j.lines}：${j.why}`).join("\n"),
        );
      } else {
        warn(
          `⚠  TCB 比 baseline 涨了 ${delta} 行（容差 ${budget.tolerance}）—— 需要重新审视一遍`,
          `${head}\n${ADMISSION}`,
        );
      }
      return;
    }
    if (delta < -20) {
      // 棘轮只往紧的方向转：缩小了就把 baseline 落下来，否则下一次膨胀会被这段
      // 旧余量吃掉而不报警。
      warn(`✓  TCB 缩小了 ${-delta} 行 —— 把 tcb-budget.json 的 baseline 调到当前值`, head);
    }
  });
});
