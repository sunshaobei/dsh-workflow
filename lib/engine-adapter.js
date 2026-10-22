// dsh-workflow engine adapter.
//
// Executes the MCode engine with native DSH child sessions and durable journals.

import {
  buildImportedCache,
  preflightAmendImport,
} from "../vendor/mcode-host/dynamic-workflow-import.js";
import { runWorkflowScript } from "../vendor/dynamic-workflow-runtime/index.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARTIFACT_CAPS } from "../vendor/dynamic-workflow/index.js";
import { createWorldDriver } from "./world-driver.js";
import { projectRun } from "./projection.js";
import { collectSessionStats } from "./host-driver.js";
import { randomUUID } from "node:crypto";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const VENDOR_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, "vendor", "dynamic-workflow", "index.js"),
).href;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default workflows dir; overridable via configure({ dir }). */
export let WORKFLOWS_DIR = path.join(homedir(), ".dsh", "workflows");

const config = {
  onChange: () => {},
  driverFactory: undefined,
  /** Path to a typescript installation, used only when bare `import "typescript"` fails. */
  typescriptPath: undefined,
  /** Default max concurrency for new runs. */
  maxConcurrency: 4,
};

/** configure({ dir?, typescriptPath?, maxConcurrency? }) */
export function configure(opts = {}) {
  if (opts.transcripts) config.transcripts = opts.transcripts;
  if (opts.onSettled) config.onSettled = opts.onSettled;
  if (opts.onChange) config.onChange = opts.onChange;
  if (opts.driverFactory) config.driverFactory = opts.driverFactory;
  if (opts.dir !== undefined) WORKFLOWS_DIR = path.resolve(opts.dir);
  if (opts.typescriptPath !== undefined)
    config.typescriptPath = path.resolve(opts.typescriptPath);
  if (opts.maxConcurrency !== undefined)
    config.maxConcurrency = Math.max(1, Math.floor(opts.maxConcurrency));
}

function runsRoot() {
  return path.join(WORKFLOWS_DIR, "runs");
}

// ---------------------------------------------------------------------------
// Lazy vendor + typescript loading
// ---------------------------------------------------------------------------

