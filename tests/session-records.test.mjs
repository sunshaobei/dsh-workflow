import test from "node:test";
import assert from "node:assert/strict";
import { Session, appendPluginRecord } from "@deepseek-ai/dsh-session";
import {
  WORKFLOW_RUN_RECORD, workflowSessionTitle, workflowRunId,
  prepareWorkflowSession, repairWorkflowSessionEvents,
} from "../lib/session-records.js";

test("workflow titles use zero-padded Beijing run time, including day rollover", () => {
  assert.equal(workflowSessionTitle("巡检", Date.parse("2026-10-19T04:34:02Z")), "巡检-20261019123402");
  assert.equal(workflowSessionTitle("巡检", Date.parse("2026-01-01T16:00:00Z")), "巡检-20260102000000");
  assert.equal(workflowSessionTitle(undefined, Date.parse("2026-10-19T04:34:02Z")), "工作流-20261019123402");
});

test("host plugin record and pinned title survive JSON persistence and a fresh Session replay", async () => {
  const session = Session.create("workflow-session");
  const imports = [];
  const titles = {
    get: (s) => s.snapshotEvents().findLast((event) => event.type === "session/title")?.data,
    rename: (s, title) => s.append("session/title", { title, messageSeqs: [], source: { kind: "user" } }),
  };
  const ctx = { get: (name) => name === "sessionTitle" ? titles : {
    import: async (specifier) => { imports.push(specifier); return { appendPluginRecord }; },
  } };
  const record = await prepareWorkflowSession(ctx, session);
  record("run-1", Date.parse("2026-10-19T04:34:02Z"), "调研工作流");
  assert.deepEqual(imports, ["@deepseek-ai/dsh-session"]);
  const persisted = JSON.parse(JSON.stringify(session.snapshotEvents()));
  const restored = Session.create(session.id, persisted, session.header);
  assert.equal(restored.snapshotEvents()[0].type, WORKFLOW_RUN_RECORD);
  assert.equal(restored.snapshotEvents()[0].ignorable, true);
  assert.equal(workflowRunId(restored.snapshotEvents()[0]), "run-1");
  assert.equal(titles.get(restored).title, "调研工作流-20261019123402");
  titles.rename(session, "保留我自己设置的名称");
  record("run-2", Date.now());
  assert.equal(titles.get(session).title, "保留我自己设置的名称");
});

test("legacy workflow repair preserves payloads/sequences, restores replay, and is idempotent", () => {
  const session = Session.create("legacy-workflow");
  const old = [{ type: "dsh-workflow/run", seq: 0, time: Date.parse("2026-10-19T04:34:02Z"), data: { runId: "legacy-run" } }];
  const repaired = repairWorkflowSessionEvents(old);
  assert.equal(old[0].type, "dsh-workflow/run");
  assert.equal(repaired.events[0].data, old[0].data);
  assert.equal(repaired.events[0].seq, 0);
  assert.equal(repaired.changed, true);
  const restored = Session.create(session.id, repaired.events, session.header);
  assert.equal(workflowRunId(restored.snapshotEvents()[0]), "legacy-run");
  assert.equal(restored.snapshotEvents()[1].data.title, "工作流-20261019123402");
  assert.equal(repairWorkflowSessionEvents(repaired.events).changed, false);
});

test("ordinary sessions and unrelated unknown events are never rewritten", () => {
  const events = [{ type: "other-plugin/event", seq: 0, time: 1, data: {} }];
  assert.deepEqual(repairWorkflowSessionEvents(events), { changed: false, events });
  assert.equal(workflowRunId({ type: WORKFLOW_RUN_RECORD, data: {} }), undefined);
});
