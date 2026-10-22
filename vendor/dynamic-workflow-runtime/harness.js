// MCode dynamic-workflow-runtime port; imports and workspace directory adapted for DSH.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lowerWorkflowScript, WorkflowEngine, WorkflowError, } from "../dynamic-workflow/index.js";
import { renderChildEntry } from "./child-source.js";
import { writeChildEntryFile } from "./child-entry-file.js";
const DEFAULT_MAX_OLD_SPACE_MB = 256;
const STDERR_LIMIT = 64 * 1024;
export async function runWorkflowScript(options) {
    const lowered = resolveLowered(options);
    const runId = options.runId ?? "run";
    let engine;
    const sink = {
        askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
        askTurnEnded: (instance, finalText) => engine.askTurnEnded(instance, finalText),
        askProgress: (instance, progress) => engine.askProgress(instance, progress),
        askStats: (instance, stats) => engine.askStats(instance, stats),
        askFailed: (instance, error) => engine.askFailed(instance, error),
        stopRun: (error) => engine.stopRun(error),
        askWaiting: (instance, info) => engine.askWaiting(instance, info),
        askExecuting: (instance) => engine.askExecuting(instance),
        askMutating: (instance) => engine.askMutating(instance),
        concurrencyChanged: (change) => engine.concurrencyChanged(change),
        runStalled: (info) => engine.runStalled(info),
    };
    const driver = options.makeDriver(sink);
    engine = new WorkflowEngine({
        runId,
        driver,
        caps: options.caps,
        askSpecs: options.askSpecs,
        validate: options.validate,
        ...(options.sitePhases === undefined ? {} : { sitePhases: options.sitePhases }),
        ...(options.scriptText === undefined ? {} : { scriptText: options.scriptText }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.scriptHash === undefined ? {} : { scriptHash: options.scriptHash }),
        ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
        ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
        ...(options.resumedFrom === undefined ? {} : { resumedFrom: options.resumedFrom }),
        ...(options.launch === undefined ? {} : { launch: options.launch }),
        ...(options.importedCache === undefined ? {} : { importedCache: options.importedCache }),
        ...(options.inheritedTokens === undefined ? {} : { inheritedTokens: options.inheritedTokens }),
        cwd: options.cwd ?? process.cwd(),
    });
    options.control?.bind(engine);
    const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB;
    const cwd = options.cwd ?? process.cwd();
    const payload = {
        lowered,
        ...(options.args === undefined ? {} : { args: options.args }),
        maxOldSpaceSizeMb,
    };
    let child;
    try {
        const entry = writeChildEntryFile({
            cwd,
            runId,
            source: renderChildEntry(payload, { runId }),
            ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
        });
        child = spawn(process.execPath, options.childSpawn === undefined
            ? [`--max-old-space-size=${maxOldSpaceSizeMb}`, entry.path]
            : [...options.childSpawn.argsPrefix, entry.path], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        engine.stop("interrupted", new WorkflowError("Interrupted", `Could not start the workflow sandbox process: ${message}`, {
            cause,
        }));
        return engine.settled;
    }
    return bridge({ child, engine, runId, signal: options.signal, timeoutMs: options.timeoutMs });
}
function resolveLowered(options) {
    if (options.lowered !== undefined)
        return options.lowered;
    if (options.scriptText === undefined) {
        throw new Error("runWorkflowScript: pass either scriptText or lowered");
    }
    const result = lowerWorkflowScript(options.scriptText);
    if (!result.ok || result.lowered === undefined) {
        const detail = result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
        throw new Error(`runWorkflowScript: the script failed compilation/analysis and is not run degraded: ${detail}`);
    }
    return result.lowered.code;
}
function bridge(deps) {
    const { child, engine, runId, signal, timeoutMs } = deps;
    const actorMap = new Map();
    let stderr = "";
    let finalized = false;
    let timer;
    let reader;
    return new Promise((resolve) => {
        const finalize = (settlement) => {
            if (finalized)
                return;
            finalized = true;
            if (timer !== undefined)
                clearTimeout(timer);
            if (signal !== undefined)
                signal.removeEventListener("abort", onAbort);
            reader?.close();
            if (child.exitCode === null && child.signalCode === null)
                child.kill();
            resolve(settlement);
        };
        const failRun = (error) => {
            if (finalized)
                return;
            engine.fail(error);
        };
        const interruptRun = (message, cause) => {
            if (finalized)
                return;
            engine.stop("interrupted", new WorkflowError("Interrupted", message, cause === undefined ? undefined : { cause }));
        };
        function onAbort() {
            if (finalized)
                return;
            const reason = signal?.reason;
            const supersededBy = readSupersededBy(reason);
            if (supersededBy !== undefined) {
                engine.stop("superseded", undefined, supersededBy);
                return;
            }
            if (reason === "interrupted") {
                engine.stop("interrupted", new WorkflowError("Interrupted", `dynamic workflow run ${runId} was interrupted: the owning session closed before the run settled`));
                return;
            }
            engine.stop(reason === "model" ? "model" : "user");
        }
        void engine.settled.then(finalize);
        if (signal !== undefined) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
                interruptRun(`The workflow sandbox process exceeded its wall-clock timeout of ${timeoutMs}ms`);
            }, timeoutMs);
            timer.unref?.();
        }
        child.stderr?.on("data", (chunk) => {
            stderr = trimTail(stderr + chunk.toString("utf8"), STDERR_LIMIT);
        });
        child.stdin?.on("error", () => undefined);
        reader = createInterface({ input: child.stdout });
        reader.on("line", (line) => {
            if (line.trim().length === 0)
                return;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch (cause) {
                interruptRun(`The workflow sandbox process emitted a line that is not valid NDJSON: ${line}`, cause);
                return;
            }
            handleChildMessage(message, { engine, actorMap, child, failRun });
        });
        child.on("error", (error) => {
            interruptRun(`Could not start the workflow sandbox process: ${error.message}`, error);
        });
        child.on("close", (code, sig) => {
            if (finalized)
                return;
            const reason = stderr.trim().length > 0
                ? stderr.trim()
                : `The workflow sandbox process exited (code=${code}, signal=${sig}) before completing`;
            interruptRun(reason);
        });
    });
}
function handleChildMessage(message, deps) {
    const { engine, actorMap, child, failRun } = deps;
    switch (message.kind) {
        case "create-actor": {
            try {
                const actorId = engine.createActor(message.siteId, message.name, message.persona);
                actorMap.set(message.localId, actorId);
            }
            catch (cause) {
                failRun(cause instanceof WorkflowError
                    ? cause
                    : new WorkflowError("DriverError", `createActor failed at site ${message.siteId}`, {
                        cause,
                    }));
            }
            return;
        }
        case "event":
            if (message.type === "report") {
                engine.report(message.siteId, message.item, message.artifactId);
            }
            else if (message.type === "declare-artifact") {
                engine.declareArtifact(message.siteId, message.op, message.args);
            }
            else if (message.type === "phase-entered") {
                engine.enterPhase(message.name);
            }
            else {
                engine.log(message.message);
            }
            return;
        case "complete":
            if (message.ok) {
                engine.complete(message.value);
            }
            else {
                const err = message.error;
                failRun(new WorkflowError("DriverError", err?.message ?? "The workflow script threw an error", {
                    cause: err?.stack ?? err?.name,
                }));
            }
            return;
        case "request":
            handleRequest(message, { engine, actorMap, child, failRun });
            return;
        default: {
            const _exhaustive = message;
            void _exhaustive;
        }
    }
}
function handleRequest(message, deps) {
    const { engine, actorMap, child } = deps;
    const respond = (ok, value, error) => {
        const response = {
            kind: "response",
            id: message.id,
            ok,
            ...(ok ? { value } : { error: toWireError(error) }),
        };
        const stdin = child.stdin;
        if (stdin === null || !stdin.writable)
            return;
        stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
    };
    let promise;
    if (message.type === "ask") {
        const actorId = actorMap.get(message.actor ?? "");
        if (actorId === undefined) {
            respond(false, undefined, new WorkflowError("UnknownActor", `Unknown subagent handle: ${message.actor}`));
            return;
        }
        promise = engine.ask(message.siteId, actorId, message.instructions ?? "");
    }
    else if (message.type === "publish-artifact") {
        const op = message.artifactOp;
        if (op === undefined) {
            respond(false, undefined, new WorkflowError("DriverError", `publish-artifact request is missing artifactOp (site ${message.siteId})`));
            return;
        }
        promise = engine.publishArtifact(message.siteId, op, message.args ?? []);
    }
    else if (message.type === "hole") {
        promise = engine.hole(message.siteId, message.name ?? "", message.prompt);
    }
    else {
        promise = engine.worldRead(message.siteId, message.op ?? "read", message.args ?? []);
    }
    promise.then((value) => respond(true, value), (cause) => {
        const error = cause instanceof WorkflowError
            ? cause
            : new WorkflowError("DriverError", cause instanceof Error ? cause.message : String(cause), { cause });
        respond(false, undefined, error);
    });
}
function toWireError(error) {
    if (error === undefined)
        return { name: "Error", message: "unknown error" };
    const wire = {
        name: error.name,
        message: error.message,
        code: error.code,
    };
    if (error.violations !== undefined)
        wire.violations = error.violations;
    if (error.finalText !== undefined)
        wire.finalText = error.finalText;
    return wire;
}
function trimTail(value, limit) {
    if (Buffer.byteLength(value, "utf8") <= limit)
        return value;
    return value.slice(-limit);
}
function readSupersededBy(reason) {
    if (typeof reason !== "object" || reason === null)
        return undefined;
    const value = reason.superseded;
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