async function ensureTypescript() {
  try {
    await import("typescript");
    return;
  } catch {
    /* fall through */
  }
  const target = config.typescriptPath;
  if (!target)
    throw new Error(
      "缺少 TypeScript 依赖，请在 dsh-workflow 中运行 npm install",
    );
  const link = path.join(PLUGIN_ROOT, "node_modules", "typescript");
  if (!existsSync(link)) {
    if (!existsSync(target)) {
      throw new Error(
        `dsh-workflow: typescript is required by vendor/dynamic-workflow but is not resolvable. ` +
          `Either add typescript@^5 to the plugin's package.json, or call configure({ typescriptPath: "<dir with typescript/package.json>" }). ` +
          `(Tried bare import and path: ${target})`,
      );
    }
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
  await import("typescript");
}

let vendorPromise = undefined;
/** Set once vendor() resolves; used to mint engine-shaped errors. */
let WorkflowErrorCtor = undefined;

async function vendor() {
  if (!vendorPromise) {
    vendorPromise = (async () => {
      await ensureTypescript();
      const mod = await import(VENDOR_URL);
      WorkflowErrorCtor = mod.WorkflowError;
      return mod;
    })();
  }
  return vendorPromise;
}

// ---------------------------------------------------------------------------
// Journal: JournalStorePort as flat files under runs/<runId>/
//   script.dwf.ts   — the author's script text (written once at createRun)
//   journal.jsonl   — append-only log of run/actor/node record writes
//   events.jsonl    — append-only event log with per-run sequences
//   state.json      — checkpoint (run row snapshot + pending asks + live flags)
// Loading = replaying journal.jsonl + events.jsonl into the in-memory maps,
// which is exactly the engine's documented resume-by-replay substrate.
// ---------------------------------------------------------------------------

class FileJournalStore {
  constructor(dir, runId, scriptText) {
    this.dir = dir;
    this.runId = runId;
    this.runs = new Map(); // runId -> RunRecord (mutable copy)
    this.actors = new Map(); // `${siteId}#${ordinal}` -> ActorRecord
    this.nodes = new Map(); // `${siteId}#${ordinal}` -> NodeRecord
    this.events = []; // StoredEvent[]
    if (scriptText !== undefined) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "script.dwf.ts"), scriptText, "utf8");
    }
    this.load();
  }

  load() {
    const jl = path.join(this.dir, "journal.jsonl");
    if (existsSync(jl)) {
      for (const line of readFileSync(jl, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const { op, record } = JSON.parse(line);
        if (op === "createRun") this.runs.set(record.runId, record);
        else if (op === "putActor")
          this.actors.set(actorKey(record), { ...record });
        else if (op === "putNode")
          this.nodes.set(nodeKey(record), { ...record });
        else if (op === "run")
          this.runs.set(record.runId, {
            ...this.runs.get(record.runId),
            ...record,
          });
      }
    }
    const el = path.join(this.dir, "events.jsonl");
    if (existsSync(el)) {
      for (const line of readFileSync(el, "utf8").split("\n")) {
        if (line.trim()) this.events.push(JSON.parse(line));
      }
    }
  }

  appendJournal(op, record) {
    appendFileSync(
      path.join(this.dir, "journal.jsonl"),
      JSON.stringify({ op, record }) + "\n",
    );
  }

  persistState(extra = {}) {
    try {
      const run = this.runs.get(this.runId);
      writeFileSync(
        path.join(this.dir, "state.json"),
        JSON.stringify(
          {
            runId: this.runId,
            run,
            ...extra,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      /* best-effort checkpoint */
    }
  }

  persistRecoveredUsage() {
    let extra = {};
    try {
      const { runId, run, updatedAt, ...previous } = JSON.parse(
        readFileSync(path.join(this.dir, "state.json"), "utf8"),
      );
      extra = previous;
    } catch {
      /* no prior checkpoint */
    }
    this.persistState(extra);
  }

  // --- JournalStorePort ---
  createRun(record) {
    if (this.runs.has(record.runId)) {
      throw new Error(`duplicate run: ${record.runId}`);
    }
    this.runs.set(record.runId, { ...record });
    this.appendJournal("createRun", record);
  }
  getRun(runId) {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : { ...run };
  }
  updateRunStatus(runId, status, settlement) {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, status };
    if (status === "running") {
      // non-terminal flip clears the settlement fields
      delete next.result;
      delete next.failure;
      delete next.stopReason;
      delete next.supersededBy;
    } else if (status === "completed") {
      if (settlement?.result !== undefined) next.result = settlement.result;
      delete next.failure;
      delete next.stopReason;
      delete next.supersededBy;
    } else if (status === "errored") {
      if (settlement?.failure !== undefined) next.failure = settlement.failure;
      delete next.result;
      delete next.stopReason;
      delete next.supersededBy;
    } else if (status === "stopped") {
      next.stopReason = settlement?.stopReason ?? "user";
      if (settlement?.supersededBy !== undefined)
        next.supersededBy = settlement.supersededBy;
      if (settlement?.failure !== undefined) next.failure = settlement.failure;
      delete next.result;
    }
    this.runs.set(runId, next);
    this.appendJournal("run", next);
  }
  updateRunUsage(runId, spentTokens) {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, spentTokens };
    this.runs.set(runId, next);
    this.appendJournal("run", next);
  }
  updateRunCaps(runId, caps) {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, caps: { ...caps } };
    this.runs.set(runId, next);
    this.appendJournal("run", next);
  }
  updateRunScript(runId, scriptText, scriptHash) {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, scriptText, scriptHash };
    this.runs.set(runId, next);
    this.appendJournal("run", next);
    writeFileSync(path.join(this.dir, "script.dwf.ts"), scriptText, "utf8");
  }
  putActor(record) {
    const key = actorKey(record);
    const existing = this.actors.get(key);
    // carry driver-owned fields forward on a re-put (same contract as production)
    const merged = { ...(existing ?? {}), ...record };
    if (record.sessionId === undefined && existing?.sessionId !== undefined)
      merged.sessionId = existing.sessionId;
    if (existing?.resolvedModel !== undefined)
      merged.resolvedModel = existing.resolvedModel;
    this.actors.set(key, merged);
    this.appendJournal("putActor", merged);
  }
  getActor(runId, siteId, ordinal) {
    const a = this.actors.get(`${siteId}#${ordinal}`);
    return a && a.runId === runId ? { ...a } : undefined;
  }
  listActors(runId, opts) {
    return [...this.actors.values()]
      .filter((a) => a.runId === runId)
      .filter((a) => opts.name === undefined || a.name === opts.name)
      .map((a) =>
        opts.withPersona ? { ...a } : (({ persona, ...rest }) => rest)(a),
      );
  }
  putNode(record) {
    const key = nodeKey(record);
    const existing = this.nodes.get(key);
    const merged = { ...(existing ?? {}), ...record };
    this.nodes.set(key, merged);
    this.appendJournal("putNode", merged);
  }
  getNode(runId, siteId, ordinal, opts) {
    const n = this.nodes.get(`${siteId}#${ordinal}`);
    if (!n || n.runId !== runId) return undefined;
    return opts?.withResult === false
      ? (({ result, ...rest }) => rest)(n)
      : { ...n };
  }
  listNodes(runId, opts) {
    const kinds = opts.kinds === "all" ? null : new Set(opts.kinds);
    const rows = [...this.nodes.values()]
      .filter((n) => n.runId === runId)
      .filter((n) => kinds === null || kinds.has(n.kind))
      .map((n) =>
        opts.withResult ? { ...n } : (({ result, ...rest }) => rest)(n),
      );
    if (opts.limit !== undefined) return rows.slice(0, opts.limit);
    return rows;
  }
  countNodes(runId, kind) {
    let c = 0;
    for (const n of this.nodes.values())
      if (n.runId === runId && n.kind === kind) c++;
    return c;
  }
  sumResultBytes(runId, kind) {
    let s = 0;
    for (const n of this.nodes.values()) {
      if (n.runId === runId && n.kind === kind && n.result !== undefined) {
        s += Buffer.byteLength(JSON.stringify(n.result) ?? "", "utf8");
      }
    }
    return s;
  }
  appendEvent(runId, event) {
    const sequence =
      this.events.length === 0
        ? 0
        : this.events[this.events.length - 1].sequence + 1;
    const stored = { sequence, event, timeCreated: Date.now() };
    this.events.push(stored);
    appendFileSync(
      path.join(this.dir, "events.jsonl"),
      JSON.stringify(stored) + "\n",
    );
    config.onChange({ runId, event });
    return { sequence, event };
  }
  listEvents(runId, opts) {
    const types = opts.types === "all" ? null : new Set(opts.types);
    const after = opts.afterSequence ?? -1;
    const limit =
      opts.limit === undefined || opts.limit === -1 ? Infinity : opts.limit;
    let reportSeen = 0;
    const reportLimit =
      opts.reportItems === "all" ? Infinity : opts.reportItems.limit;
    const out = [];
    for (const stored of this.events) {
      if (stored.sequence <= after) continue;
      if (types !== null && !types.has(stored.event.type)) continue;
      if (out.length >= limit) break;
      let e = stored.event;
      if (e.type === "report") {
        if (reportSeen >= reportLimit) e = { ...e, item: undefined };
        reportSeen++;
      }
      out.push({ ...stored, event: e });
    }
    return out;
  }
}

