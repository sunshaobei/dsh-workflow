# @sunshaobei/dsh-workflow

DSH 的 TypeScript 工作流插件：用脚本描述多阶段、可并行的子代理任务，自动调度原生
子代理并把结果回传给主会话；侧栏「工作流」管理已保存的流程和历史运行。

## 安装

```sh
dsh plugin --profile web add @sunshaobei/dsh-workflow
```

更新/卸载把 `add` 换成 `update` / `remove`。安装、更新后重启一次 `dsh web`（bundle 层
只在启动时组合）。

## 能做什么

- `workflow_compile`：编译并校验脚本，返回阶段、子代理、依赖图与门面类型。
- `workflow_create_run`：运行内联脚本，或按名称/参数运行已保存流程。
- `workflow_save` / `workflow_list_saved` / `workflow_get_saved` / `workflow_delete_saved`：
  保存、列出、读取、删除流程。
- `workflow_get_run` / `workflow_status` / `workflow_runs` / `workflow_stop` /
  `workflow_resume` / `workflow_amend`：查看、停止、恢复、修订运行。
- `workflow_asks` / `workflow_submit_ask` / `workflow_holes` / `workflow_fill_hole` /
  `workflow_graphs`：子任务提交、留白补全与依赖图。

脚本 API：`agent(name, persona).ask<T>()`、`future()`、`world.run()`、`files.*`、
`git.*`、`artifact.*`、`report()`、`phase()`、`hole()`。子代理继承父会话的权限与模型，
可单独指定 provider/model/推理强度。

## 界面

- 左侧导航「工作流」：全局与已打开项目的流程列表；可填参数、查看详情/历史/源码、
  移动、删除，或通过对话修订。
- 运行卡片：按阶段展示子代理，支持停止、恢复、保存、再次运行；展开进入右侧竖向面板，
  点击子代理打开原生子会话。
- 完成卡片：真实耗时、tokens、子代理数、阶段数，以及交付物。
- 产物：Markdown/GFM、图片、隔离 HTML、PDF、下载，以及 report 驱动的表格、指标、
  看板、图表。

## 运行与存储

默认目录 `$DSH_HOME/workflows`（未设置时 `~/.dsh/workflows`）；项目流程存
`<项目根>/.dsh/workflows`。

- `saved/*.dwf.ts`：全局已保存流程
- `runs/<runId>/`：脚本、参数、计划、元信息、journal、事件、产物
- `transcripts/`：恢复/修订所需的子代理事件快照
- `settings.json`：模式、并发与模型设置

流程文件使用 YAML 注释块保存名称、说明、参数与 `whenToUse`；旧格式仍可读取。

## 开发

```sh
npm install
npm run build     # 由 src/client.jsx + src/workflow.css 生成 lib/client.js
npm test
npm run test:engine
```

`npm run preview` 在 `127.0.0.1:43179` 提供固定测试数据界面，不能替代原生桌面验收。

## License

MIT
