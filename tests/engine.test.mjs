import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "../lib/engine-adapter.js";
import { createWorldDriver } from "../lib/world-driver.js";

const wait = async (fn) => {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out");
};
test("native results preserve phase projection, artifacts, cache reuse, args and workspace on amend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  engine.configure({ dir: join(root, "runs-root") });
  const runtime = {
    createActor: async () => "session-1",
    ask: async () => {},
    accepted() {},
    finish: async () => ({ messageBoundary: 8 }),
    dispose() {},
  };
  const code = `phase("解析"); const a = agent("设计解析员"); const x = await a.ask<{value: number}>("输入"); phase("交付"); await artifact.markdown("report", "# 报告\\n\\n真实产物", {title: "测试报告"}); return {x: x.value, input: args.input};`;
  const { runId } = await engine.createRun({
    code,
    name: "流程",
    cwd: root,
    args: { input: 3 },
    parentSessionId: "parent",
    runtime,
  });
  const ask = await wait(async () => (await engine.listPendingAsks(runId))[0]);
  const bad = await engine.validateSubmission(runId, ask.instance, {
    value: "bad",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.violation, /number/);
  const projected = await engine.getRun(runId);
  assert.equal(projected.phases.length, 2);
  assert.equal(projected.phases[0].actors[0].name, "设计解析员");
  assert.equal(
    (await engine.submitAsk(runId, ask.instance, { value: 7 })).ok,
    true,
  );
  await wait(async () => (await engine.status(runId)).status === "completed");
  assert.equal(
    (await engine.readArtifact(runId, "report")).content,
    "# 报告\n\n真实产物",
  );
  const { newRunId } = await engine.amendRun(runId, {
    code: code.replace("input: args.input", "input: Number(args.input) + 1"),
  });
  await wait(
    async () => (await engine.status(newRunId)).status === "completed",
  );
  const amended = await engine.getRun(newRunId);
  assert.deepEqual(amended.result, { x: 7, input: 4 });
  assert.equal(amended.resumedFrom, runId);
  assert.equal(amended.cwd, root);
  assert.equal(amended.parentSessionId, "parent");
});

test("world.run returns nonzero exit as data, grep matches MCode shape, cancellation terminates process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-world-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "test.txt"), "first\nneedle here\n");
  const world = createWorldDriver(root);
  t.after(() => world.dispose());
  assert.deepEqual(await world.execute("grep", ["needle", "*.txt"]), [
    { path: "test.txt", line: 2, text: "needle here" },
  ]);
  assert.deepEqual(
    await world.execute("run", [
      process.execPath,
      ["-e", 'process.stdout.write("ok");process.exit(2)'],
    ]),
    { exitCode: 2, stdout: "ok", stderr: "" },
  );
  const running = world.execute("run", [
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
  ]);
  setTimeout(() => world.dispose(), 50);
  await assert.rejects(running, /cancelled/);
});

test("typed scalar strings remain strings; native missing submissions nudge once and repair budget is bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-submit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  engine.configure({ dir: join(root, "state") });
  const observations = [],
    nudges = [],
    runtime = {
      createActor: async () => "child",
      ask: async (_spec, _fail, observation) => observations.push(observation),
      accepted() {},
      finish: async () => ({ messageBoundary: 8 }),
      nudge: async (id) => nudges.push(id),
      dispose() {},
      cancel() {},
    };
  const code =
    'const a = agent("worker"); return await a.ask<string | null>("result");';
  const { runId } = await engine.createRun({ code, cwd: root, runtime });
  const ask = await wait(async () => (await engine.listPendingAsks(runId))[0]);
  await observations[0].ended("missing submit");
  assert.deepEqual(nudges, ["child"]);
  assert.equal(
    (await engine.validateSubmission(runId, ask.instance, "42")).ok,
    true,
  );
  assert.equal((await engine.submitAsk(runId, ask.instance, "42")).ok, true);
  await wait(async () => (await engine.status(runId)).status === "completed");
  assert.equal((await engine.getRun(runId)).result, "42");
  const second = await engine.createRun({ code, cwd: root, runtime });
  const secondAsk = await wait(
    async () => (await engine.listPendingAsks(second.runId))[0],
  );
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await engine.submitAsk(second.runId, secondAsk.instance, {})).ok,
      false,
    );
  await wait(
    async () => (await engine.status(second.runId)).status === "errored",
  );
  assert.equal(
    (await engine.getRun(second.runId)).events.filter(
      (e) => e.event.type === "node-repairing",
    ).length,
    3,
  );
});

test("amending a live run prevents resuming the superseded predecessor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-superseded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  engine.configure({ dir: join(root, "state") });
  const { runId } = await engine.createRun({
    code: 'const a = agent("worker"); return await a.ask<string>("result");',
    cwd: root,
  });
  await wait(async () => (await engine.listPendingAsks(runId))[0]);
  const { newRunId } = await engine.amendRun(runId, { code: "return 1;" });
  await wait(
    async () => (await engine.status(newRunId)).status === "completed",
  );
  assert.equal((await engine.getRun(runId)).resumable, false);
  await assert.rejects(engine.resumeRun(runId), /only stopped runs resume/);
});
