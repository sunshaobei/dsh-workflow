import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { entry, groups, fixtureRun, fixtureResponse } from "./fixtures.mjs";

const result = await build({
  entryPoints: [new URL("../src/client.jsx", import.meta.url).pathname],
  bundle: true,
  format: "cjs",
  write: false,
  external: ["react", "react-dom"],
  loader: { ".css": "text" },
  logLevel: "silent",
});
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/" },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => fixtureResponse(String(url)),
});
const exports = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  createRequire(import.meta.url),
  exports,
  exports.exports,
);
const ui = exports.exports;
const root = createRoot(document.getElementById("root"));
const context = {
  theme: { getTheme: () => ({ active: { colorScheme: "dark" } }) },
  openAutomations() {},
  openActor() {},
  openArtifact() {},
  openRun() {},
};
async function mount(Component, props = {}, overrides = {}) {
  await act(async () => {
    root.render(
      React.createElement(
        ui.Root,
        { context: { ...context, ...overrides } },
        React.createElement(Component, props),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
  });
}
async function click(element) {
  assert.ok(element, "click target exists");
  await act(async () => {
    element.click();
    await new Promise((r) => setTimeout(r, 5));
  });
}

test("pending right-pane navigation ignores an unmounted session", () => {
  const opened = [];
  assert.equal(
    ui.flushPendingOpen(undefined, undefined, (...args) => opened.push(args)),
    undefined,
  );
  assert.deepEqual(opened, []);
  assert.deepEqual(
    ui.flushPendingOpen(
      { sessionId: "next", address: "dsh-resource://workflow/run" },
      "current",
      (...args) => opened.push(args),
    ),
    { sessionId: "next", address: "dsh-resource://workflow/run" },
  );
  assert.equal(
    ui.flushPendingOpen(
      { sessionId: "next", address: "dsh-resource://workflow/run" },
      "next",
      (...args) => opened.push(args),
    ),
    undefined,
  );
  assert.deepEqual(opened, [
    ["dsh-resource://workflow/run", { kind: "workflow" }],
  ]);
});

test("workflow chat entry replaces the previous unsent draft", () => {
  const calls = [];
  const workspace = {
    startSession: (groupId, options) => calls.push([groupId, options]),
  };
  ui.startWorkflowDraft(workspace, undefined, "请修订 flutter-dev-pipeline");
  ui.startWorkflowDraft(workspace, undefined, "请创建一个新工作流");
  assert.deepEqual(calls, [
    [undefined, { prompt: "请修订 flutter-dev-pipeline", clearPreviousDraft: true }],
    [undefined, { prompt: "请创建一个新工作流", clearPreviousDraft: true }],
  ]);
});

test("saved hub opens details, parameters and typed launch dialog; validation prevents blank launch", async () => {
  await mount(ui.Hub);
  assert.match(document.body.textContent, /对所有项目可见/);
  await click(document.querySelector('[data-testid="workflow-saved-card"]'));
  await click(
    [...document.querySelectorAll("button")].find(
      (e) => e.textContent === "参数",
    ),
  );
  assert.match(document.body.textContent, /requirement/);
  await click(
    [...document.querySelectorAll("button")].find(
      (e) => e.textContent.trim() === "运行",
    ),
  );
  assert.ok(document.querySelector('[role="dialog"]'));
  await click(
    [...document.querySelectorAll('[role="dialog"] button')].find((e) =>
      e.textContent.includes("运行工作流"),
    ),
  );
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /requirement/,
  );
});

test("native launch receives typed numbers, booleans and parsed JSON", async () => {
  const received = [];
  await mount(
    ui.LaunchDialog,
    {
      entry: {
        ...entry,
        args: {
          ...entry.args,
          requirement: { type: "string", required: true, default: "构建卡片" },
        },
      },
      groups,
      onClose() {},
    },
    { launch: (...args) => received.push(args) },
  );
  await click(
    [...document.querySelectorAll("button")].find((e) =>
      e.textContent.includes("运行工作流"),
    ),
  );
  assert.equal(received.length, 1);
  assert.deepEqual(received[0][1], {
    requirement: "构建卡片",
    figmaUrl: "",
    designSpecPath: "",
    retry: 3,
    enabled: false,
    options: { strict: true },
  });
  assert.equal(received[0][2], "p");
});

test("run timeline exposes every phase, child navigation and completion artifact", async () => {
  const opened = [];
  await mount(
    ui.RunCard,
    { run: fixtureRun() },
    { openActor: (_run, actor) => opened.push(actor.sessionId) },
  );
  assert.equal(document.querySelectorAll(".wf-station").length, 5);
  await click(document.querySelector(".wf-agent:not(:disabled)"));
  assert.deepEqual(opened, ["child-0"]);
  await mount(ui.RunCard, { run: fixtureRun(true), completion: true });
  assert.equal(document.querySelectorAll(".wf-figures>div").length, 4);
  assert.match(document.body.textContent, /2.68M/);
  assert.match(document.querySelector(".wf-paper").textContent, /法币汇率/);
});

test("run card folds agent rows while keeping phases and artifacts; stopped actions are distinct", async () => {
  const calls = [];
  const run = {
    ...fixtureRun(true),
    status: "stopped",
    resumable: true,
  };
  await mount(ui.RunCard, { run }, {
    resume: async () => calls.push("resume"),
    rerun: async () => calls.push("rerun"),
  });
  const card = document.querySelector('[data-testid="workflow-run-card"]');
  assert.equal(card.getAttribute("aria-expanded"), "true");
  assert.equal(card.querySelectorAll(".wf-agent").length, 6);
  const continueButton = card.querySelector('[aria-label^="继续运行"]');
  const rerunButton = card.querySelector('[aria-label^="再次运行"]');
  assert.ok(continueButton.title.includes("已完成步骤"));
  assert.ok(rerunButton.title.includes("新建运行"));
  assert.notEqual(
    continueButton.querySelector("path").getAttribute("d"),
    rerunButton.querySelector("path").getAttribute("d"),
  );
  await click(card.querySelector(".wf-card-head"));
  assert.equal(card.getAttribute("aria-expanded"), "false");
  assert.equal(card.querySelectorAll(".wf-agent").length, 0);
  assert.equal(card.querySelectorAll(".wf-station").length, 5);
  assert.ok(card.querySelector(".wf-artifact-strip"));
  await click(card.querySelector(".wf-card-head"));
  assert.equal(card.querySelectorAll(".wf-agent").length, 6);
  await click(continueButton);
  await click(rerunButton);
  assert.deepEqual(calls, ["resume", "rerun"]);
});

test("right pane expands phases; markdown artifacts render tables and lists", async () => {
  await mount(ui.RunDetail, { runId: "dwfrun-running" });
  const headings = document.querySelectorAll(".wf-vertical-heading");
  assert.equal(headings.length, 5);
  assert.equal(headings[0].getAttribute("aria-expanded"), "true");
  await click(headings[1]);
  assert.equal(headings[1].getAttribute("aria-expanded"), "true");
  await mount(ui.ArtifactDetail, { runId: "dwfrun-complete", id: "report" });
  assert.ok(document.querySelector(".wf-markdown table"));
  assert.equal(document.querySelectorAll(".wf-markdown li").length, 2);
});

test("preset artifacts use nested fields, replace keyed rows, and render negative bars from zero", async () => {
  await mount(ui.PresetArtifact, {
    item: {
      kind: "table",
      spec: { key: "id", columns: [{ field: "result.score", label: "分数" }] },
      items: [
        { id: 1, result: { score: 2 } },
        { id: 1, result: { score: 8 } },
      ],
    },
  });
  assert.equal(document.querySelectorAll("tbody tr").length, 1);
  assert.match(document.querySelector("tbody").textContent, /8/);
  await mount(ui.PresetArtifact, {
    item: {
      kind: "metrics",
      spec: { metrics: [{ field: "result.score", label: "分数" }] },
      items: [{ result: { score: 2 } }, { result: { score: 8 } }],
    },
  });
  assert.match(document.querySelector(".wf-metrics").textContent, /8/);
  await mount(ui.PresetArtifact, {
    item: {
      kind: "chart",
      spec: { type: "bar", x: { field: "label" }, y: { field: "value" } },
      items: [
        { label: "下降", value: -5 },
        { label: "上升", value: 5 },
      ],
    },
  });
  const bars = [...document.querySelectorAll("rect")];
  assert.equal(bars.length, 2);
  assert.equal(bars[0].getAttribute("height"), bars[1].getAttribute("height"));
  assert.notEqual(bars[0].getAttribute("y"), bars[1].getAttribute("y"));
});
