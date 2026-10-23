import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkflowsDir } from "../lib/core.js";

/** 独立临时 DSH home，避免污染真实 ~/.dsh。 */
async function fakeHome() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-workflow-home-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    dispose() {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
      return rm(dir, { recursive: true, force: true });
    },
  };
}

test("有项目标记（.dsh）时：保存目录 = <项目根>/.dsh/dsh-workflow", async () => {
  const home = await fakeHome();
  try {
    const base = realpathSync(await mkdtemp(join(tmpdir(), "wf-proj-")));
    await mkdir(join(base, ".dsh"), { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      assert.equal(defaultWorkflowsDir(), join(base, ".dsh", "dsh-workflow"));
    } finally {
      process.chdir(prevCwd);
    }
  } finally {
    await home.dispose();
  }
});

test("有 .git 标记时同样识别为项目根", async () => {
  const home = await fakeHome();
  try {
    const base = realpathSync(await mkdtemp(join(tmpdir(), "wf-git-")));
    await mkdir(join(base, ".git"), { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      assert.equal(defaultWorkflowsDir(), join(base, ".dsh", "dsh-workflow"));
    } finally {
      process.chdir(prevCwd);
    }
  } finally {
    await home.dispose();
  }
});

test("无项目标记：回退 <DSH_HOME>/workflows（原行为）", async () => {
  const home = await fakeHome();
  try {
    const base = realpathSync(await mkdtemp(join(tmpdir(), "wf-nomark-")));
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      assert.equal(defaultWorkflowsDir(), join(home.dir, "dsh-workflow"));
    } finally {
      process.chdir(prevCwd);
    }
  } finally {
    await home.dispose();
  }
});
