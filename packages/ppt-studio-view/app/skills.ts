/**
 * Atomic presentation skills, adapted from the workflow ideas in ppt-master.
 *
 * The small router/safety baseline lives inline in `app.yaml`, where the
 * platform's manifest loader covers it with release identity. The text below
 * crosses the agent boundary only as the result of an explicit `load_skill`
 * tool call, keeping unrelated instructions out of the turn.
 */

export const SKILL_NAMES = ["strategy", "visual", "authoring", "template", "review", "export"] as const;

const SKILLS: Record<(typeof SKILL_NAMES)[number], string> = {
  strategy: `
先写一句受众结论，再确定 3–7 页叙事弧：背景/冲突、关键洞察、证据、行动。
每页只承担一个沟通任务；标题写结论而不是主题名。删掉不能改变结论的页面。
内容未知时使用明确占位语，不虚构数字、来源、客户或调研结果。
`,
  visual: `
选一个克制的视觉系统并贯穿全稿：一种背景、一种强调色、两级字号层次。
优先使用留白、对齐、对比与重复建立节奏。每页正文控制在可投影阅读的密度。
结构化模型只支持 title、bullets、two-column、image-ref；在这四种版式内诚实表达。
`,
  authoring: `
用 replace_deck 一次建立可读初稿，再用 deck_command 做局部修改。
稳定 slide id 使用 s1、s2…；默认 16:9。标题页之后交替使用 bullets 与 two-column，避免连续同构。
image-ref 只保存不透明引用与替代文本；没有真实资源引用时不要伪造图片已存在。
`,
  template: `
从用户给出的品牌语义提取标题语气、配色方向与重复结构，不猜字体文件或母版能力。
把模板约束映射到 deck 的 light/dark 主题与四种已支持版式。超出模型的动画、母版、图表须明确说明未保留。
`,
  review: `
逐页检查：标题是否是结论、正文是否支撑标题、页面之间是否构成连续叙事、术语是否一致。
检查空字段、重复页面、过长条目、没有替代文本的图片引用。只修能够从现有材料证明的问题。
最后复读整稿，给出仍需用户补充的事实清单，不把待确认内容写成定论。
`,
  export: `
导出前先完成 review。当前 App 只可靠地产生由 deck-model/v1 派生的 Typst 源码，用户可在导出面板复制。
不要声称生成了 PDF 或 PPTX；部署尚未安装 typst-compiler/file-transfer typed provider。
若用户需要最终文件，说明需要可信编译与下载端口，且其目录范围必须由 Host 绑定而不是由提示文本指定。
`,
};

export function skillByName(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(SKILLS, name) ? SKILLS[name as keyof typeof SKILLS].trim() : null;
}
