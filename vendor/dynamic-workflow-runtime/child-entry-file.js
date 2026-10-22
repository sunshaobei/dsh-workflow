// MCode dynamic-workflow-runtime port; imports and workspace directory adapted for DSH.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function workflowRunsDir(cwd) {
    return join(cwd, ".dsh", "workflow-runs");
}
export function fallbackWorkflowRunsDir() {
    return join(tmpdir(), "dsh-workflow-runs");
}
export function childEntryFileName(runId) {
    return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.mjs`;
}
export function writeChildEntryFile(input) {
    const projectDir = workflowRunsDir(input.cwd);
    const fileName = childEntryFileName(input.runId);
    try {
        return { path: writeInto(projectDir, fileName, input.source), location: "project" };
    }
    catch (error) {
        const fallbackDir = fallbackWorkflowRunsDir();
        input.onWarning?.({
            kind: "entry_file_fallback",
            projectDir,
            fallbackDir,
            error: error instanceof Error ? error.message : String(error),
        });
        return { path: writeInto(fallbackDir, fileName, input.source), location: "tmpdir" };
    }
}
function writeInto(dir, fileName, source) {
    mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    const path = join(dir, fileName);
    writeFileSync(path, source, "utf8");
    return path;
}
