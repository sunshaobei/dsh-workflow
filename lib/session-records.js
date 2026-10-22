/** Plugin-owned UI anchors must remain replayable even without this plugin. */
export const WORKFLOW_RUN_RECORD = "plugin:dsh-workflow/run";

export function workflowSessionTitle(name, time = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const stamp = ["year", "month", "day", "hour", "minute", "second"].map((key) => values[key]).join("");
  const label = typeof name === "string" && name.trim() ? name.trim() : "工作流";
  return `${label}-${stamp}`;
}

export function workflowRunId(event) {
  if (event?.type !== WORKFLOW_RUN_RECORD && event?.type !== "dsh-workflow/run") return undefined;
  return typeof event.data?.runId === "string" && event.data.runId.length > 0
    ? event.data.runId : undefined;
}

/** Offline repair: retain every sequence/data payload; only repair our own record envelope. */
export function repairWorkflowSessionEvents(events, now = Date.now()) {
  let changed = false;
  const repaired = events.map((event) => {
    if (!workflowRunId(event)) return event;
    if (event.type === WORKFLOW_RUN_RECORD && event.ignorable === true) return event;
    changed = true;
    return { ...event, type: WORKFLOW_RUN_RECORD, ignorable: true };
  });
  const firstRun = repaired.find((event) => workflowRunId(event));
  if (firstRun && !repaired.some((event) => event.type === "session/title")) {
    repaired.push({
      type: "session/title", seq: repaired.length, time: now,
      data: { title: workflowSessionTitle(undefined, firstRun.time), messageSeqs: [], source: { kind: "user" } },
    });
    changed = true;
  }
  return { changed, events: repaired };
}

/** Resolve the host's module, not a bundled Session copy with different private fields. */
export async function prepareWorkflowSession(ctx, session) {
  const loader = ctx.get("loader");
  const titles = ctx.get("sessionTitle");
  if (!loader || !titles) throw new Error("工作流会话需要宿主 loader 和 sessionTitle 服务");
  const { appendPluginRecord } = await loader.import("@deepseek-ai/dsh-session");
  if (typeof appendPluginRecord !== "function") throw new Error("宿主不支持可重放的插件会话记录");
  return (runId, startedAt, runName) => {
    appendPluginRecord(session, WORKFLOW_RUN_RECORD, { runId });
    // Only name an untitled workflow session; preserve an existing user title.
    if (!titles.get(session)?.title) titles.rename(session, workflowSessionTitle(runName, startedAt));
  };
}
