// Visual regression surface only. Fixture data never calls the DSH host.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fixtureResponse } from "../tests/fixtures.mjs";
const compiled = await build({
  stdin: {
    contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Root,Hub,RunCard,RunDetail,ArtifactDetail} from './src/client.jsx';
import css from './src/workflow.css'; import {fixtureRun} from './tests/fixtures.mjs';
const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
const context={theme:{getTheme:()=>({active:{colorScheme:'dark'}})},openAutomations(){},openRun(){location.hash='detail';location.reload()},openActor(){alert('原生子代理对话跳转')},openArtifact(){location.hash='artifact';location.reload()},draft(){alert('原生新建对话')},launch(){alert('原生工作流启动')}};
const view=location.hash.slice(1)||'hub';
createRoot(document.getElementById('app')).render(<Root context={context}>{view==='hub'?<Hub/>:view==='detail'?<RunDetail runId="dwfrun-running"/>:view==='artifact'?<ArtifactDetail runId="dwfrun-complete" id="report"/>:<div style={{padding:24,maxWidth:850,margin:'auto'}}><RunCard run={fixtureRun()}/><div style={{height:28}}/><RunCard run={fixtureRun(true)} completion/></div>}</Root>);
`,
    loader: "jsx",
    resolveDir: new URL("..", import.meta.url).pathname,
  },
  bundle: true,
  format: "iife",
  write: false,
  loader: { ".css": "text" },
});
const server = createServer((req, res) => {
  if (req.url.startsWith("/_dsh/dsh-workflow/")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(fixtureResponse(req.url)));
    return;
  }
  if (req.url === "/preview.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(compiled.outputFiles[0].text);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>Workflow UI verification</title><style>html,body,#app{margin:0;height:100%;background:#151515}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif}nav{padding:8px;color:#999}nav a{color:#bbb;margin:12px}</style></head><body><nav><a href="/">工作流</a><a href="/#cards" onclick="location.href=this.href;location.reload();return false">运行/完成卡</a><a href="/#detail" onclick="location.href=this.href;location.reload();return false">右侧阶段</a></nav><div id="app"></div><script src="/preview.js"></script></body></html>',
  );
});
server.listen(43179, "127.0.0.1", () =>
  console.log("UI fixture preview: http://127.0.0.1:43179"),
);