function actorKey(r) {
  return `${r.siteId}#${r.ordinal}`;
}
function nodeKey(r) {
  return `${r.siteId}#${r.ordinal}`;
}

// ---------------------------------------------------------------------------
// LocalDriver (Boundary B) — agent-driven, no LLM in-process.
// startAsk records the pending ask and returns WITHOUT blocking; the ask promise
// inside the engine stays pending until submitAsk() feeds the sink.
// ---------------------------------------------------------------------------

class LocalDriver {
  constructor(runId, journal, workspaceRoot, hooks) {
    this.runId = runId;
    this.journal = journal;
    this.workspaceRoot = workspaceRoot;
    this.hooks = hooks; // { onPendingChange }
    this.pending = new Map(); // instanceKey -> { instance, key, instructions, typed, schema, actorRef, actorName, sessionId }
    this.actorsBySession = new Map(); // sessionId -> { actor, persona }
    this.submitWaiters = new Map(); // instanceKey -> deferred verdict
    this.disposed = false;
    this.runtime = hooks.runtime;
    this.world = createWorldDriver(workspaceRoot);
  }

  async createActorSession(actor, persona, seed) {
    if (!seed && this.runtime) {
      const previousActor = this.journal.getActor(
        this.runId,
        actor.siteId,
        actor.ordinal,
      );
      const previous = previousActor?.sessionId;
      const events = previous && config.transcripts?.read(previous);
      if (events?.length)
        seed = {
          sourceSessionId: previous,
          messageCount: events.length,
          resolvedModel: previousActor.resolvedModel,
        };
    }
    const sessionId = this.runtime
      ? await this.runtime.createActor(
          actor,
          persona,
          seed,
          (resolvedModel) => {
            const record = this.journal.getActor(
              this.runId,
              actor.siteId,
              actor.ordinal,
            );
            if (record) {
              this.journal.actors.set(actorKey(record), {
                ...record,
                resolvedModel,
              });
              this.journal.appendJournal("putActor", {
                ...record,
                resolvedModel,
              });
            }
          },
        )
      : `dwf-${randomUUID()}`;
    this.actorsBySession.set(sessionId, { actor, persona });
    return { id: sessionId };
  }

  startAsk(session, instance, message) {
    const key = ref(instance);
    const info = this.actorsBySession.get(session.id);
    this.pending.set(key, {
      key,
      instance: { ...instance },
      sessionId: session.id,
      actor: info?.actor ? { ...info.actor } : undefined,
      actorName:
        (info?.persona?.name ?? info?.persona?.name === "")
          ? info?.persona?.name
          : info?.persona?.name || undefined,
      instructions: message.instructions,
      typed: message.typed,
      schema: message.schema ?? null,
    });
    this.journal.persistState({ pendingAsks: [...this.pending.keys()] });
    this.hooks.onPendingChange?.();
    if (this.runtime)
      void this.runtime.ask(
        { ...this.pending.get(key), instance: key },
        (error) => {
          const run = live.get(this.runId);
          if (run && this.pending.has(key))
            run.engine.askFailed(
              instance,
              new WorkflowErrorCtor("DriverError", error.message),
            );
        },
        {
          mutating: () => live.get(this.runId)?.engine.askMutating(instance),
          ended: async (finalText) => {
            const run = live.get(this.runId);
            if (!run || !this.pending.has(key)) return;
            await finishSubmission(
              run,
              this.pending.get(key),
              instance,
              key,
              false,
            );
            run.engine.askTurnEnded(instance, finalText);
            if (!message.typed) {
              this.pending.delete(key);
              this.journal.persistState({
                pendingAsks: [...this.pending.keys()],
              });
            }
          },
        },
      );
  }

  respondToSubmit(instance, verdict) {
    const key = ref(instance);
    if (verdict.kind === "nudge") {
      const pending = this.pending.get(key);
      if (pending) void this.runtime?.nudge?.(pending.sessionId);
    }
    const waiter = this.submitWaiters.get(key);
    if (waiter) {
      this.submitWaiters.delete(key);
      waiter(verdict);
    }
  }

  cancelAsk(instance) {
    const key = ref(instance);
    const waiter = this.submitWaiters.get(key);
    if (waiter) {
      this.submitWaiters.delete(key);
      waiter({ kind: "cancel" });
    }
    const pending = this.pending.get(key);
    if (pending) this.runtime?.cancel(pending.sessionId);
    if (this.pending.delete(key)) {
      this.journal.persistState({ pendingAsks: [...this.pending.keys()] });
      this.hooks.onPendingChange?.();
    }
  }

