// dsh-workflow selftest: compile + analyze + run a tiny workflow whose asks are
// answered programmatically via submitAsk (agent-driven, no LLM in-process).
//   node scripts/selftest.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 15000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`selftest: timed out waiting for ${what}`);
}

const SCRIPT = `
phase("collect");
log("selftest: collecting");
const listing = await files.glob("*.md");
const reviewer = agent("reviewer");
const verdict = await reviewer.ask<{ score: number; notes: string }>("Review the file list: " + listing.join(", "));
phase("summarize");
const comment = await reviewer.ask("Any final comment?");
report({ verdict, comment });
return { score: verdict.score, listingCount: listing.length, comment };
`;

async function main() {
  const mod = await import("../lib/engine-adapter.js");
  const {
    configure,
    compileScript,
    analyzeScript,
    createRun,
    listPendingAsks,
    submitAsk,
    getRun,
    listRuns,
    status,
    stopRun,
    resumeRun,
    openHoles,
  } = mod;

  configure({
    dir: mkdtempSync(path.join(tmpdir(), "dsh-workflow-selftest-")),
  });
  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
    );
    if (!cond) failures.push(name);
  };

  // 1. compile
  const compiled = await compileScript(SCRIPT);
  check(
    "compileScript ok",
    compiled.ok,
    compiled.diagnostics
      ?.map((d) => `${d.line}:${d.column} ${d.message}`)
      .join("; "),
  );

  // 2. analyze + mermaid projections
  const analyzed = await analyzeScript(SCRIPT);
  check("analyzeScript ok", analyzed.ok);
  check(
    "mermaid projections present",
    ["site", "causality", "controlFlow", "handoff", "phase"].every(
      (k) =>
        typeof analyzed.mermaid[k] === "string" &&
        analyzed.mermaid[k].length > 0,
    ),
    Object.fromEntries(
      Object.entries(analyzed.mermaid).map(([k, v]) => [
        k,
        typeof v === "string" ? `${v.length} chars` : String(v),
      ]),
    ),
  );
  check("coreJson present", !!analyzed.coreJson);

  // 3. run with programmatic asks
  const { runId } = await createRun({
    name: "selftest",
    code: SCRIPT,
    args: {},
  });
  console.log("runId:", runId);

  const pending1 = await waitUntil(
    () => listPendingAsks(runId).then((a) => (a.length ? a : null)),
    15000,
    "first pending ask",
  );
  console.log(
    "pending ask 1:",
    JSON.stringify({
      instance: pending1[0].instance,
      actorName: pending1[0].actorName,
      typed: !!pending1[0].schema,
    }),
  );
  check(
    "typed ask exposes schema",
    pending1[0].schema &&
      pending1[0].schema.type === "object" &&
      !!pending1[0].schema.properties?.score,
    JSON.stringify(pending1[0].schema)?.slice(0, 120),
  );

  // wrong schema first
  const bad = await submitAsk(runId, pending1[0].instance, {
    score: "four",
    notes: 42,
  });
  check(
    "wrong-schema submit rejected",
    bad.ok === false && typeof bad.violation === "string",
    bad.violation,
  );

  const good = await submitAsk(runId, pending1[0].instance, {
    score: 4,
    notes: "looks fine",
  });
  check("typed submit accepted", good.ok === true, good.violation ?? "");

  const pending2 = await waitUntil(
    () => listPendingAsks(runId).then((a) => (a.length ? a : null)),
    15000,
    "second pending ask",
  );
  check("untyped ask has no schema", pending2[0].schema === null);
  const good2 = await submitAsk(runId, pending2[0].instance, "ship it");
  check("untyped submit accepted", good2.ok === true, good2.violation ?? "");

  await waitUntil(
    () => status(runId).then((s) => (s.status !== "running" ? s : null)),
    15000,
    "settlement",
  );
  const run = await getRun(runId);
  console.log("status:", run.status, "| result:", JSON.stringify(run.result));
  console.log("counts:", JSON.stringify(run.counts));
  check("run completed", run.status === "completed");
  check(
    "result carries typed answer",
    run.result?.score === 4 && run.result?.comment === "ship it",
    JSON.stringify(run.result),
  );
  check(
    "counts sane",
    run.counts.asks === 2 &&
      run.counts.reports === 1 &&
      run.counts.worldReads === 1 &&
      run.counts.events > 5,
    JSON.stringify(run.counts),
  );
  check(
    "phases projected",
    run.phases.map((p) => p.name).join(",") === "collect,summarize",
    run.phases.map((p) => p.name).join(","),
  );
  check(
    "actors projected",
    run.actors.some((a) => a.name === "reviewer"),
    JSON.stringify(run.actors),
  );
  check(
    "reports carry items",
    run.reports.length === 1 && run.reports[0].item?.verdict?.score === 4,
  );

  // 4. stop + resume path
  const { runId: rid2 } = await createRun({
    name: "selftest-resume",
    code: SCRIPT,
    args: {},
  });
  await waitUntil(
    () => listPendingAsks(rid2).then((a) => (a.length ? a : null)),
    15000,
    "resume-run first ask",
  );
  await submitAsk(rid2, (await listPendingAsks(rid2))[0].instance, {
    score: 2,
    notes: "partial",
  });
  await waitUntil(
    () => listPendingAsks(rid2).then((a) => (a.length ? a : null)),
    15000,
    "resume-run second ask",
  );
  const stopped = await stopRun(rid2, "user");
  check("stopRun ok", stopped.ok === true);
  const st = await status(rid2);
  check("run stopped", st.status === "stopped", JSON.stringify(st));

  const resumed = await resumeRun(rid2);
  check("resumeRun started", !!resumed.runId);
  // first ask replays from the journal; the second ask goes live again
  await waitUntil(
    () => listPendingAsks(rid2).then((a) => (a.length ? a : null)),
    15000,
    "resumed pending ask",
  );
  const r2 = await submitAsk(
    rid2,
    (await listPendingAsks(rid2))[0].instance,
    "resumed comment",
  );
  check("post-resume submit accepted", r2.ok === true, r2.violation ?? "");
  await waitUntil(
    () => status(rid2).then((s) => (s.status !== "running" ? s : null)),
    15000,
    "resumed settlement",
  );
  const run2 = await getRun(rid2);
  check(
    "resumed run completed",
    run2.status === "completed",
    JSON.stringify(run2.status),
  );
  check(
    "resumed result replays cached ask",
    run2.result?.score === 2 && run2.result?.comment === "resumed comment",
    JSON.stringify(run2.result),
  );

  const all = await listRuns();
  check(
    "listRuns sees both",
    all.length === 2 && all.every((r) => r.status === "completed"),
    JSON.stringify(all.map((r) => [r.runId.slice(0, 14), r.status])),
  );
  check("openHoles empty", (await openHoles(runId)).length === 0);

  // 5. holes: run parks at an open hole until fillHole releases it
  const HOLE_SCRIPT = `
phase("gate");
const patch = await hole<string>("apply_patch", "give the patch body");
log("hole filled");
return { patch: patch };
`;
  const { runId: rid3 } = await createRun({
    name: "selftest-hole",
    code: HOLE_SCRIPT,
    args: {},
  });
  const holes1 = await waitUntil(
    () => openHoles(rid3).then((h) => (h.length ? h : null)),
    15000,
    "open hole",
  );
  check(
    "hole parked",
    holes1[0].name === "apply_patch",
    JSON.stringify(holes1[0]),
  );
  const fill = await mod.fillHole(
    rid3,
    holes1[0].siteId,
    `return "const x = 1";`,
  );
  check("fillHole ok", fill.ok === true, JSON.stringify(fill));
  await waitUntil(
    () => status(rid3).then((s) => (s.status !== "running" ? s : null)),
    15000,
    "hole-run settlement",
  );
  const run3 = await getRun(rid3);
  check(
    "hole run completed with filled value",
    run3.status === "completed" && run3.result?.patch === "const x = 1",
    JSON.stringify(run3.result),
  );
  check("listRuns sees all three", (await listRuns()).length === 3);

  console.log(
    failures.length === 0
      ? "\nSELFTEST PASSED"
      : `\nSELFTEST FAILED: ${failures.join(", ")}`,
  );
  rmSync(mod.WORKFLOWS_DIR, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SELFTEST ERROR:", err);
  process.exit(1);
});
