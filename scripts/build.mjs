import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["src/client.jsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "chrome120",
  external: ["react"],
  loader: { ".css": "text" },
  write: false,
});
await writeFile(
  "lib/client.js",
  `// Generated from src/client.jsx and src/workflow.css.\nwindow.__ModuleLoader__.load({ id: "dsh-workflow", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n} });\n`,
);
console.log("Built lib/client.js");
