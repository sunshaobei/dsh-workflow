/** 同一运行投影供 Hub / 工具卡 / 右侧时间线 / 完成卡消费。 */
export function projectRun(
  record,
  nodes,
  actors,
  events,
  core = {},
  extras = {},
) {
  const eventValues = events.map((e) => e.event);
  const born = new Map(
    eventValues
      .filter((e) => e.instance && e.phaseName)
      .map((e) => [`${e.instance.siteId}@${e.instance.ordinal}`, e.phaseName]),
  );
  const staticPhases = core.trace?.phases ?? [];
  const phases = staticPhases.map((p) => ({ id: p.id, name: p.name }));
  for (const e of eventValues)
    if (e.type === "phase-entered" && !phases.some((p) => p.name === e.name))
      phases.push({ id: e.name, name: e.name });
  if (!phases.length && (actors.length || nodes.length))
    phases.push({ id: "unphased", name: "工作流" });
  const issued = (core.trace?.events ?? []).filter((e) => e.at === "issue");
  const staticActors = new Map(
    (core.sites?.actors ?? []).map((a) => [a.id, a]),
  );
  const relations = new Map(core.facts?.askActor ?? []);
  const phaseForSite = new Map(
    issued.map((e) => [e.step, phases.find((p) => p.id === e.phase)?.name]),
  );
  const current = eventValues
    .filter((e) => e.type === "phase-entered")
    .at(-1)?.name;
  const mappedNodes = nodes.map((n) => ({
    ...n,
    phaseName:
      born.get(`${n.siteId}@${n.ordinal}`) ??
      phaseForSite.get(n.siteId) ??
      phases[0]?.name,
  }));
  const activeRun = record.status === "running";
  const renderedPhases = phases.map((p) => {
    const work = mappedNodes.filter(
      (n) =>
        n.phaseName === p.name &&
        ["ask", "world-read", "world-run"].includes(n.kind),
    );
    const askSites = issued.filter((e) => e.phase === p.id).map((e) => e.step);
    const actorIds = new Set(
      askSites.flatMap((s) => (relations.get(s) ?? []).map((a) => a.site)),
    );
    work.forEach((n) => {
      if (n.actorSiteId) actorIds.add(n.actorSiteId);
    });
    const participants = [...actorIds].flatMap((id) => {
      const actual = actors.filter((a) => a.siteId === id);
      return (
        actual.length
          ? actual
          : [{ siteId: id, name: staticActors.get(id)?.name ?? "子代理" }]
      ).map((a) => {
        const tasks = work.filter(
          (n) =>
            n.actorSiteId === id &&
            (a.ordinal === undefined || n.actorOrdinal === a.ordinal),
        );
        const state = tasks.some((n) => n.status === "failed")
          ? "errored"
          : tasks.some((n) => n.status === "running")
            ? activeRun
              ? "running"
              : record.status
            : tasks.length
              ? "completed"
              : "pending";
        return {
          ...a,
          id: `${id}@${a.ordinal ?? 0}`,
          status: state,
          tasks: tasks.length,
          completed: tasks.filter((n) => n.status === "completed").length,
        };
      });
    });
    const entered = eventValues.filter(
      (e) => e.type === "phase-entered" && e.name === p.name,
    );
    const completed = work.filter((n) => n.status === "completed").length;
    const state = work.some((n) => n.status === "failed")
      ? "errored"
      : work.some((n) => n.status === "running")
        ? activeRun
          ? "running"
          : record.status
        : work.length
          ? "completed"
          : entered.length && record.status === "completed"
            ? "completed"
            : p.name === current && activeRun
              ? "running"
              : "pending";
    return {
      ...p,
      actors: participants,
      nodes: work,
      completed,
      total: Math.max(work.length, askSites.length),
      status: state,
      rounds: entered.length,
    };
  });
  const published = new Map();
  for (const e of eventValues)
    if (e.type === "artifact-published")
      published.set(e.artifact.id, e.artifact);
  const first = events[0]?.timeCreated;
  const terminal = events
    .filter((e) => e.event.type === "run-settled")
    .at(-1)?.timeCreated;
  return {
    ...record,
    scriptText: undefined,
    ...extras,
    phases: renderedPhases,
    actors,
    nodes: mappedNodes,
    startedAt: first,
    finishedAt:
      record.status === "running"
        ? undefined
        : (terminal ?? events.at(-1)?.timeCreated),
    activePhase: current,
    artifacts: [...published.values()].sort(
      (a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)),
    ),
    reports: nodes
      .filter((n) => n.kind === "report")
      .map((n) => ({ item: n.result, artifactId: n.artifactId })),
    activeActors: new Set(
      mappedNodes
        .filter((n) => n.kind === "ask" && n.status === "running" && activeRun)
        .map((n) => `${n.actorSiteId}@${n.actorOrdinal}`),
    ).size,
    resumable:
      record.status === "stopped" && record.stopReason !== "superseded",
    figures: {
      subagents: actors.length,
      phases: phases.length || undefined,
      tokens:
        Math.max(
          Number(record.spentTokens) || 0,
          nodes.reduce((sum, n) => sum + (Number(n.stats?.tokens) || 0), 0),
        ) || undefined,
      durationMs: first
        ? (terminal ?? events.at(-1)?.timeCreated ?? first) - first
        : undefined,
    },
  };
}