  async executeWorldRead(op, args) {
    return this.world.execute(op, args);
  }

  async executeArtifactPublish(request) {
    const dir = path.join(runsRoot(), this.runId, "artifacts");
    mkdirSync(dir, { recursive: true });
    const filename = `${encodeURIComponent(request.id)}-${request.version}`;
    const maxBytes =
      request.op === "markdown"
        ? ARTIFACT_CAPS.maxMarkdownBytes
        : ARTIFACT_CAPS.maxFileBytes;
    if (
      request.op === "file" &&
      statSync(resolveWithin(this.workspaceRoot, request.path)).size > maxBytes
    )
      throw new WorkflowErrorCtor("ArtifactTooLarge", "产物超过 20MB 限制");
    const content =
      request.op === "markdown"
        ? Buffer.from(request.content ?? "")
        : readFileSync(resolveWithin(this.workspaceRoot, request.path));
    if (content.length > maxBytes)
      throw new WorkflowErrorCtor("ArtifactTooLarge", "产物内容超过大小限制");
    const ext = path.extname(request.path ?? "").toLowerCase();
    const contentType =
      request.opts?.contentType ??
      (request.op === "markdown" || ext === ".md"
        ? "text/markdown"
        : ({
            ".html": "text/html",
            ".json": "application/json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".pdf": "application/pdf",
          }[ext] ?? "application/octet-stream"));
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType))
      throw new Error("contentType 必须是有效 MIME 类型");
    writeFileSync(path.join(dir, filename), content);
    return {
      id: request.id,
      kind: request.op,
      version: request.version ?? 1,
      title: request.opts?.title ?? request.id,
      description: request.opts?.description,
      contentType,
      bytes: content.length,
      uri: `dsh-workflow://${this.runId}/${filename}`,
      publishedAt: Date.now(),
    };
  }

  emit(_event) {
    /* events are already in the journal; the host reads them from there */
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.world.dispose();
    this.runtime?.dispose(
      this.journal.getRun(this.runId)?.status === "completed",
    );
  }
}

function ref(instance) {
  return `${instance.siteId}@${instance.ordinal}`;
}

export function parseInstance(instance) {
  if (typeof instance === "string") {
    const at = instance.lastIndexOf("@");
    if (at < 0)
      throw new Error(
        `bad instance "${instance}" — expected "<siteId>@<ordinal>"`,
      );
    return {
      siteId: instance.slice(0, at),
      ordinal: Number(instance.slice(at + 1)),
    };
  }
  if (
    instance &&
    typeof instance === "object" &&
    typeof instance.siteId === "string"
  ) {
    return { siteId: instance.siteId, ordinal: Number(instance.ordinal) };
  }
  throw new Error(`bad instance ${JSON.stringify(instance)}`);
}

// ---------------------------------------------------------------------------
// World operations use the upstream MCode ports over native files and processes.
// Run registry
// ---------------------------------------------------------------------------

const live = new Map(); // runId -> { runId, engine, driver, journal, scriptText, askSpecs, sitePhases, phaseNames, holeBodies, lowered, settlement? }

async function compileProduct(code) {
  const v = await vendor();
  const analysis = v.analyzeWorkflowScript(code);
  if (!analysis.ok) {
    const err = new Error(
      `workflow script failed analysis:\n${analysis.diagnostics.map((d) => `${d.line}:${d.column} ${d.code} ${d.message}`).join("\n")}`,
    );
    err.diagnostics = analysis.diagnostics;
    throw err;
  }
  const loweredResult = v.lowerWorkflowScript(code);
  if (!loweredResult.ok || !loweredResult.lowered) {
    throw new Error("workflow script could not be lowered");
  }
  const program = v.createWorkflowProgram(code);
  const table = v.collectSites(program);
  const schemas = v.synthesizeAskSchemas(program, table);
  const askSpecs = v.buildAskSpecs(table, schemas.schemas);
  const sitePhases = v.collectSitePhases(analysis.core);
  const { phaseNames, holes } = v.collectPhaseNames(analysis.flow);
  return {
    v,
    analysis,
    lowered: loweredResult.lowered,
    askSpecs,
    sitePhases,
    phaseNames,
    holes,
  };
}

/**
 * createRun({ name, code, args? }) -> { runId }
 * Lowers, constructs WorkflowEngine with a LocalDriver, persists everything and
 * starts execution. Facade calls that don't need the agent (phase/log/report/
 * worldRead file ops) run through; asks block until submitAsk().
 */
