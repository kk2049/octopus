export function project(events: any[]) {
  return projectIncremental({}, events);
}

export function projectIncremental(snapshot: any, events: any[]) {
  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  let deck: any = prior.deck ?? null;
  const loaded: string[] = Array.isArray(prior.loadedSkills)
    ? prior.loadedSkills.filter((value: any): value is string => typeof value === "string")
    : [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "deck_changed" && event?.data?.deck) deck = event.data.deck;
    if (event?.type === "skill_loaded") {
      const name = String(event?.data?.name ?? "");
      if (name && !loaded.includes(name)) loaded.push(name);
    }
  }
  return {
    deck: deck ?? seedDeck(),
    loadedSkills: loaded,
    askPresenterParams: {
      prompt: {
        type: "text",
        required: true,
        description: "受众、目标、材料与希望修改的部分；不要放本机路径或秘密。"
      }
    },
    export: {
      available: "typst-source",
      unavailable: ["pdf", "pptx", "workspace-download"]
    }
  };
}

function seedDeck() {
  return {
    schema: "deck-model/v1",
    title: "PPT Studio",
    theme: "light",
    slides: [
      { id: "s1", layout: "title", title: "PPT Studio", subtitle: "按需技能注入的结构化演示文稿工作台" },
      { id: "s2", layout: "bullets", title: "从目标到可编辑初稿", bullets: ["描述受众与结论", "agent 按需加载原子技能", "在同一画布继续手工编辑"] },
      { id: "s3", layout: "two-column", title: "边界是产品的一部分", left: ["唯一事实源：deck-model/v1", "每次编辑：语义命令"], right: ["实际文件权限：无", "派生输出：Typst 源码"] },
      { id: "s4", layout: "image-ref", title: "图片引用保持不透明", image: { ref: "", alt: "待绑定的演示图片" }, caption: "View 不解析本机路径；真实资源必须由可信 Host 绑定。" },
      { id: "s5", layout: "title", title: "开始创作", subtitle: "在下方写下演示目标，或直接点击画布修改文字" }
    ]
  };
}
