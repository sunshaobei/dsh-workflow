import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, encode, decode, validateArgs } from "../lib/registry.js";

test("MCode frontmatter round trips body and preserves typed defaults", () => {
  const body = 'phase("设计");\nreturn args.count;\n';
  const meta = {
    description: "设计 → 开发",
    whenToUse: "新需求",
    args: {
      count: { type: "number", default: 0 },
      enabled: { type: "boolean", default: false },
      spec: { type: "json", required: true },
      requirement: { type: "string", required: true },
    },
  };
  const parsed = decode(encode(meta, body));
  assert.equal(parsed.script, body);
  assert.deepEqual(parsed.meta, meta);
  assert.deepEqual(
    validateArgs(meta.args, { spec: [1, false], requirement: "需求" }),
    { count: 0, enabled: false, spec: [1, false], requirement: "需求" },
  );
  assert.throws(() => validateArgs(meta.args, { wrong: 1 }), /未知参数/);
  assert.throws(
    () => validateArgs({ n: { type: "number" } }, { n: "1" }),
    /number/,
  );
  assert.throws(() => decode("/* zcode-workflow\ndescription: bad"), /未闭合/);
});

test("global/project registry moves without overwrite and never hides corrupt project files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const registry = new Registry(root, () => [
    { id: "p", title: "项目", path: project },
  ]);
  const source = encode({ description: "示例", args: {} }, "return 1;");
  await registry.save("demo", source);
  await registry.move("demo", "global", "p");
  assert.equal((await registry.list())[1].entries[0].name, "demo");
  assert.equal(
    (await registry.resolveEntry("demo", "p")).path,
    join(project, ".dsh/workflows/demo.dwf.ts"),
  );
  await registry.save("demo", source);
  await assert.rejects(registry.move("demo", "p", "global"), /EEXIST/);
  assert.equal((await registry.resolveEntry("demo", "p")).script, "return 1;");
  await mkdir(join(project, ".zcode/workflows"), { recursive: true });
  await writeFile(join(project, ".zcode/workflows/demo.dwf.ts"), source);
  await writeFile(registry.path("demo", "p"), "/* zcode-workflow\nbad");
  await assert.rejects(registry.resolveEntry("demo", "p"), /未闭合/);
  assert.throws(() => registry.path("../escape"), /name|名称|工作流/);
});