export async function createRun({
  name,
  code,
  args,
  cwd,
  parentSessionId,
  toolCallId,
  groupId,
  savedName,
  maxConcurrency,
  runtime,
  createdSeq,
  resumedFrom,
  importedCache,
  inheritedTokens,
  model,
  reasoningEffort,
} = {}) {
  if (typeof code !== "string" || !code.trim())
    throw new Error("createRun: code (workflow script source) is required");
  const product = await compileProduct(code);
  const { v } = product;
  const runId = `dwfrun-${randomUUID()}`;
  const dir = path.join(runsRoot(), runId);
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const journal = new FileJournalStore(dir, runId, code);
  const driver = new LocalDriver(runId, journal, workspaceRoot, {
    runtime:
      runtime ??
      config.driverFactory?.({
        runId,
        parentSessionId,
        cwd: workspaceRoot,
        model,
        reasoningEffort,
      }),
  });
  const scriptHash = v.fnv1a(v.canonicalJson(code));
  const engineOptions = {
    runId,

    caps: { maxConcurrency: maxConcurrency ?? config.maxConcurrency },
    parentSessionId,
    toolCallId,
    resumedFrom,
    importedCache,
    inheritedTokens,
    askSpecs: product.askSpecs,
    validate: v.validate,
    sitePhases: product.sitePhases,
    scriptText: code,
    scriptHash,
    name,
    args: args ?? {},
    cwd: workspaceRoot,
  };
  const run = {
    runId,
    engineOptions,
    driver,
    journal,
    scriptText: code,
    scriptHash,
    askSpecs: product.askSpecs,
    sitePhases: product.sitePhases,
    phaseNames: product.phaseNames,
    holeBodies: product.lowered.holeBodies,
    loweredCode: product.lowered.code,
    dir,
    workspaceRoot,
    name,
    // MCode 在子进程沙箱里把实参冻结成 `__host.args` 全局（child-source.ts）；引擎本体不
    // 暴露 args。进程内执行的 host 对象必须补上同一形状，否则脚本读 `args.x` 直接 TypeError。
    args: Object.freeze(JSON.parse(JSON.stringify(args ?? {}))),
  };
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify(v.encodeAnalysisCore(product.analysis.core)),
  );
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      groupId,
      savedName,
      parentSessionId,
      toolCallId,
      createdSeq,
      cwd: workspaceRoot,
      model,
      reasoningEffort,
    }),
  );
  live.set(runId, run);
  startExecution(run);
  return { runId };
}

function startExecution(run) {
  run.settled = runWorkflowScript({
    ...run.engineOptions,
    lowered: run.loweredCode,
    args: run.args,
    cwd: run.workspaceRoot,
    makeDriver: () => run.driver,
    control: {
      bind(engine) {
        run.engine = engine;
      },
    },
  })
    .then(async (settlement) => {
      await run.driver.runtime?.closed?.();
      run.settlement = settlement;
      run.journal.persistState({
        pendingAsks: [...run.driver.pending.keys()],
        settlement,
      });
      live.delete(run.runId);
      config.onChange();
      void Promise.resolve(config.onSettled?.(run.runId)).catch(() => {});
      return settlement;
    })
    .catch((error) => {
      live.delete(run.runId);
      run.driver.dispose();
      config.onChange();
      throw error;
    });
}

/** resumeRun(runId): replay per the engine's documented resume path. */
export async function resumeRun(runId, { runtime } = {}) {
  const existing = live.get(runId);
  if (existing) return { runId, alreadyRunning: true };
  const dir = path.join(runsRoot(), runId);
  const scriptPath = path.join(dir, "script.dwf.ts");
  if (!existsSync(scriptPath))
    throw new Error(`resumeRun: no such run "${runId}" under ${runsRoot()}`);
  const code = readFileSync(scriptPath, "utf8");
  const product = await compileProduct(code);
  const { v } = product;
  const journal = new FileJournalStore(dir, runId);
  const record = journal.getRun(runId);
  if (!record)
    throw new Error(`resumeRun: journal has no run record for ${runId}`);
  if (
    record.status === "completed" ||
    record.status === "errored" ||
    record.stopReason === "superseded"
  ) {
    throw new Error(
      `resumeRun: run ${runId} is ${record.status}; only stopped runs resume (amend instead)`,
    );
  }
  const meta = existsSync(path.join(dir, "meta.json"))
    ? JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"))
    : {};
  const importedCache = record.resumedFrom
    ? (await buildImportedCache(importDeps(), record.resumedFrom)).cache
    : undefined;
  const workspaceRoot = record.cwd ?? process.cwd();
  const driver = new LocalDriver(runId, journal, workspaceRoot, {
    runtime:
      runtime ??
      config.driverFactory?.({
        runId,
        parentSessionId: record.parentSessionId,
        cwd: workspaceRoot,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
      }),
  });
  const engineOptions = {
    runId,

    caps: record.caps,
    importedCache,
    askSpecs: product.askSpecs,
    validate: v.validate,
    sitePhases: product.sitePhases,
    scriptHash: record.scriptHash ?? v.fnv1a(v.canonicalJson(code)),
  };
  const run = {
    runId,
    engineOptions,
    driver,
    journal,
    scriptText: code,
    askSpecs: product.askSpecs,
    sitePhases: product.sitePhases,
    phaseNames: product.phaseNames,
    holeBodies: product.lowered.holeBodies,
    loweredCode: product.lowered.code,
    dir,
    workspaceRoot,
    name: record.name,
    // resume 同 createRun：args 从 journal 的 run 行读回（record.args），冻结后给 host。
    args: Object.freeze(JSON.parse(JSON.stringify(record.args ?? {}))),
  };
  live.set(runId, run);
  startExecution(run);
  return { runId };
}

