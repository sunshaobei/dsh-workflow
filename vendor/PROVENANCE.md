# Source provenance

Reference checkout: `<本地 MCode 检出>`, inspected HEAD `434fd17661f14b9421b4acaf1a185616be275cfb`.

- `dynamic-workflow/`: compiled MCode compiler, analyzer, schema, facade and engine.
- `dynamic-workflow-runtime/`: transpiled runtime; relative imports, `.dsh` script directory, temporary prefix and Electron Node environment adapted.
- `mcode-host/`: bootstrap `workflow-world-read.ts`, `workflow-git-world-read.ts`, `dynamic-workflow-import.ts`; runtime imports adapted and terminal status set inlined.

DSH filesystem, process, storage and session adapters live in `lib/`. Vendor files are not reformatted with plugin sources.
