import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { executeWorldRead } from "../vendor/mcode-host/workflow-world-read.js";

// MCode owns the operation schemas, Git parsing and result caps. This adapter
// supplies only filesystem/process I/O and cancels the entire process group.
export function createWorldDriver(cwd) {
  const controller = new AbortController();
  async function run({ command, timeoutMs = 300000, outputLimit = {} }) {
    if (controller.signal.aborted) throw new Error("工作流已停止");
    return new Promise((resolve) => {
      const buffers = { stdout: [], stderr: [] },
        sizes = { stdout: 0, stderr: 0 };
      const cap = outputLimit.maxInlineBytes ?? 1024 * 1024;
      let reason, error;
      const child = spawn(command.file, command.args ?? [], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => {
        try {
          process.platform === "win32"
            ? child.kill("SIGKILL")
            : process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const abort = () => {
        reason = "cancelled";
        kill();
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        reason = "timed_out";
        kill();
      }, timeoutMs);
      for (const stream of ["stdout", "stderr"])
        child[stream].on("data", (chunk) => {
          const remaining = cap + 1 - sizes[stream];
          if (remaining > 0) buffers[stream].push(chunk.subarray(0, remaining));
          sizes[stream] += chunk.length;
          if (sizes[stream] > cap) kill();
        });
      child.on("error", (e) => {
        error = { message: e.message };
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        const result = {
          status:
            reason ??
            (error ? "spawn_error" : code === 0 ? "completed" : "failed"),
          exitCode: code,
          error,
        };
        for (const stream of ["stdout", "stderr"])
          result[stream] = {
            text: Buffer.concat(buffers[stream]).toString("utf8"),
            bytes: sizes[stream],
            truncated: sizes[stream] > cap,
          };
        resolve(result);
      });
    });
  }
  // Ripgrep may not be installed on the host. Probe once; when it is missing,
  // fall back to a pure-Node walker that keeps the same result shape.
  let rgAvailable;
  const hasRg = async () => {
    if (rgAvailable === undefined) {
      const probe = await run({
        command: { file: "rg", args: ["--version"] },
        outputLimit: { maxInlineBytes: 4096 },
      });
      rgAvailable = probe.status === "completed";
    }
    return rgAvailable;
  };
  const rgArgs = [
    "--hidden",
    "-g",
    "!.git",
    "-g",
    "!node_modules",
  ];
  const rg = async (args) => {
    const result = await run({
      command: { file: "rg", args },
      outputLimit: { maxInlineBytes: 4 * 1024 * 1024 },
    });
    if (
      !["completed", "failed"].includes(result.status) ||
      (result.exitCode !== 0 && result.exitCode !== 1)
    )
      throw new Error(
        result.stderr.text || result.error?.message || "文件搜索失败",
      );
    return result;
  };
  const GLOB_SKIP = new Set([".git", "node_modules"]);
  const SCAN_FILE_CAP = 20000;
  const SCAN_BYTES_PER_FILE = 8 * 1024 * 1024;
  function globToRegExp(pattern) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          i++;
          if (pattern[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else re += ".*";
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
  }
  function matchGlob(pattern, rel) {
    const re = globToRegExp(pattern);
    if (re.test(rel)) return true;
    if (!pattern.includes("/")) {
      const base = rel.split("/").pop();
      if (base !== undefined && re.test(base)) return true;
    }
    return false;
  }
  async function* walk(dir, rel = "") {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (GLOB_SKIP.has(entry.name)) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), r);
      else if (entry.isFile()) yield { abs: path.join(dir, entry.name), rel: r };
    }
  }
  async function searchFilesNative({ pattern, maxResults }) {
    const re = globToRegExp(pattern);
    const files = [];
    let scanned = 0;
    let truncated = false;
    for await (const f of walk(cwd)) {
      if (matchGlob(pattern, f.rel)) {
        files.push(path.resolve(cwd, f.rel));
        if (files.length > maxResults) {
          truncated = true;
          break;
        }
      }
      if (++scanned >= SCAN_FILE_CAP) {
        truncated = true;
        break;
      }
    }
    return { files, truncated };
  }
  async function searchTextNative({ pattern, glob, headLimit }) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const entries = [];
    let truncated = false;
    let scanned = 0;
    for await (const f of walk(cwd)) {
      if (glob && !matchGlob(glob, f.rel)) continue;
      if (++scanned >= SCAN_FILE_CAP) {
        truncated = true;
        break;
      }
      let content;
      try {
        const handle = await fs.open(f.abs, "r");
        try {
          const buffer = Buffer.alloc(SCAN_BYTES_PER_FILE);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          content = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      const lines = content.split("\n");
      if (lines.length > 1) lines.pop(); // trailing newline
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          entries.push({
            path: path.resolve(cwd, f.rel),
            lineNumber: i + 1,
            text: lines[i],
          });
          if (entries.length > headLimit) {
            return { entries, truncated: true };
          }
        }
      }
    }
    return { entries, truncated };
  }
  const deps = {
    cwd,
    executionPort: { run },
    fileSystemPort: {
      async readTextFile({ path: file }) {
        return { content: await fs.readFile(file, "utf8") };
      },
      async searchFiles({ pattern, maxResults }) {
        if (!(await hasRg()))
          return searchFilesNative({ pattern, maxResults });
        const r = await rg([
          "--files",
          "--hidden",
          "-g",
          "!.git",
          "-g",
          pattern,
          "-0",
          ".",
        ]);
        const all = r.stdout.text.split("\0").filter(Boolean);
        return {
          files: all.slice(0, maxResults).map((p) => path.resolve(cwd, p)),
          truncated: all.length > maxResults || r.stdout.truncated,
        };
      },
      async searchText({ pattern, glob, headLimit }) {
        if (!(await hasRg()))
          return searchTextNative({ pattern, glob, headLimit });
        const r = await rg([
          "--json",
          ...rgArgs,
          ...(glob ? ["-g", glob] : []),
          "--",
          pattern,
          ".",
        ]);
        const entries = [];
        for (const line of r.stdout.text.split("\n")) {
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "match")
            entries.push({
              path: path.resolve(cwd, event.data.path.text),
              lineNumber: event.data.line_number,
              text: event.data.lines.text.replace(/\r?\n$/, ""),
            });
        }
        return {
          entries: entries.slice(0, headLimit),
          truncated: entries.length > headLimit || r.stdout.truncated,
        };
      },
    },
  };
  return {
    execute: (op, args) => executeWorldRead(deps, op, args),
    dispose: () => controller.abort(),
  };
}
