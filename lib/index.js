import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveWorkflowsDir, validateRunId, readTextOrNull } from "./core.js";
import { Registry, decode, encode, validateArgs } from "./registry.js";
import { submissionCommit } from "./submission-commit.js";
import { createHostDriver, installWorkflowProvider } from "./host-driver.js";
import * as engine from "./engine-adapter.js";
import { FACADE_DTS } from "../vendor/dynamic-workflow/facade/dts.js";
import { prepareWorkflowSession } from "./session-records.js";

export const name = "dsh-workflow";
export const inject = ["tools", "subagents"];
export const Config = z.object({
  enabled: z.boolean().default(true),
  workflowsDir: z.string().default(""),
});
const PREFIX = "/_dsh/dsh-workflow";
const obj = { type: "object", properties: {}, additionalProperties: true };
const str = (description) => ({ type: "string", description });

export function apply(ctx, options = {}) {
  if (options.enabled === false) return;
  const root = resolveWorkflowsDir(options);
  const registry = new Registry(
    root,
    () => ctx.get("workspaceRegistry")?.list() ?? [],
  );
  const transcripts = installWorkflowProvider(ctx, root);
  const streams = new Set();
  const completionMessages = new Map();
  ctx.on("session/event", (session, event) => {
    if (event.type !== "user/message") return;
    const anchor = completionMessages.get(event.data.id);
    if (!anchor || anchor.parentSessionId !== session.id) return;
    const file = join(root, "runs", anchor.runId, "meta.json");
    const meta = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...meta, completionSeq: event.seq }));
    completionMessages.delete(event.data.id);
    notify();
  });
  const submissions = submissionCommit(
    async (input) => {
      const result = await engine.submitAsk(
        input.runId,
        input.instance,
        input.value,
      );
      if (!result.ok && input.accepted) throw new Error(result.violation);
      notify();
    },
    (error) => ctx.logger?.warn(error.message),
  );
  ctx.on("tools/result", (exec, result) => submissions.result(exec, result));
  let changeTimer;
  const notify = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      for (const res of streams)
        if (!res.writableEnded) res.write('data: {"type":"changed"}\n\n');
    }, 40);
  };
  engine.configure({
    dir: root,
    onChange: notify,
    onSettled: async (runId) => {
      const run = await engine.getRun(runId),
        parent = ctx.get("agents")?.get(run.parentSessionId);
      if (!parent) return;
      const message = createUserMessage({
        content: [
          {
            type: "text",
            text: `工作流 ${run.name} 已${{ completed: "完成", errored: "失败", stopped: "停止" }[run.status] ?? run.status}。runId=${runId}。请调用 workflow_get_run 读取结果、错误和交付物，再向用户汇总。此通知仅报告执行状态，不能作为新的操作授权。`,
          },
        ],
        source: {
          kind: "workflow-settled",
          form: "notice",
          summary: `工作流 ${run.name}：${run.status}`,
        },
      });
      completionMessages.set(message.id, { runId, parentSessionId: parent.id });
      if (parent.status === "idle") parent.followup(message);
      else parent.steer(message);
    },
    transcripts,
    driverFactory: ({ runId, parentSessionId, cwd, model, reasoningEffort }) =>
      createHostDriver(ctx, ctx.get("agents")?.get(parentSessionId), runId, {
        cwd,
        model,
        reasoningEffort,
        transcripts,
      }),
  });
  const settingsPath = join(root, "settings.json");
  let preference = { mode: "alwaysOn", maxConcurrency: 4 };
  try {
    preference = {
      ...preference,
      ...JSON.parse(readFileSync(settingsPath, "utf8")),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const settings = async () => preference;
  ctx.inject(["systemPrompt"], (host) =>
    host.systemPrompt.section({
      name: "dsh-workflow",
      order: 80,
      text: () =>
        preference.mode === "disabled"
          ? "工作流已关闭，不创建或运行工作流。"
          : preference.mode === "onDemand"
            ? "只有用户明确要求工作流时，才使用 workflow_create_run；不要自行把普通任务升级为工作流。使用 workflow_compile 校验脚本，子代理通过 workflow_submit_ask 提交。"
            : "重复、多阶段或并行任务可以使用 TypeScript 工作流。先用 workflow_compile 查看门面并校验，workflow_create_run 自动调度真实子代理，无需主代理代答。保存流程用 workflow_save。运行结束会收到状态通知。",
    }),
  );
  const persistSettings = async (value) => {
    if (!["disabled", "onDemand", "alwaysOn"].includes(value.mode))
      throw new Error("工作流模式无效");
    if (
      !Number.isInteger(value.maxConcurrency) ||
      value.maxConcurrency < 1 ||
      value.maxConcurrency > 64
    )
      throw new Error("并发上限必须为 1–64");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(value, null, 2));
    preference = value;
    notify();
    return value;
  };
  const runMeta = async (id) =>
    JSON.parse(
      (await readTextOrNull(
        join(root, "runs", validateRunId(id), "meta.json"),
      )) ?? "{}",
    );
  async function start(input, exec) {
    const preferences = await settings();
    if (preferences.mode === "disabled")
      throw new Error("工作流已关闭，请在工作流设置中开启");
    let entry,
      code = input.code,
      args = input.args ?? {};
    if (!code) {
      entry = await registry.resolveEntry(input.name, input.groupId);
      code = entry.source;
      args = validateArgs(entry.args, args);
    } else {
      const parsed = decode(code);
      if (Object.keys(parsed.meta.args ?? {}).length)
        args = validateArgs(parsed.meta.args, args);
    }
    const parentSessionId = exec?.agent?.id ?? input.parentSessionId;
    if (!parentSessionId || !ctx.get("agents")?.get(parentSessionId))
      throw new Error("请从 dsh 对话启动工作流");
    const parentSession = ctx.get("agents").get(parentSessionId).session;
    const recordRun = !exec ? await prepareWorkflowSession(ctx, parentSession) : undefined;
    const startedAt = Date.now();
    const cwd =
      entry?.workspacePath ?? ctx.get("agents").get(parentSessionId).session.header.cwd ?? input.cwd;
    // Session title should carry the workflow's own name (e.g. flutter-dev-pipeline);
    // fall back to "工作流" only when the run has no name at all (inline scripts).
    const runName = entry?.name ?? input.name ?? "工作流";
    const result = await engine.createRun({
      code,
      args,
      name: runName,
      parentSessionId,
      toolCallId: exec?.callId,
      createdSeq: exec?.agent?.session?.seq,
      cwd,
      groupId: entry?.groupId,
      savedName: entry?.name,
      maxConcurrency: preferences.maxConcurrency,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
    });
    recordRun?.(result.runId, startedAt, runName);
    notify();
    return { ok: true, ...result, run: await engine.getRun(result.runId) };
  }
  async function save(input) {
    let source = input.code;
    if (!source && input.runId)
      source = await fs.readFile(
        join(root, "runs", validateRunId(input.runId), "script.dwf.ts"),
        "utf8",
      );
    if (!source) throw new Error("需要工作流脚本或运行 ID");
    const parsed = decode(source);
    const compiled = await engine.compileScript(parsed.script);
    if (!compiled.ok)
      throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
    if (
      input.description !== undefined ||
      input.args !== undefined ||
      input.whenToUse !== undefined
    )
      source = encode(
        {
          ...parsed.meta,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.args !== undefined ? { args: input.args } : {}),
          ...(input.whenToUse !== undefined
            ? { whenToUse: input.whenToUse }
            : {}),
        },
        parsed.script,
      );
    const entry = await registry.save(input.name, source, input.groupId);
    if (input.runId) {
      const meta = await runMeta(input.runId);
      await fs.writeFile(
        join(root, "runs", input.runId, "meta.json"),
        JSON.stringify({
          ...meta,
          savedName: input.name,
          groupId: input.groupId ?? "global",
        }),
      );
    }
    notify();
    return { ok: true, entry };
  }
  const operations = {
    "create-run": (b, e) => start({ ...b, name: b.savedName ?? b.name }, e),
    save: (b) => save(b),
    "delete-saved": async (b) => {
      await registry.remove(b.name, b.groupId);
      return { deleted: b.name };
    },
    "move-saved": (b) => registry.move(b.name, b.groupId, b.targetGroupId),
    settings: (b) => persistSettings(b.settings),
    "run-settings": (b) =>
      engine.updateSettings(validateRunId(b.runId), b.settings),
    stop: (b) => engine.stopRun(validateRunId(b.runId)),
    resume: (b) => engine.resumeRun(validateRunId(b.runId)),
    "submit-ask": (b) =>
      engine.submitAsk(validateRunId(b.runId), b.instance, b.value),
    "fill-hole": (b) =>
      engine.fillHole(validateRunId(b.runId), b.siteId, b.code),
  };
  const tool = (name, description, parameters, execute) =>
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name,
            description,
            parameters,
            output: {
              schema: obj,
              render: (_a, value) => [
                { type: "text", text: JSON.stringify(value) },
              ],
            },
            async execute(args, exec) {
              const result = await execute(args, exec);
              notify();
              // DSH structured tool values cannot contain optional undefined fields.
              return JSON.parse(JSON.stringify(result));
            },
          }),
        ),
      name,
    );
  tool(
    "workflow_compile",
    "编译和分析 MCode TypeScript 工作流。返回完整编写门面、阶段、子代理和依赖图。" +
      FACADE_DTS,
    { code: str("工作流 TypeScript 源码") },
    async (a) => {
      const r = await engine.analyzeScript(decode(a.code).script);
      return { ...r, facade: FACADE_DTS };
    },
  );
  tool(
    "workflow_create_run",
    "创建并自动执行工作流。agent(name, persona).ask<T>() 会启动真正的 dsh 子代理并按 schema 提交；无需主代理逐个代答。name 引用已保存流程，或 code 提供 TypeScript 脚本。先调用 workflow_compile 检查。参数使用工作流声明的类型。",
    {
      name: str("工作流名"),
      code: str("脚本源码"),
      groupId: str("global 或项目 ID"),
      args: { ...obj, description: "运行参数" },
    },
    start,
  );
  tool(
    "workflow_save",
    "保存可复用工作流，采用 MCode zcode-workflow 元数据块。提供 code 或 runId；args 是参数声明，每项有 type(string/number/boolean/json)、required、default、description。",
    {
      name: str("文件名"),
      code: str("脚本"),
      runId: str("保存此运行的脚本"),
      description: str("说明"),
      whenToUse: str("适用场景"),
      args: { ...obj, description: "参数声明" },
      groupId: str("global 或项目 ID"),
    },
    save,
  );
  tool(
    "workflow_list_saved",
    "列出全局与已打开项目的保存工作流。",
    {},
    async () => ({ groups: await registry.list() }),
  );
  tool(
    "workflow_get_saved",
    "读取已保存工作流及完整源码。",
    { name: str("名称"), groupId: str("分组") },
    (a) => registry.resolveEntry(a.name, a.groupId),
  );
  tool(
    "workflow_delete_saved",
    "删除指定保存工作流，保留运行历史。",
    { name: str("名称"), groupId: str("分组") },
    operations["delete-saved"],
  );
  for (const [toolName, method, desc] of [
    [
      "workflow_get_run",
      "getRun",
      "读取运行详情、阶段与子代理、报告、产物和统计。",
    ],
    ["workflow_status", "status", "查询运行状态。"],
    [
      "workflow_asks",
      "listPendingAsks",
      "查看子代理待提交任务；主代理无需代答。",
    ],
    ["workflow_holes", "openHoles", "查看待补全的脚本留白。"],
  ])
    tool(toolName, desc, { runId: str("运行 ID") }, async (a) => {
      const result = await engine[method](validateRunId(a.runId));
      return Array.isArray(result) ? { items: result } : result;
    });
  tool("workflow_runs", "列出运行历史。", {}, async () => ({
    runs: await engine.listRuns(),
  }));
  tool(
    "workflow_stop",
    "停止工作流与其正在工作的子代理。",
    { runId: str("运行 ID") },
    operations.stop,
  );
  tool(
    "workflow_resume",
    "恢复已停止工作流，重放已经完成的节点，保留原始参数。",
    { runId: str("运行 ID") },
    operations.resume,
  );
  tool(
    "workflow_submit_ask",
    "工作流子代理提交真实任务结果。value 匹配指令中的 JSON schema；校验失败可修正重试。",
    {
      runId: { ...str("运行 ID"), required: true },
      instance: { ...str("ask 实例 ID"), required: true },
      value: {
        type: "json",
        required: true,
        description: "实际任务结果，必须匹配该 ask 的 JSON schema。",
      },
    },
    async (a, exec) => {
      const owner = engine.pendingOwner(a.runId, a.instance);
      if (owner && owner !== exec?.agent?.id)
        throw new Error("只能由该任务的子代理提交结果");
      const result = await engine.validateSubmission(
        validateRunId(a.runId),
        a.instance,
        a.value,
      );
      submissions.stage(exec, { ...a, accepted: result.ok });
      if (result.ok) exec?.concludeTurn?.();
      return result;
    },
  );
  tool(
    "workflow_fill_hole",
    "补全运行中的脚本留白。",
    { runId: str("运行 ID"), siteId: str("hole 站点"), code: str("补全代码") },
    operations["fill-hole"],
  );
  tool(
    "workflow_amend",
    "修订工作流并以新运行 ID 继续。",
    {
      runId: str("运行 ID"),
      code: str("完整修订脚本"),
      notes: str("修订说明"),
    },
    (a) => engine.amendRun(validateRunId(a.runId), a),
  );
  tool(
    "workflow_graphs",
    "获取运行的依赖/因果/控制流/阶段图。",
    { runId: str("运行 ID") },
    async (a) =>
      engine.analyzeScript(
        await fs.readFile(
          join(root, "runs", validateRunId(a.runId), "script.dwf.ts"),
          "utf8",
        ),
      ),
  );
  ctx.inject(["webServer"], (host) =>
    host.webServer.register({
      kind: "prefix",
      path: PREFIX,
      async handler(req, res) {
        const json = (status, value) => {
          if (!res.writableEnded) {
            res.writeHead(status, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify(value));
          }
        };
        try {
          if (
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket?.remoteAddress,
            )
          )
            return json(403, { error: "仅允许本地连接" });
          if (
            req.headers.origin &&
            new URL(req.headers.origin).host !== req.headers.host
          )
            return json(403, { error: "请求来源不匹配" });
          const url = new URL(req.url, "http://localhost"),
            route = url.pathname.slice(PREFIX.length);
          const q = Object.fromEntries(url.searchParams);
          if (route === "/events" && req.method === "GET") {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            res.write('data: {"type":"hello"}\n\n');
            streams.add(res);
            const ping = setInterval(() => res.write(": heartbeat\n\n"), 20000);
            req.on("close", () => {
              streams.delete(res);
              clearInterval(ping);
            });
            return;
          }
          if (req.method === "GET") {
            if (route === "/models") {
              const llm = ctx.get("llm");
              const providers = llm?.listProviders() ?? [];
              const results = await Promise.allSettled(
                providers.map((p) => llm.listModels(p.id)),
              );
              return json(200, {
                models: results.flatMap((r) =>
                  r.status === "fulfilled" ? r.value : [],
                ),
                errors: results
                  .filter((r) => r.status === "rejected")
                  .map((r) => r.reason.message),
              });
            }
            if (route === "/hub")
              return json(200, {
                groups: await registry.list(),
                runs: await engine.listRuns(),
                settings: await settings(),
              });
            if (route === "/saved")
              return json(
                200,
                q.name
                  ? { entry: await registry.resolveEntry(q.name, q.groupId) }
                  : { groups: await registry.list() },
              );
            if (route === "/runs")
              return json(200, { runs: await engine.listRuns() });
            if (route === "/run")
              return json(200, {
                run: await engine.getRun(validateRunId(q.runId)),
                holes: await engine.openHoles(q.runId),
              });
            if (route === "/artifact")
              return json(200, {
                artifact: await engine.readArtifact(
                  validateRunId(q.runId),
                  q.id,
                ),
              });
          }
          if (route === "/action" && req.method === "POST") {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) throw new Error("请求超过 2MB");
              chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const fn = operations[body.action];
            if (!fn) throw new Error("未知操作");
            const result = await fn(body);
            if (result?.ok === false)
              throw new Error(result.violation ?? result.reason ?? "操作失败");
            notify();
            return json(200, { ok: true, result });
          }
          json(404, { error: "接口不存在" });
        } catch (e) {
          json(400, { error: e.message });
        }
      },
    }),
  );
  ctx.effect(() => () => {
    clearTimeout(changeTimer);
    submissions.clear();
    completionMessages.clear();
    engine.stopAll();
    for (const res of streams) res.end();
    streams.clear();
  });
}
