import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, getRun } from "../lib/engine-adapter.js";

test("completed runs recover child usage once and preserve checkpoint settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-workflow-usage-"));
  const runId = "dwfrun-usage-recovery";
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), [
    { op: "createRun", record: { runId, status: "completed", spentTokens: 0, name: "usage" } },
    { op: "putActor", record: { runId, siteId: "actor#1", ordinal: 1, sessionId: "child" } },
    { op: "putActor", record: { runId, siteId: "actor#2", ordinal: 1, sessionId: "child" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(dir, "plan.json"), "{}");
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    runId, run: { runId, status: "completed", spentTokens: 0 },
    pendingAsks: [], settlement: { status: "completed", result: "done" },
  }));
  configure({ dir: root, transcripts: { read: () => [
    { type: "assistant/message", data: { usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } } },
    { type: "assistant/message", data: { usage: { totalTokens: 80, inputTokens: 60, outputTokens: 20 } } },
  ] } });
  const run = await getRun(runId);
  assert.equal(run.figures.tokens, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"))).run.spentTokens, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"))).settlement.result, "done");
  const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
  assert.equal((await getRun(runId)).figures.tokens, 200);
  assert.equal(readFileSync(join(dir, "journal.jsonl"), "utf8"), journal);
});