/** stopRun(runId, reason?): stop("user"|"model"|"interrupted"). */
export async function stopRun(runId, reason = "user") {
  const run = live.get(runId);
  if (!run) {
    const current = await status(runId);
    return {
      ok: false,
      reason: `run ${runId} is not live (status: ${current.status})`,
    };
  }
  run.engine.stop(
    reason === "model"
      ? "model"
      : reason === "interrupted"
        ? "interrupted"
        : "user",
  );
  await run.settled.catch(() => {});
  return { ok: true, runId };
}

function importDeps() {
  const journal = (id) => new FileJournalStore(path.join(runsRoot(), id), id);
  return {
    journal: {
      getRun: (id) => journal(id).getRun(id),
      listActors: (id, opts) => journal(id).listActors(id, opts),
      listNodes: (id, opts) => journal(id).listNodes(id, opts),
    },
    ...(config.transcripts
      ? {
          actorTranscriptStore: {
            messages: async ({ sessionID }) => {
              const events = config.transcripts.read(sessionID);
              if (!events) throw new Error("Missing transcript");
              return events;
            },
          },
        }
      : {}),
  };
}
export async function amendRun(runId, { code, notes } = {}) {
  const deps = importDeps();
  const check = preflightAmendImport(deps.journal, runId);
  if (!check.ok) throw new Error(`无法修订续跑：${check.reason}`);
  const record = check.run,
    dir = path.join(runsRoot(), runId);
  const newCode = code ?? readFileSync(path.join(dir, "script.dwf.ts"), "utf8");
  await compileProduct(newCode); // Reject invalid edits before stopping the predecessor.
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  const predecessor = live.get(runId);
  if (predecessor) {
    predecessor.engine.stop("superseded");
    await predecessor.settled;
  }
  const imported = await buildImportedCache(deps, runId);
  if (!imported.ok) throw new Error(`无法修订续跑：${imported.reason}`);
  const result = await createRun({
    ...meta,
    code: newCode,
    name: record.name,
    args: record.args,
    cwd: record.cwd,
    parentSessionId: record.parentSessionId,
    maxConcurrency: record.caps.maxConcurrency,
    resumedFrom: runId,
    inheritedTokens: record.spentTokens,
    importedCache: imported.cache,
  });
  if (notes)
    writeFileSync(
      path.join(runsRoot(), result.runId, "amend-notes.txt"),
      notes,
    );
  return { newRunId: result.runId };
}

/** status(runId) -> { status, ... } */
export async function status(runId) {
  const run = live.get(runId);
  if (run) return { runId, status: run.engine.status() };
  return readStatusFromDisk(runId);
}

function readStatusFromDisk(runId) {
  const dir = path.join(runsRoot(), runId);
  const jl = path.join(dir, "journal.jsonl");
  if (!existsSync(jl)) throw new Error(`status: no such run "${runId}"`);
  const j = new FileJournalStore(dir, runId);
  const record = j.getRun(runId);
  return {
    runId,
    status:
      record?.status === "running" && !live.has(runId)
        ? "stopped"
        : (record?.status ?? "unknown"),
    stopReason:
      record?.status === "running" && !live.has(runId)
        ? "interrupted"
        : record?.stopReason,
    failure: record?.failure,
    spentTokens: record?.spentTokens,
  };
}

/**
 * listPendingAsks(runId) -> [{ instance, actor, actorName, instructions, schema }]
 * instance is the "<siteId>@<ordinal>" string; pass it back to submitAsk.
 */
export async function listPendingAsks(runId) {
  const run = live.get(runId);
  if (!run) return [];
  const out = [];
  for (const p of run.driver.pending.values()) {
    const spec = run.askSpecs.get(p.instance.siteId);
    const a = p.actor;
    out.push({
      instance: p.key,
      actor: a ? `${a.siteId}@${a.ordinal}` : undefined,
      actorName: run.driver.actorsBySession.get(p.sessionId)?.persona?.name,
      instructions: p.instructions,
      schema: p.typed ? p.schema : null,
    });
    void spec;
  }
  return out;
}

/**
 * submitAsk(runId, instance, value) -> { ok, violation? }
 * Validates against the ask schema (typed asks), then drives
 * engine.askSubmitAttempted + engine.askTurnEnded.
 */
export async function submitAsk(runId, instance, value) {
  const run = live.get(runId);
  if (!run) return { ok: false, violation: `run ${runId} is not live` };
  const v = await vendor();
  const inst = parseInstance(instance);
  const key = ref(inst);
  const pending = run.driver.pending.get(key);
  if (!pending)
    return { ok: false, violation: `no pending ask ${key} on run ${runId}` };
  const spec = run.askSpecs.get(inst.siteId);
  if (!spec)
    return { ok: false, violation: `no ask spec for site ${inst.siteId}` };

  if (spec.typed) {
    const { candidate, violations } = normalizeSubmission(
      v,
      spec.schema,
      value,
    );
    if (violations.length > 0) {
      run.engine.askSubmitAttempted(inst, value);
      return { ok: false, violation: v.formatViolations(violations) };
    }
    await finishSubmission(run, pending, inst, instance);
    // accepted: engine validates again (lenient decode) and settles the ask at submit
    run.engine.askSubmitAttempted(inst, candidate);
    await flush();
    run.engine.askTurnEnded(inst, "");
    await flush();
    run.driver.pending.delete(key);
    run.journal.persistState({ pendingAsks: [...run.driver.pending.keys()] });
    return { ok: true };
  }

  await finishSubmission(run, pending, inst, instance);
  // untyped ask: the result is the final text; engine ignores submit attempts
  const finalText =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  run.engine.askTurnEnded(inst, finalText);
  await flush();
  run.driver.pending.delete(key);
  run.journal.persistState({ pendingAsks: [...run.driver.pending.keys()] });
  return { ok: true };
}

