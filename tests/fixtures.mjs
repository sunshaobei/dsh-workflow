const names = [
  "解析需求与设计稿",
  "并行开发页面与接口层",
  "把页面接到接口上",
  "跑冒烟检查并修复",
  "交付核对与真机冒烟清单",
];
const labels = [
  "设计解析员",
  "页面开发工程师",
  "接口开发工程师",
  "接口对接工程师",
  "冒烟测试工程师",
  "交付核对员",
];
export const entry = {
  name: "dev-requirement-pipeline",
  description:
    "一体化开发流水线：设计解析 → 并行开发页面与接口层 → 接口对接 → 冒烟门禁（失败自动修复）→ 交付核对",
  groupId: "p",
  scope: "project",
  path: "/project/.dsh/workflows/dev-requirement-pipeline.dwf.ts",
  args: {
    requirement: { type: "string", required: true, description: "需求描述" },
    figmaUrl: { type: "string", default: "" },
    designSpecPath: { type: "string", default: "" },
    retry: { type: "number", default: 3 },
    enabled: { type: "boolean", default: false },
    options: { type: "json", default: { strict: true } },
  },
};
export const groups = [
  { id: "global", scope: "global", name: "全局", entries: [], errors: [] },
  {
    id: "p",
    name: "<workspace>",
    scope: "project",
    entries: [entry],
    errors: [],
  },
];
export function fixtureRun(completed = false) {
  const actors = labels.map((name, i) => ({
    name,
    siteId: "actor#" + (i + 1),
    id: "actor-" + i,
    ordinal: 1,
    sessionId: completed || i === 0 ? "child-" + i : undefined,
    status: completed ? "completed" : i === 0 ? "running" : "pending",
    tasks: completed || i === 0 ? 1 : 0,
  }));
  const mapping = [[0], [1, 2], [3], [4], [5]];
  return {
    runId: completed ? "dwfrun-complete" : "dwfrun-running",
    name: "一体化开发流水线·跑通验证",
    parentSessionId: "parent",
    status: completed ? "completed" : "running",
    savedName: entry.name,
    groupId: "p",
    createdSeq: 4,
    caps: { maxConcurrency: 4 },
    actors,
    phases: names.map((name, i) => ({
      name,
      id: "phase-" + i,
      status: completed ? "completed" : i === 0 ? "running" : "pending",
      total: mapping[i].length,
      completed: completed ? mapping[i].length : 0,
      actors: mapping[i].map((j) => actors[j]),
      nodes: [],
      rounds: 1,
    })),
    nodes: [],
    activeActors: completed ? 0 : 1,
    activePhase: completed ? names[4] : names[0],
    reports: [],
    counts: { asks: 6 },
    figures: {
      durationMs: completed ? 2143000 : 92000,
      tokens: completed ? 2680000 : undefined,
      subagents: 6,
      phases: 5,
    },
    artifacts: completed
      ? [
          {
            id: "report",
            kind: "markdown",
            title: "一体化流水线测试报告",
            description:
              "法币汇率换算卡片：经设计解析、页面开发、接口对接、冒烟检查的全部产出与结论",
            contentType: "text/markdown",
            bytes: 22221,
            uri: "dsh-workflow://dwfrun-complete/report-1",
          },
        ]
      : [],
  };
}
export const artifact = {
  ...fixtureRun(true).artifacts[0],
  content:
    "# 一体化流水线测试报告\n\n需求：新增法币汇率换算卡片。\n\n## 验收\n\n- 页面开发完成\n- 接口对接完成\n\n|检查|结果|\n|---|---|\n|静态分析|通过|",
  base64: "",
};
export function fixtureResponse(url) {
  if (url.includes("/hub"))
    return {
      groups,
      runs: [],
      settings: { mode: "alwaysOn", maxConcurrency: 4 },
    };
  if (url.includes("/models"))
    return {
      models: [{ id: "model", provider: "provider", name: "测试模型" }],
    };
  if (url.includes("/runs")) return { runs: [fixtureRun(), fixtureRun(true)] };
  if (url.includes("/artifact")) return { artifact };
  if (url.includes("/run?"))
    return { run: fixtureRun(url.includes("complete")), holes: [] };
  if (url.includes("/saved?"))
    return { entry: { ...entry, source: "/* zcode-workflow */\nreturn 1;" } };
  return { ok: true };
}
