import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { encode } from "../lib/registry.js";
import * as engine from "../lib/engine-adapter.js";
import { Session, appendPluginRecord } from "@deepseek-ai/dsh-session";

test("installed DSH tool compiler accepts every registration; saved parameters and completion notices use native host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definitions = new Map(),
    effects = [],
    notices = [],
    endpoints = [],
    prompts = [],
    handlers = new Map();
  const parent = {
    id: "parent",
    status: "idle",
    session: { header: { cwd: root }, seq: 2 },
    followup: (v) => notices.push(v),
    steer: (v) => notices.push(v),
  };
  const workflowSession = Session.create("workflow-parent", [], {
    type: "session", version: 4, id: "workflow-parent", createdAt: Date.now(), cwd: root, isSeeded: false,
  });
  const workflowParent = { ...parent, id: workflowSession.id, session: workflowSession };
  const ctx = {
    logger: { warn: assert.fail },
    tools: {
      register(tool) {
        definitions.set(tool.name, tool);
        return () => {};
      },
    },
    subagents: {
      registerProvider() {
        return () => {};
      },
    },
    get(name) {
      if (name === "agents")
        return { get: (id) => id === "parent" ? parent : id === workflowParent.id ? workflowParent : undefined };
      if (name === "loader") return { import: async (specifier) => {
        assert.equal(specifier, "@deepseek-ai/dsh-session");
        return { appendPluginRecord };
      } };
      if (name === "sessionTitle") return {
        get: (session) => session.snapshotEvents().findLast((e) => e.type === "session/title")?.data,
        rename: (session, title) => session.append("session/title", { title, messageSeqs: [], source: { kind: "user" } }),
      };
      if (name === "workspaceRegistry")
        return { list: () => [{ id: "p", title: "项目", path: root }] };
    },
    on(name, handler) {
      const list = handlers.get(name) ?? new Set();
      list.add(handler);
      handlers.set(name, list);
      return () => list.delete(handler);
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
      return disposer;
    },
    inject(deps, fn) {
      if (deps[0] === "webServer")
        fn({ webServer: { register: (e) => endpoints.push(e) } });
      if (deps[0] === "systemPrompt")
        fn({ systemPrompt: { section: (p) => prompts.push(p) } });
    },
  };
  apply(ctx, { workflowsDir: join(root, "workflows") });
  t.after(() => {
    for (const effect of effects.reverse()) effect();
  });
  assert.equal(definitions.size, 17);
  assert.equal(endpoints.length, 1);
  assert.match(prompts[0].text(), /workflow_compile/);
  const source = encode(
    { description: "参数测试", args: { n: { type: "number", default: 4 } } },
    "return Number(args.n) + 1;",
  );
  await definitions
    .get("workflow_save")
    .execute({ name: "typed", code: source, groupId: "p" }, { agent: parent });
  const created = await definitions
    .get("workflow_create_run")
    .execute(
      { name: "typed", groupId: "p" },
      { agent: parent, callId: "call-1" },
    );
  assert.equal(created.ok, true);
  for (let n = 0; n < 200 && !notices.length; n++)
    await new Promise((r) => setTimeout(r, 10));
  const run = await engine.getRun(created.runId);
  assert.equal(run.result, 5);
  assert.equal(run.toolCallId, "call-1");
  assert.equal(run.groupId, "p");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].source.kind, "workflow-settled");
  for (const handler of handlers.get("session/event"))
    handler(
      { id: "unrelated" },
      { type: "user/message", seq: 10, data: notices[0] },
    );
  assert.equal((await engine.getRun(created.runId)).completionSeq, undefined);
  for (const handler of handlers.get("session/event"))
    handler(
      { ...parent.session, id: parent.id },
      { type: "user/message", seq: 11, data: notices[0] },
    );
  assert.equal((await engine.getRun(created.runId)).completionSeq, 11);
  await definitions
    .get("workflow_save")
    .execute({ name: "copied", runId: created.runId }, { agent: parent });
  const copied = await definitions
    .get("workflow_get_saved")
    .execute({ name: "copied" }, { agent: parent });
  assert.deepEqual(copied.args, { n: { type: "number", default: 4 } });
  let status, body;
  await endpoints[0].handler({
    method: "POST", url: "/_dsh/dsh-workflow/action",
    socket: { remoteAddress: "127.0.0.1" }, headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: "create-run", savedName: "typed", groupId: "p", parentSessionId: workflowParent.id }));
    },
  }, {
    writeHead: (value) => { status = value; },
    end: (value) => { body = JSON.parse(value); },
  });
  assert.equal(status, 200, JSON.stringify(body));
  const anchor = workflowSession.snapshotEvents().find((event) => event.type === "plugin:dsh-workflow/run");
  assert.equal(anchor.data.runId, body.result.runId);
  assert.equal(anchor.ignorable, true);
  const title = workflowSession.snapshotEvents().find((event) => event.type === "session/title");
  assert.match(title.data.title, /^typed-\d{14}$/);
  assert.doesNotThrow(() => Session.create(workflowSession.id,
    JSON.parse(JSON.stringify(workflowSession.snapshotEvents())), workflowSession.header));
  for (let n = 0; n < 200 && (await engine.getRun(body.result.runId)).status !== "completed"; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await engine.getRun(body.result.runId)).status, "completed");
});
