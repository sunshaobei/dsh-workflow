import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

function tokenCount(usage) {
  const total = Number(usage?.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const input = usage?.uncachedInputTokens ?? usage?.inputTokens;
  const fields = [
    input,
    usage?.outputTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
  ];
  if (fields.every((value) => value == null)) return undefined;
  return fields.reduce((sum, value) => sum + (Number(value) || 0), 0);
}

export function collectSessionStats(events) {
  const usages = events
    .filter((event) => event.type === "assistant/message")
    .map(
      (event) =>
        event.data?.usage ??
        event.data?.stream?.filter((chunk) => chunk.type === "usage").at(-1)
          ?.usage,
    )
    .map(tokenCount)
    .filter((value) => value !== undefined);
  if (!usages.length) return undefined;
  const toolEvents = events.filter((event) => event.type === "tool/result");
  return {
    tokens: usages.reduce((sum, value) => sum + value, 0),
    toolCalls: toolEvents.length,
    turns: events.filter((event) => event.type === "turn/end").length,
    worldToolCalls: toolEvents.filter(
      (event) => event.data?.message?.call?.name !== "workflow_submit_ask",
    ).length,
  };
}

export function installWorkflowProvider(ctx, root) {
  const seeds = new Map();
  ctx.subagents.registerProvider({
    name: "dsh-workflow",
    inheritsParentContext: false,
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
    async prepareContinuable({ sessionId }) {
      const seed = seeds.get(sessionId);
      seeds.delete(sessionId);
      return seed ? { seed } : {};
    },
  });
  const file = (id) =>
    join(root, "transcripts", encodeURIComponent(id) + ".json");
  return {
    seeds,
    read(id) {
      try {
        return JSON.parse(readFileSync(file(id), "utf8"));
      } catch {
        return undefined;
      }
    },
    write(id, events) {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      const target = file(id),
        temporary = target + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(events));
      renameSync(temporary, target);
    },
  };
}
function modelOptions(value, reasoningEffort) {
  if (!value) return reasoningEffort ? { reasoningEffort } : {};
  const [route, reasoning] = value.split("$"),
    slash = route.indexOf("/");
  return {
    ...(slash > 0
      ? { provider: route.slice(0, slash), model: route.slice(slash + 1) }
      : { model: route }),
    ...(reasoning || reasoningEffort
      ? { reasoningEffort: reasoning || reasoningEffort }
      : {}),
  };
}