async function finishSubmission(run, pending, inst, instance, accepted = true) {
  if (accepted) run.driver.runtime?.accepted(instance);
  const observed = await run.driver.runtime?.finish?.(pending.sessionId);
  if (observed?.stats) {
    run.engine.askProgress(inst, {
      turn: observed.stats.turns,
      toolCalls: observed.stats.toolCalls,
    });
    run.engine.askStats(inst, observed.stats);
  }
  if (observed?.messageBoundary !== undefined) {
    const node = run.journal.getNode(run.runId, inst.siteId, inst.ordinal);
    if (node)
      run.journal.putNode({
        ...node,
        messageBoundary: observed.messageBoundary,
      });
  }
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * fillHole(runId, siteId, code): release a branch parked at an open hole.
 * `code` is the hole body source as written by the agent; we lower it through
 * the same hole-splice machinery by handing the engine the lowered body text.
 */
export async function fillHole(runId, siteId, code) {
  const run = live.get(runId);
  if (!run) return { ok: false, reason: "not_live" };
  const v = await vendor();
  // The effective-script body for a fill must be the lowered hole body text.
  // We lower a scratch script whose hole body is the agent's code so the text
  // goes through the exact same transform as a compile-time filled hole.
  const bodyResult = v.lowerWorkflowScript(
    `await hole<unknown>("__scratch__", async () => {\n    ${code}\n  });`,
  );
  let bodyText = run.holeBodies[siteId];
  const scratchBodies = bodyResult.ok
    ? Object.values(bodyResult.lowered.holeBodies)
    : [];
  if (scratchBodies.length > 0) bodyText = scratchBodies[0];
  if (!bodyText) {
    return {
      ok: false,
      reason: "not_waiting",
      detail: `could not lower the hole body: ${(bodyResult.diagnostics ?? []).map((d) => `${d.line}:${d.column} ${d.message}`).join("; ") || "no body produced"}`,
    };
  }
  const result = run.engine.fillHole({
    siteId,
    code: bodyText,
    script: { text: run.scriptText, hash: run.scriptHash },
    askSpecs: run.askSpecs,
    sitePhases: run.sitePhases,
    phaseNames: run.phaseNames,
  });
  await flush();
  return result;
}

/** openHoles(runId) -> OpenHole[] */
export async function openHoles(runId) {
  const run = live.get(runId);
  if (!run) return [];
  return run.engine.openHoles();
}

/** listRuns() -> [{ runId, name, status, updatedAt }] */
export async function listRuns() {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    try {
      const s = readStatusFromDisk(entry);
      const journal = new FileJournalStore(dir, entry);
      const record = journal.getRun(entry);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
      } catch {}
      out.push({
        ...record,
        scriptText: undefined,
        ...meta,
        runId: entry,
        status:
          s.status === "running" && !live.has(entry) ? "stopped" : s.status,
        startedAt: journal.events[0]?.timeCreated,
        finishedAt:
          s.status === "running"
            ? undefined
            : journal.events.at(-1)?.timeCreated,
      });
    } catch {
      /* skip partial runs */
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** getRun(runId) -> { status, phases, actors, nodes, events, reports, artifacts, counts } */
export async function getRun(runId) {
  const run = live.get(runId);
  let journal;
  let engineStatus;
  let settlement;
  if (run) {
    journal = run.journal;
    engineStatus = run.engine.status();
    settlement = run.settlement;
  } else {
    const dir = path.join(runsRoot(), runId);
    if (!existsSync(path.join(dir, "journal.jsonl")))
      throw new Error(`getRun: no such run "${runId}"`);
    journal = new FileJournalStore(dir, runId);
  }
  const record = journal.getRun(runId);
  const events = journal.listEvents(runId, {
    types: "all",
    reportItems: { limit: 64 },
  });
  const actors = journal.listActors(runId, { withPersona: true });
  const nodes = journal.listNodes(runId, { kinds: "all", withResult: true });
  // Earlier DSH versions recorded child usage in transcripts but did not transfer
  // it to the run. Recover terminal runs once, from each unique child session.
  if (
    record.status !== "running" &&
    !(record.spentTokens > 0) &&
    !nodes.some((node) => node.stats?.tokens > 0) &&
    config.transcripts?.read
  ) {
    const sessionIds = new Set(actors.map((actor) => actor.sessionId).filter(Boolean));
    const recovered = [...sessionIds].reduce(
      (sum, id) => sum + (collectSessionStats(config.transcripts.read(id) ?? [])?.tokens ?? 0),
      0,
    );
    if (recovered > 0) {
      journal.updateRunUsage(runId, recovered);
      journal.persistRecoveredUsage();
      record.spentTokens = recovered;
    }
  }
  const askNodes = journal.listNodes(runId, {
    kinds: ["ask"],
    withResult: true,
  });
  const worldNodes = journal.listNodes(runId, {
    kinds: ["world-read", "world-run"],
    withResult: true,
  });
  const reportRows = journal.listNodes(runId, {
    kinds: ["report"],
    withResult: true,
  });
  const artifactRows = journal.listNodes(runId, {
    kinds: ["artifact"],
    withResult: true,
  });
  let core = {},
    meta = {};
  const dir = path.join(runsRoot(), runId);
  try {
    core = JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8"));
  } catch {
    const analysis = await analyzeScript(
      record.scriptText ??
        readFileSync(path.join(dir, "script.dwf.ts"), "utf8"),
    );
    core = analysis.coreJson ?? {};
  }
  try {
    meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {}
  const actualStatus =
    engineStatus ?? (record.status === "running" ? "stopped" : record.status);
  return {
    ...projectRun(
      {
        ...record,
        status: actualStatus,
        ...(record.status === "running" && !run
          ? { stopReason: "interrupted" }
          : {}),
      },
      nodes,
      actors,
      events,
      core,
      meta,
    ),
    asks: askNodes.map((n) => ({
      instance: ref(n),
      status: n.status,
      actor: `${n.actorSiteId}@${n.actorOrdinal}`,
      result: n.result,
      error: n.error,
    })),
    events: events.slice(-100),
    settlement,
    counts: {
      asks: askNodes.length,
      worldReads: worldNodes.length,
      reports: reportRows.length,
      artifacts: artifactRows.length,
      events: events.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers the plugin can expose directly
// ---------------------------------------------------------------------------
export async function compileScript(code) {
  const v = await vendor();
  const result = v.compileWorkflowScript(code);
  return {
    ok: result.ok,
    program: result.ok ? v.createWorkflowProgram(code) : undefined,
    diagnostics: result.diagnostics,
    dts: undefined, // the vendored compiler does not emit .d.ts for scripts
  };
}

/** analyzeScript(code) -> { ok, coreJson, mermaid: {site,causality,controlFlow,handoff,phase}, diagnostics } */
export async function analyzeScript(code) {
  const v = await vendor();
  const r = v.analyzeWorkflowScript(code);
  const mermaid = {
    site: r.graph ? v.siteGraphToMermaid(r.graph) : undefined,
    causality: r.causality ? v.causalityGraphToMermaid(r.causality) : undefined,
    controlFlow: r.flow ? v.controlFlowToMermaid(r.flow) : undefined,
    handoff: r.handoff ? v.handoffGraphToMermaid(r.handoff) : undefined,
    phase: r.flow ? v.phaseFlowToMermaid(r.flow) : undefined,
  };
  return {
    ok: r.ok,
    coreJson: r.core ? v.encodeAnalysisCore(r.core) : undefined,
    mermaid,
    diagnostics: r.diagnostics,
  };
}

export async function updateSettings(runId, settings) {
  const n = Number(settings.maxConcurrency);
  if (!Number.isInteger(n) || n < 1 || n > 64)
    throw new Error("并发上限必须是 1–64 的整数");
  const run = live.get(runId);
  if (!run) throw new Error("只能调整正在运行的工作流");
  run.engine.setMaxConcurrency(n);
  run.driver.runtime?.updateSettings({
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  });
  const file = path.join(run.dir, "meta.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({
      ...meta,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
    }),
  );
  return getRun(runId);
}
export function pendingOwner(runId, instance) {
  return live.get(runId)?.driver.pending.get(instance)?.sessionId;
}
export async function readArtifact(runId, artifactId) {
  const run = await getRun(runId);
  const item = run.artifacts.find((a) => a.id === artifactId);
  if (!item) throw new Error("产物不存在");
  if (!item.uri)
    return {
      ...item,
      items: run.reports
        .filter((r) => r.artifactId === artifactId)
        .map((r) => r.item),
    };
  const filename = item.uri.split("/").at(-1);
  if (!filename || filename.includes("..")) throw new Error("产物地址无效");
  const data = readFileSync(
    path.join(runsRoot(), runId, "artifacts", filename),
  );
  return {
    ...item,
    content: /^(text\/|application\/json)/.test(item.contentType)
      ? data.toString("utf8")
      : undefined,
    base64: data.toString("base64"),
  };
}

function resolveWithin(root, relative) {
  const file = path.resolve(root, String(relative ?? ""));
  if (file !== root && !file.startsWith(root + path.sep))
    throw new Error("文件不在工作目录内");
  const realRoot = realpathSync(root),
    realFile = realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep))
    throw new Error("产物符号链接指向工作目录之外");
  return realFile;
}

export async function validateSubmission(runId, instance, value) {
  const run = live.get(runId),
    pending = run?.driver.pending.get(instance);
  if (!pending) return { ok: false, violation: "任务已经结束或不存在" };
  const spec = run.askSpecs.get(parseInstance(instance).siteId);
  if (!spec?.typed) return { ok: true };
  const v = await vendor();
  const { violations } = normalizeSubmission(v, spec.schema, value);
  return violations.length
    ? { ok: false, violation: v.formatViolations(violations) }
    : { ok: true };
}

export function stopAll() {
  for (const run of live.values()) run.engine.stop("interrupted");
}

function normalizeSubmission(v, schema, value) {
  const direct = v.validate(schema, value);
  if (!direct.length || typeof value !== "string")
    return { candidate: value, violations: direct };
  try {
    const candidate = JSON.parse(value);
    return { candidate, violations: v.validate(schema, candidate) };
  } catch {
    return { candidate: value, violations: direct };
  }
}
