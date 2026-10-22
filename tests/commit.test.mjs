import test from "node:test";
import assert from "node:assert/strict";
import { submissionCommit } from "../lib/submission-commit.js";
import { collectSessionStats, createHostDriver } from "../lib/host-driver.js";

test("child usage counts current DSH messages and legacy stream usage without doubling cache", () => {
  const stats = collectSessionStats([
    { type: "assistant/message", data: { usage: { totalTokens: 31737, inputTokens: 31648, outputTokens: 89 } } },
    { type: "assistant/message", data: { usage: { totalTokens: 34564, inputTokens: 25302, outputTokens: 46, cacheReadTokens: 9216 } } },
    { type: "assistant/message", data: { stream: [{ type: "usage", usage: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 20 } }] } },
    { type: "tool/result", data: { message: { call: { name: "read" } } } },
    { type: "tool/result", data: { message: { call: { name: "workflow_submit_ask" } } } },
    { type: "turn/end" },
  ]);
  assert.deepEqual(stats, { tokens: 66335, toolCalls: 2, turns: 1, worldToolCalls: 1 });
});

test("submissions commit only after the final enclosing DSH transport succeeds", async () => {
  const committed = [],
    errors = [],
    commit = submissionCommit(
      (v) => committed.push(v),
      (e) => errors.push(e),
    );
  const parent = { token: {} },
    child = { token: {}, parent: parent.token };
  commit.stage(child, 1);
  commit.result(child, { isError: false });
  await Promise.resolve();
  assert.deepEqual(committed, []);
  commit.result(parent, { isError: true });
  await Promise.resolve();
  assert.deepEqual(committed, []);
  commit.stage(child, 2);
  commit.result(child, { isError: false });
  commit.result(parent, { isError: false });
  await Promise.resolve();
  assert.deepEqual(committed, [2]);
  assert.deepEqual(errors, []);
  commit.result(parent, { isError: false });
  await Promise.resolve();
  assert.deepEqual(committed, [2]);
});

test("native child success is not cancelled on workflow completion; stopped runs interrupt children", async () => {
  const events = new Map(),
    starts = [],
    interrupted = [];
  const ctx = {
    on: (name, fn) => {
      events.set(name, fn);
      return () => events.delete(name);
    },
    subagents: {
      resolveMaxDepth: () => 4,
      startActivation: async (spec) => {
        starts.push(spec);
        return { result: new Promise(() => {}), dispose: async () => {} };
      },
      interrupt: (id) => interrupted.push(id),
      sendMessage: async () => {},
    },
  };
  const driver = createHostDriver(ctx, { id: "parent" }, "run", {
    model: "provider/model",
    reasoningEffort: "high",
  });
  const child = await driver.createActor({}, { name: "开发" });
  await driver.ask(
    { sessionId: child, instance: "ask#1@1", instructions: "开发" },
    assert.fail,
  );
  assert.equal(starts[0].request.agentOptions.provider, "provider");
  assert.equal(starts[0].request.prompt[0].type, "text");
  assert.match(starts[0].request.prompt[0].text, /workflow_submit_ask/);
  assert.equal(starts[0].request.agentOptions.model, "model");
  driver.accepted("ask#1@1");
  driver.dispose(true);
  assert.deepEqual(interrupted, []);
  assert.equal(events.size, 0);
  const second = createHostDriver(ctx, { id: "parent" }, "run2");
  const id = await second.createActor({}, {});
  await second.ask(
    { sessionId: id, instance: "ask#2@1", instructions: "" },
    assert.fail,
  );
  second.dispose(false);
  assert.deepEqual(interrupted, [id]);
});

test("restored actors retain the resolved route and effort despite later defaults", async () => {
  const handlers = new Map(),
    starts = [],
    resolved = [];
  const transcripts = { seeds: new Map(), read: () => [{ type: "seed" }] };
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    subagents: {
      resolveMaxDepth: () => 4,
      async startActivation(spec) {
        starts.push(spec);
        return { result: new Promise(() => {}) };
      },
    },
  };
  const driver = createHostDriver(ctx, { id: "parent" }, "run", {
    transcripts,
    model: "new/model",
    reasoningEffort: "low",
  });
  const child = await driver.createActor(
    {},
    {},
    {
      sourceSessionId: "old",
      messageCount: 1,
      resolvedModel: "original/model$high",
    },
    (model) => resolved.push(model),
  );
  await driver.ask(
    { sessionId: child, instance: "ask@1", instructions: "continue" },
    assert.fail,
  );
  assert.deepEqual(starts[0].request.agentOptions, {
    provider: "original",
    model: "model",
    reasoningEffort: "high",
  });
  handlers.get("session/event")(
    { id: child },
    {
      type: "request/header",
      data: {
        header: {
          config: {
            provider: "original",
            model: "resolved",
            reasoningEffort: "high",
          },
        },
      },
    },
  );
  assert.deepEqual(resolved, ["original/resolved$high"]);
  driver.dispose(true);
});