/** 把 MCode actor/ask 生命周期接入 DSH 原生 subagents。权限与模型继承真实父会话。 */
export function createHostDriver(ctx, parent, runId, options = {}) {
  if (!parent) throw new Error("启动工作流需要一个已打开的 dsh 会话");
  const children = new Map();
  let disposed = false,
    closing = Promise.resolve();
  const off = ctx.on("session/event", (session, event) => {
    const child = children.get(session.id);
    if (!child) return;
    if (event.type === "request/header") {
      const config = event.data.header.config;
      if (config?.provider && config?.model)
        child.onResolvedModel?.(
          `${config.provider}/${config.model}${config.reasoningEffort ? "$" + config.reasoningEffort : ""}`,
        );
    }
    if (event.type !== "turn/end") return;
    const task = child.task;
    // Result commits run before turn/end. Let their async journal writes settle.
    setTimeout(() => {
      if (
        disposed ||
        !task ||
        child.task !== task ||
        task.accepted ||
        task.ending
      )
        return;
      task.ending = true;
      const events =
        ctx.get("agents")?.get(session.id)?.session.snapshotEvents() ?? [];
      const final = events.filter((e) => e.type === "assistant/message").at(-1)
        ?.data.message;
      const text = (final?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (task.ended) Promise.resolve(task.ended(text)).catch(task.fail);
      else task.fail(new Error("子代理未提交工作流结果"));
    }, 0);
  });
  const offTools = ctx.on("tools/execute", (exec, next) => {
    const task = children.get(exec.agent?.id)?.task;
    if (
      task &&
      ![
        "workflow_submit_ask",
        "read",
        "glob",
        "grep",
        "read_image",
        "web_search",
        "web_fetch",
      ].includes(exec.name)
    )
      task.mutating?.();
    return next();
  });
  return {
    async createActor(actor, persona, seed, onResolvedModel) {
      const id = randomUUID();
      if (seed) {
        const events = options.transcripts?.read(seed.sourceSessionId);
        if (!events || events.length < seed.messageCount)
          throw new Error("无法恢复子代理转录：" + seed.sourceSessionId);
        options.transcripts.seeds.set(id, events.slice(0, seed.messageCount));
      }
      children.set(id, {
        actor,
        persona,
        pinnedModel: seed?.resolvedModel,
        onResolvedModel,
        started: false,
        observed: seed?.messageCount ?? 0,
        controller: new AbortController(),
      });
      return id;
    },
    accepted(instance) {
      for (const child of children.values())
        if (child.task?.instance === instance) child.task.accepted = true;
    },
    async ask(
      { sessionId, instance, instructions, schema },
      fail,
      observation = {},
    ) {
      const child = children.get(sessionId);
      if (disposed || !child) return;
      child.task = { instance, fail, accepted: false, ...observation };
      const prompt = [
        child.persona?.system ?? "",
        instructions,
        "\n工作流执行协议：完成此任务后必须调用 workflow_submit_ask，将实际结果提交给引擎。",
        `runId: ${runId}\ninstance: ${instance}\nvalue 必须匹配：${JSON.stringify(schema ?? "string")}`,
        "不要编造结果，不要替主代理手动推进其他子任务。提交失败时根据校验错误修正后重试。",
      ]
        .filter(Boolean)
        .join("\n\n");
      try {
        if (!child.started) {
          child.started = true;
          child.receipt = await ctx.subagents.startActivation({
            provider: options.transcripts ? "dsh-workflow" : "spawn",
            childId: sessionId,
            label: child.persona?.name || "工作流子代理",
            delivery: "caller",
            signal: child.controller.signal,
            request: {
              parent,
              prompt: [{ type: "text", text: prompt }],
              cwd: options.cwd,
              maxDepth: ctx.subagents.resolveMaxDepth(),
              agentOptions: modelOptions(
                child.pinnedModel || child.persona?.model || options.model,
                child.pinnedModel ? undefined : options.reasoningEffort,
              ),
            },
          });
          child.receipt.result
            .then((result) => {
              if (!disposed && result.stopReason !== "completed")
                fail(
                  new Error(
                    result.diagnostic || `子代理运行${result.stopReason}`,
                  ),
                );
            })
            .catch(fail);
        } else
          await ctx.subagents.sendMessage(
            parent,
            sessionId,
            [{ type: "text", text: prompt }],
            { signal: child.controller.signal },
          );
      } catch (error) {
        if (!disposed) fail(error);
      }
    },
    async nudge(sessionId) {
      const child = children.get(sessionId);
      if (disposed || !child?.task || child.task.accepted) return;
      child.task.ending = false;
      try {
        await ctx.subagents.sendMessage(
          parent,
          sessionId,
          [
            {
              type: "text",
              text: `任务尚未提交。请立即调用 workflow_submit_ask，runId=${runId}，instance=${child.task.instance}，提交符合要求的真实结果。`,
            },
          ],
          { signal: child.controller.signal },
        );
      } catch (error) {
        if (!disposed) child.task.fail(error);
      }
    },
    updateSettings(settings) {
      Object.assign(options, settings);
    },
    async finish(sessionId) {
      const agent = ctx.get("agents")?.get(sessionId);
      if (!agent) throw new Error("子代理会话已关闭，无法确认提交结果");
      await agent.whenIdle();
      const events = agent.session.snapshotEvents();
      const child = children.get(sessionId),
        delta = events.slice(child?.observed ?? 0);
      if (child) child.observed = events.length;
      const stats = collectSessionStats(delta);
      options.transcripts?.write(sessionId, events);
      return { messageBoundary: events.length, stats };
    },
    cancel(sessionId) {
      const child = children.get(sessionId);
      child?.controller.abort();
      if (child?.started)
        ctx.subagents.interrupt(sessionId, { kind: "ancestor", agent: parent });
    },
    closed() {
      return closing;
    },
    dispose(completed = false) {
      if (disposed) return;
      disposed = true;
      off?.();
      offTools?.();
      closing = Promise.all(
        [...children].map(async ([id, child]) => {
          options.transcripts?.seeds.delete(id);
          if (completed || !child.started) return;
          const agent = ctx.get?.("agents")?.get(id);
          child.controller.abort();
          ctx.subagents.interrupt(id, { kind: "ancestor", agent: parent });
          if (agent) {
            await agent.whenIdle();
            options.transcripts?.write(id, agent.session.snapshotEvents());
          }
          await child.receipt?.dispose?.();
        }),
      ).catch((error) => ctx.logger?.warn?.(error.message));
    },
  };
}
