import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  validateWorkflowName,
  listDirOrEmpty,
  readTextOrNull,
} from "./core.js";

// 与 MCode saved-workflows/frontmatter.ts 同一文件协议；保留正文逐字节。
export function decode(source) {
  const match =
    /^\s*\/\* (?:zcode|dsh)-workflow\s*\n([\s\S]*?)\n\*\/\r?\n?/.exec(source);
  if (!match) {
    if (/^\s*\/\* (?:zcode|dsh)-workflow/.test(source))
      throw new Error("工作流元数据未闭合");
    const description =
      /@description\s+([^\n]+)/.exec(source)?.[1]?.trim() ?? "";
    const args = Object.fromEntries(
      [...source.matchAll(/@arg\s+([\w-]+)\s+([^\n]+)/g)].map((m) => [
        m[1],
        { type: "string", description: m[2].trim() },
      ]),
    );
    return { meta: { description, args }, script: source, legacy: true };
  }
  const meta = parse(match[1], { maxAliasCount: 20 });
  checkMeta(meta);
  return { meta, script: source.slice(match[0].length), legacy: false };
}
export function checkMeta(meta) {
  if (!meta || typeof meta.description !== "string")
    throw new Error("description 必须是字符串");
  if (
    meta.args != null &&
    (typeof meta.args !== "object" || Array.isArray(meta.args))
  )
    throw new Error("args 必须是参数声明对象");
  for (const [key, spec] of Object.entries(meta.args ?? {})) {
    if (!spec || !["string", "number", "boolean", "json"].includes(spec.type))
      throw new Error(`参数 ${key} 的类型无效`);
    if (spec.required !== undefined && typeof spec.required !== "boolean")
      throw new Error(`参数 ${key} 的 required 必须是布尔值`);
    if (spec.default !== undefined)
      validateArgs({ [key]: spec }, { [key]: spec.default });
  }
}
export function encode(meta, script) {
  checkMeta(meta);
  return `/* zcode-workflow\n${stringify({ description: meta.description, ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}), args: meta.args ?? {} })}*/\n${script}`;
}
export function validateArgs(declared = {}, given = {}) {
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new Error("参数必须是对象");
  const errors = [],
    args = {};
  for (const key of Object.keys(given))
    if (!Object.hasOwn(declared, key)) errors.push(`未知参数：${key}`);
  for (const [key, spec] of Object.entries(declared)) {
    const value = given[key] === undefined ? spec.default : given[key];
    if (value === undefined) {
      if (spec.required) errors.push(`请填写必填参数：${key}`);
      continue;
    }
    if (
      spec.type !== "json" &&
      (typeof value !== spec.type ||
        (spec.type === "number" && !Number.isFinite(value)))
    )
      errors.push(`${key} 必须是 ${spec.type}`);
    else args[key] = value;
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return args;
}
export class Registry {
  constructor(root, projects = () => []) {
    this.root = root;
    this.projects = projects;
  }
  groups() {
    return [
      {
        id: "global",
        name: "全局",
        scope: "global",
        path: join(this.root, "saved"),
      },
      ...this.projects().map((p) => ({
        id: p.id,
        name: p.title || basename(p.path),
        scope: "project",
        workspacePath: p.path,
        path: join(p.path, ".dsh", "workflows"),
      })),
    ];
  }
  group(id = "global") {
    const g = this.groups().find((g) => g.id === id);
    if (!g) throw new Error("项目已关闭或不存在");
    return g;
  }
  path(name, groupId) {
    return join(
      this.group(groupId).path,
      validateWorkflowName(name) + ".dwf.ts",
    );
  }
  async get(name, groupId) {
    const path = this.path(name, groupId),
      source = await readTextOrNull(path);
    if (source === null)
      throw Object.assign(new Error("找不到工作流：" + name), {
        code: "ENOENT",
      });
    const { meta, script, legacy } = decode(source);
    return {
      ...this.group(groupId),
      ...meta,
      name,
      groupId: groupId ?? "global",
      path,
      source,
      script,
      legacy,
      updatedAt: (await fs.stat(path)).mtimeMs,
      id: `${groupId ?? "global"}:${name}`,
    };
  }
  async list() {
    return Promise.all(
      this.groups().map(async (group) => {
        const entries = [],
          errors = [];
        // 已有项目的 MCode 文件也可直接读取，迁移/修改时写到 dsh 的目录。
        const dirs = [
          group.path,
          ...(group.workspacePath
            ? [join(group.workspacePath, ".zcode", "workflows")]
            : []),
        ];
        for (const dir of dirs)
          for (const file of await listDirOrEmpty(dir)) {
            if (
              !file.endsWith(".dwf.ts") ||
              entries.some((e) => e.name === file.slice(0, -7))
            )
              continue;
            try {
              const path = join(dir, file),
                source = await fs.readFile(path, "utf8"),
                { meta } = decode(source);
              entries.push({
                ...meta,
                name: file.slice(0, -7),
                groupId: group.id,
                scope: group.scope,
                workspacePath: group.workspacePath,
                path,
                updatedAt: (await fs.stat(path)).mtimeMs,
              });
            } catch (e) {
              errors.push({ file, error: e.message });
            }
          }
        return { ...group, entries, errors };
      }),
    );
  }
  async resolveEntry(name, groupId = "global") {
    try {
      return await this.get(name, groupId);
    } catch (e) {
      if (e.code !== "ENOENT" || !this.group(groupId).workspacePath) throw e;
      const path = join(
        this.group(groupId).workspacePath,
        ".zcode",
        "workflows",
        validateWorkflowName(name) + ".dwf.ts",
      );
      const source = await readTextOrNull(path);
      if (source === null) throw e;
      return {
        ...decode(source).meta,
        script: decode(source).script,
        source,
        path,
        name,
        groupId,
        workspacePath: this.group(groupId).workspacePath,
      };
    }
  }
  async save(name, source, groupId = "global", { overwrite = true } = {}) {
    decode(source);
    const path = this.path(name, groupId);
    await fs.mkdir(this.group(groupId).path, { recursive: true });
    if (!overwrite) await fs.writeFile(path, source, { flag: "wx" });
    else {
      const tmp = `${path}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, source);
      await fs.rename(tmp, path);
    }
    return this.get(name, groupId);
  }
  async move(name, from, to) {
    if (from === to) return this.resolveEntry(name, from);
    const entry = await this.resolveEntry(name, from);
    const saved = await this.save(name, entry.source, to, { overwrite: false });
    await fs.unlink(entry.path);
    return saved;
  }
  async remove(name, groupId) {
    const entry = await this.resolveEntry(name, groupId);
    await fs.unlink(entry.path);
  }
}
