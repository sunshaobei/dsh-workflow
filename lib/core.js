/**
 * dsh-workflow — core helpers (host half).
 *
 * Deliberately thin: the engine adapter (lib/engine-adapter.js) owns storage
 * and the engine; this module only owns the small shared bits the tool layer
 * needs — directory layout, saved-workflow name validation, and tiny JSON
 * file helpers. No engine logic lives here.
 */
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Default workflows root when config leaves `workflowsDir` empty. */
export function defaultWorkflowsDir() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, "workflows");
}

/** Resolve the effective workflows root from raw plugin config. */
export function resolveWorkflowsDir(config) {
  const configured =
    typeof config?.workflowsDir === "string" ? config.workflowsDir.trim() : "";
  return resolve(configured || defaultWorkflowsDir());
}

/** Directory layout under the workflows root (engine adapter owns the files). */
export function savedDir(root) {
  return join(root, "saved");
}
export function runsDir(root) {
  return join(root, "runs");
}
export function savedScriptPath(root, name) {
  return join(savedDir(root), name + ".dwf.ts");
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a saved-workflow name (also used as the file stem).
 * 1–64 chars; letters/digits/._- with no leading separator or dot-segment;
 * no path traversal possible because `/` and `\` are simply rejected.
 */
export function validateWorkflowName(name) {
  const value = String(name ?? "").trim();
  if (value.length < 1 || value.length > 64) {
    throw new Error("工作流名称长度需在 1–64 个字符之间");
  }
  if (!NAME_PATTERN.test(value) || value.includes("..")) {
    throw new Error("工作流名称只能包含字母、数字、点、下划线和连字符");
  }
  return value;
}

/** Validate a run id the same way (engine adapter minted it, but stay defensive). */
export function validateRunId(runId) {
  const value = String(runId ?? "").trim();
  if (!NAME_PATTERN.test(value) || value.includes("..")) {
    throw new Error("非法的 runId：" + value);
  }
  return value;
}

/** Read a UTF-8 text file, or null when it does not exist. */
export async function readTextOrNull(path) {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Read and parse a JSON file, or null when missing/invalid. */
export async function readJsonOrNull(path) {
  const text = await readTextOrNull(path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Write a JSON file (pretty-printed, trailing newline) via tmp+rename. */
export async function writeJson(path, value) {
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, path);
}

/** Write a UTF-8 text file via tmp+rename. */
export async function writeText(path, text) {
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, path);
}

/** List entry names in a directory, or [] when it does not exist. */
export async function listDirOrEmpty(path) {
  try {
    return await fsp.readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Parse the script-meta convention from the JSDoc block comment at the top
 * of a .dwf.ts script:
 *
 *   /**
 *    * @description 一体化开发流水线，自动拆分需求并逐段实现。
 *    * @arg requirement 需求描述
 *    * @arg style 代码风格，默认简洁
 *    *\/
 *
 * Returns { description, args: [{name, desc}] }; both default to empty.
 */
export function parseScriptMeta(text) {
  const meta = { description: "", args: [] };
  if (typeof text !== "string" || !text) return meta;
  const head = text.slice(0, 4096);
  // First block comment: /* ... */ (JSDoc style included).
  const m = head.match(/\/\*[\s\S]*?\*\//);
  if (!m) return meta;
  const block = m[0];
  const desc = block.match(/@\s*description\s+(.+)/);
  if (desc) meta.description = desc[1].trim();
  const argRe = /@\s*arg\s+([A-Za-z0-9_-]+)\s+(.+)/g;
  let a;
  while ((a = argRe.exec(block)) !== null) {
    meta.args.push({ name: a[1], desc: a[2].trim() });
  }
  return meta;
}
