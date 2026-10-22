// Offline repair for the old dsh-workflow/run envelope. Dry-run unless --apply is supplied.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";
import { Session } from "@deepseek-ai/dsh-session";
import { repairWorkflowSessionEvents } from "../lib/session-records.js";

const [homeArg, backupArg, flag] = process.argv.slice(2);
if (!homeArg || !backupArg) throw new Error("Usage: node repair-session-records.mjs <dsh-home> <backup-directory> [--apply]; close DSH before --apply");
const home = resolve(homeArg), backup = resolve(backupArg), apply = flag === "--apply";
const parents = new Set();
for (const name of readdirSync(join(home, "workflows", "runs"))) {
  const file = join(home, "workflows", "runs", name, "meta.json");
  if (existsSync(file)) parents.add(JSON.parse(readFileSync(file, "utf8")).parentSessionId);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = [];
for (const workspace of readdirSync(join(home, "sessions"), { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue;
  const root = join(home, "sessions", workspace.name);
  for (const id of readdirSync(root)) {
    if (!parents.has(id)) continue;
    const file = join(root, id, "session.v4.jsonl.zstd");
    if (!existsSync(file)) continue;
    const original = readFileSync(file);
    // Node's one-shot decompressor reads only the first frame; session logs concatenate frames.
    const text = execFileSync("zstd", ["-qdc", file], { maxBuffer: 128 * 1024 * 1024 }).toString();
    const [header, ...events] = text.trimEnd().split("\n").map(JSON.parse);
    const repaired = repairWorkflowSessionEvents(events);
    if (!repaired.changed) continue;
    Session.create(id, repaired.events, header);
    // The host requires exactly one header line in the first independently decodable frame.
    const compress = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const headerText = JSON.stringify(header) + "\n";
    const bytes = Buffer.concat([compress(headerText), compress(repaired.events.map((e) => JSON.stringify(e)).join("\n") + "\n")]);
    if (zstdDecompressSync(bytes).toString() !== headerText) throw new Error(`invalid header frame: ${id}`);
    const decoded = execFileSync("zstd", ["-qdc"], { input: bytes, maxBuffer: 128 * 1024 * 1024 }).toString();
    if (decoded !== headerText + repaired.events.map((e) => JSON.stringify(e)).join("\n") + "\n") throw new Error(`round-trip failed: ${id}`);
    if (apply) {
      const target = join(backup, relative(home, file));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, original, { flag: "wx", mode: 0o600 });
      if (sha(readFileSync(file)) !== sha(original)) throw new Error(`session changed during repair: ${id}`);
      const temporary = `${file}.workflow-repair-${process.pid}.tmp`;
      writeFileSync(temporary, bytes, { flag: "wx", mode: statSync(file).mode & 0o777 });
      renameSync(temporary, file);
    }
    report.push({ id, eventsBefore: events.length, eventsAfter: repaired.events.length,
      title: repaired.events.findLast((e) => e.type === "session/title")?.data.title,
      originalSha256: sha(original), repairedSha256: sha(bytes), applied: apply });
  }
}
if (apply) writeFileSync(join(backup, "repair-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
