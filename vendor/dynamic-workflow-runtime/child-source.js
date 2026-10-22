// MCode dynamic-workflow-runtime port; imports and workspace directory adapted for DSH.
import { CELL_STREAMS_BOOTSTRAP } from "./child-cell-streams.js";
export function childMain(deps) {
    const BOOTSTRAP = String.raw `
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();
// 本世已补全的留白：站点 id → 体的文本。同一站点再次到达（循环）时直接求值，不再过线。
var __fills = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // 同步造 child-local 句柄并即发即忘 create-actor；父进程据 stdio FIFO 在后续 ask 前完成映射。
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args 是 lowering 打包好的位置实参数组；本 shim 原样透传，不看 op、不校验元数（归 driver）。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __evaluateFill(evaluate, code) {
  // evaluate 是 lowering 在站点处发出的 (__src) => eval(__src)：直接 eval，闭包住作者代码在
  // 那一点的全部绑定（__host 在内），求出 (async () => { … }) 这个函数；调它，结果即留白的值。
  // 每次到达都新造一个 evaluate，循环里的留白因此看见各轮自己的绑定。求值失败（语法错）与体的
  // 拒绝都在这条 promise 上冒出，落在站点处，脚本可以 catch。
  return Promise.resolve().then(function () {
    return evaluate(code)();
  });
}

function __hole(siteId, name, prompt, evaluate, body) {
  // 已补全（体就在脚本里）：直接调体，不过线。同步抛出转成拒绝，与 future 同规。
  if (body !== undefined) {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var remembered = __fills.get(siteId);
  if (remembered !== undefined) return __evaluateFill(evaluate, remembered);
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
  }).then(function (answer) {
    __fills.set(siteId, answer.code);
    return __evaluateFill(evaluate, answer.code);
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // 阶段标记：无站点、不落 journal，只让引擎发一条事件——所以与 log 同走事件通道。
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // 内容产物是效应：脚本 await 它、要能 catch 它的拒绝，所以与 ask / world-read 同走
  // request/response。args 是 lowering 打包的位置实参（[id, path|content, opts]），原样透传。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // 预置产物是声明：同步返回 void，没有可等的东西，所以走事件通道。它与 report 共用同一条
  // FIFO——一条打了标签的 report 必须晚于它的声明到达父进程，而顺序正是由这一点保证的。
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // 即发即忘：脚本从不 await 它，所以走 event 通道而不是 request/response。父进程按 siteId ×
  // ordinal 落一行 journal，故本条消息的**到达顺序**是承重的（stdio FIFO 保证它）。
  // item 里若有环，这里的 JSON.stringify 会抛错——就在 report() 的调用点上，脚本要么 catch
  // 要么让 run 失败。两者都比静默发出一条残缺的 item 好；父进程另有同样的护栏。
  // artifactId 缺席时 JSON.stringify 直接把这个键丢掉，线上因此就是"没有标签"。
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// —— 运行实参（Boundary A 的 args）——
// 与预算一样在 context **内**用 JSON.parse 构造，所以脚本拿到的是 context-native 对象，
// 外层 realm 的 intrinsics 一点都不掺进来（本文件顶部的跨 realm 收敛约束）。
// ⚠ Object.freeze 是**浅**冻结：嵌套对象未冻结，脚本仍能改动 args.foo.bar。v1 接受这个
// 界限——它挡的是"手滑重新赋值 args"，不是一个安全边界（实参本来就是调用方给的）。
var __args = Object.freeze(JSON.parse(__argsJson));

globalThis.__host = {
  args: __args,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
  hole: __hole,
};

// —— 入站 response 消费（由外层 realm 以行字符串调用）——
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // 拒绝以 context-native Error 过界，带上 code/violations/finalText 供脚本 try/catch 结构化处理。
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

// run 是否已发出 complete。停滞检测（deps.streamsBootstrap 里的 __checkStalled）也读写它。
var __settled = false;

function __complete(ok, payload) {
  // 幂等：停滞检测已经以 error-complete 结束 run 之后，脚本（理论上）再完成也不再发第二条。
  if (__settled) return;
  __settled = true;
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// 外层 realm 调用它跑脚本；始终 resolve（错误已转成 complete 消息），便于外层收尾（关 stdin）。
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// —— 运行期禁令（belt；编译诊断是 suspenders）：Date.now / argless new Date() / Math.random ——
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;
    const payload = deps.payload;
    const sandbox = {
        __argsJson: JSON.stringify(payload.args ?? {}),
    };
    sandbox.__send = (line) => {
        deps.stdout.write(`${line}\n`);
    };
    deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
    deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });
    deps.vm.runInContext(deps.streamsBootstrap, sandbox, { filename: "workflow-streams.js" });
    let runFn;
    try {
        runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
            filename: "workflow-script.js",
        });
    }
    catch (error) {
        const err = error;
        deps.stdout.write(`${JSON.stringify({
            kind: "complete",
            ok: false,
            error: {
                name: err?.name ?? "SyntaxError",
                message: err?.message ?? String(error),
                stack: err?.stack,
            },
        })}\n`);
        return Promise.resolve();
    }
    const reader = deps.createInterface({ input: deps.stdin });
    reader.on("line", (line) => {
        if (!line.trim())
            return;
        sandbox.__deliver(line);
        setImmediate(() => {
            if (sandbox.__checkStalled())
                reader.close();
        });
    });
    const execution = sandbox.__execute(runFn).then(() => reader.close(), () => reader.close());
    setImmediate(() => {
        if (sandbox.__checkStalled())
            reader.close();
    });
    return execution;
}
function safeRunId(runId) {
    return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}
export function renderChildEntry(payload, meta) {
    const runId = safeRunId(meta.runId);
    return `// zcode dynamic workflow run ${runId}
// Generated by @zcode/dynamic-workflow-runtime before every launch; safe to delete once the run has settled.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";

export const payload = ${JSON.stringify(payload)};

// cell 的第二段引导脚本（channel / future / 停滞检测），与 payload 同样以字面量内嵌。
export const streamsBootstrap = ${JSON.stringify(CELL_STREAMS_BOOTSTRAP)};

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload, streamsBootstrap });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // best-effort：V8 对启动期已消费的旗标可能不再理会，失败不得影响 run。
  }
}

let isProcessEntry = false;
try {
  isProcessEntry =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isProcessEntry = false;
}
if (isProcessEntry) {
  void start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout });
}
`;
}
