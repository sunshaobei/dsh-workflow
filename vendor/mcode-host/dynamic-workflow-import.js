// Ported unchanged logic from MCode bootstrap/src/app/dynamic-workflow-import.ts. Only runtime import paths adapted.
const TERMINAL_RUN_STATUSES = new Set(["completed", "errored", "stopped"]);
const IMPORTED_NODE_KINDS = ["ask", "world-read", "world-run"];
export function preflightAmendImport(journal, predecessorRunId) {
    const run = journal.getRun(predecessorRunId);
    if (run === undefined)
        return { ok: false, reason: "run_not_found" };
    const asks = journal.listNodes(predecessorRunId, { kinds: ["ask"], withResult: false });
    if (!completedAsksHaveBoundaries(asks)) {
        return { ok: false, reason: "missing_boundaries" };
    }
    return { ok: true, run };
}
function completedAsksHaveBoundaries(nodes) {
    for (const node of nodes) {
        if (node.kind !== "ask" || node.status !== "completed")
            continue;
        if (node.messageBoundary === undefined)
            return false;
    }
    return true;
}
export async function buildImportedCache(deps, predecessorRunId, options) {
    const { actorTranscriptStore: transcripts, journal, logger } = deps;
    const run = journal.getRun(predecessorRunId);
    if (run === undefined)
        return { ok: false, reason: "run_not_found" };
    if (!TERMINAL_RUN_STATUSES.has(run.status))
        return { ok: false, reason: "not_amendable" };
    const nodes = journal.listNodes(predecessorRunId, {
        kinds: IMPORTED_NODE_KINDS,
        withResult: true,
    });
    if (!completedAsksHaveBoundaries(nodes))
        return { ok: false, reason: "missing_boundaries" };
    const asksByActor = groupAsksByActor(nodes);
    const actors = new Map();
    const records = journal.listActors(predecessorRunId, { withPersona: true });
    for (const record of namedUniqueActors(records, logger)) {
        const name = record.name;
        const candidate = await buildActorCandidate({
            actor: record,
            journal,
            ...(logger === undefined ? {} : { logger }),
            asks: asksByActor.get(actorKey(record.siteId, record.ordinal)) ?? [],
            predecessorRunId,
            ...(options?.quietSessions === undefined ? {} : { quietSessions: options.quietSessions }),
            ...(transcripts === undefined ? {} : { transcripts }),
        });
        if (candidate !== undefined)
            actors.set(name, candidate);
    }
    return {
        ok: true,
        cache: { actors, world: buildWorldQueues(nodes) },
        resumedFrom: predecessorRunId,
    };
}
function namedUniqueActors(records, logger) {
    const byName = new Map();
    for (const record of records) {
        const name = record.name;
        if (name === undefined || name === "")
            continue;
        const bucket = byName.get(name);
        if (bucket === undefined)
            byName.set(name, [record]);
        else
            bucket.push(record);
    }
    const unique = [];
    for (const [name, bucket] of byName) {
        if (bucket.length === 1) {
            unique.push(bucket[0]);
            continue;
        }
        logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
            actorName: name,
            count: bucket.length,
            event: "dynamic_workflow.amend.duplicate_actor_name",
            module: "bootstrap.app",
        });
    }
    return unique;
}
async function buildActorCandidate(input) {
    const { actor, asks, journal, logger, predecessorRunId, quietSessions, transcripts } = input;
    const name = actor.name;
    if (actor.persona === undefined)
        return undefined;
    const { entries, next } = completedAskPrefix(asks);
    if (entries.length === 0 && next?.status !== "running")
        return undefined;
    const source = resolveTranscriptSource({
        actorName: name,
        journal,
        startRunId: predecessorRunId,
    });
    if (source === undefined) {
        logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
            actorName: name,
            event: "dynamic_workflow.amend.transcript_source_missing",
            module: "bootstrap.app",
            runId: predecessorRunId,
        });
        return undefined;
    }
    const boundary = entries.length === 0 ? 0 : entries[entries.length - 1].messageBoundary;
    const messageCount = transcripts === undefined ? undefined : await countSource(transcripts, source.sessionId);
    if (transcripts !== undefined && (messageCount === undefined || messageCount < boundary)) {
        logger?.warn?.("Dynamic workflow amend: transcript source shorter than boundary, import dropped", {
            actorName: name,
            event: "dynamic_workflow.amend.transcript_source_short",
            messageBoundary: boundary,
            module: "bootstrap.app",
            sessionId: source.sessionId,
        });
        return undefined;
    }
    const inFlight = resolveInFlightAsk({
        actor,
        boundary,
        ...(logger === undefined ? {} : { logger }),
        ...(messageCount === undefined ? {} : { messageCount }),
        ...(next === undefined ? {} : { next }),
        predecessorRunId,
        ...(quietSessions === undefined ? {} : { quietSessions }),
        sourceSessionId: source.sessionId,
    });
    if (entries.length === 0 && inFlight === undefined)
        return undefined;
    return {
        persona: actor.persona,
        entries,
        ...(inFlight === undefined ? {} : { inFlight }),
        transcriptSourceSessionId: source.sessionId,
        ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
    };
}
function resolveInFlightAsk(input) {
    const { actor, boundary, logger, messageCount, next, quietSessions, sourceSessionId } = input;
    if (next === undefined || next.status !== "running")
        return undefined;
    const drop = (reason) => {
        logger?.info?.("Dynamic workflow amend: in-flight ask not carried", {
            actorName: actor.name,
            event: "dynamic_workflow.amend.in_flight_dropped",
            module: "bootstrap.app",
            reason,
            runId: input.predecessorRunId,
            sessionId: sourceSessionId,
        });
        return undefined;
    };
    if (actor.sessionId === undefined || actor.sessionId !== sourceSessionId) {
        return drop("transcript_source_is_ancestor");
    }
    if (messageCount === undefined)
        return drop("no_transcript_count");
    if (quietSessions !== undefined && !quietSessions.has(sourceSessionId)) {
        return drop("session_not_quiescent");
    }
    if (messageCount <= boundary)
        return drop("no_transcript_beyond_prefix");
    return { inputHash: next.inputHash, messageBoundary: messageCount };
}
function completedAskPrefix(asks) {
    const bySeq = new Map();
    for (const node of asks) {
        if (node.actorSeq === undefined)
            continue;
        bySeq.set(node.actorSeq, node);
    }
    const entries = [];
    for (let seq = 0;; seq++) {
        const node = bySeq.get(seq);
        if (node === undefined || node.status !== "completed") {
            return { entries, ...(node === undefined ? {} : { next: node }) };
        }
        const entry = {
            inputHash: node.inputHash,
            result: node.result,
            messageBoundary: node.messageBoundary,
        };
        if (node.stats !== undefined)
            entry.stats = node.stats;
        entries.push(entry);
    }
}
function resolveTranscriptSource(input) {
    const { actorName, journal, startRunId } = input;
    const seen = new Set();
    let runId = startRunId;
    while (runId !== undefined && !seen.has(runId)) {
        seen.add(runId);
        const matches = journal.listActors(runId, { name: actorName, withPersona: false });
        if (matches.length !== 1)
            return undefined;
        const actor = matches[0];
        if (actor.sessionId !== undefined) {
            return {
                sessionId: actor.sessionId,
                ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
            };
        }
        runId = journal.getRun(runId)?.resumedFrom;
    }
    return undefined;
}
async function countSource(transcripts, sessionId) {
    try {
        return (await transcripts.messages({ sessionID: sessionId })).length;
    }
    catch {
        return undefined;
    }
}
function actorKey(siteId, ordinal) {
    return `${siteId}@${ordinal}`;
}
function groupAsksByActor(nodes) {
    const groups = new Map();
    for (const node of nodes) {
        if (node.kind !== "ask" || node.actorSiteId === undefined || node.actorOrdinal === undefined) {
            continue;
        }
        const key = actorKey(node.actorSiteId, node.actorOrdinal);
        const group = groups.get(key);
        if (group === undefined)
            groups.set(key, [node]);
        else
            group.push(node);
    }
    return groups;
}
function buildWorldQueues(nodes) {
    const world = new Map();
    for (const node of nodes) {
        if (node.kind !== "world-read" && node.kind !== "world-run")
            continue;
        if (node.status !== "completed")
            continue;
        const queue = world.get(node.inputHash);
        const entry = {
            inputHash: node.inputHash,
            kind: node.kind,
            result: node.result,
        };
        if (queue === undefined)
            world.set(node.inputHash, [entry]);
        else
            queue.push(entry);
    }
    return world;
}
export async function rebuildImportedCacheForResume(deps, run) {
    const { predecessorRunId, runId } = run;
    const built = await buildImportedCache(deps, predecessorRunId);
    if (built.ok)
        return built.cache;
    deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
        event: "dynamic_workflow.amend.rebuild_skipped",
        module: "bootstrap.app",
        reason: built.reason,
        resumedFrom: predecessorRunId,
        runId,
    });
    return undefined;
}
