# dsh-workflow

以 MCode 源码为基准重写的 DSH 工作流插件。原实现备份在同级 `dsh-workflow-backup-20261019/`；用户脚本和历史保留。

## 开发

```sh
npm install
npm run build
npm test
npm run test:engine
```

`src/client.jsx`、`src/workflow.css` 是前端源码；`lib/client.js` 是生成的 ModuleLoader 包。修改 Host 后在插件详情中关闭并重新启用工作流组件。`npm run preview` 在 `127.0.0.1:43179` 提供固定测试数据界面，不能替代原生桌面验收。

## 使用

侧栏「工作流」展示全局和打开的项目，卡片提供详情、参数、历史、源码、移动、删除和通过对话修订。表单校验 string、number、boolean、JSON、必填项和默认值，在所选项目的新会话中直接启动。再次运行预填上次参数。

从工作流面板新建的运行会话自动命名为 `工作流名称-YYYYMMDDHHmmss`（例如 `flutter-dev-pipeline-20261019220905`），名称优先取保存的工作流名；仅内联脚本等完全无名称的运行退化为 `工作流-时间`。使用北京时间和实际运行开始时间；已有自定义标题保留。运行卡片使用宿主的 `plugin:dsh-workflow/run` 可忽略插件记录，重启后可读取历史，插件未安装时也不会阻断普通会话回放。

运行卡展示水平阶段和子代理，展开后进入右侧竖向阶段面板；点击子代理进入原生子会话。支持停止、恢复、并发/后续子代理模型配置、保存及再次运行。完成卡展示真实交付物和时间、tokens、子代理数、阶段数；缺失数据显示 `—`。

产物支持 Markdown/GFM、图片、隔离 HTML、PDF、下载，以及 report 驱动的表格、指标、看板和图表。

## 执行与存储

MCode 编译器、schema、分析、引擎、重放与修订缓存保留在 `vendor/`。脚本通过独立 Node 子进程与 VM 单元执行。DSH adapter 负责原生子代理、权限/模型继承、取消、转录、真实用量及完成通知。工具及外层传输成功后才提交结果，类型错误与遗漏提交按上游预算处理。文件/Git/命令使用 MCode world ports。

默认目录为 `$DSH_HOME/workflows`，未设置时使用 `~/.dsh/workflows`：

- `saved/*.dwf.ts`：全局工作流。
- 项目 `.dsh/workflows/*.dwf.ts`：项目工作流；兼容读取 `.zcode/workflows`。
- `runs/<runId>/`：脚本、参数、计划、元信息、journal、事件、产物。
- `transcripts/`：恢复与修订需要的子代理事件快照。
- `settings.json`：模式、默认并发及模型设置。

元数据使用 MCode `/* zcode-workflow ... */` YAML，兼容旧 `@description` / `@arg`。恢复保留原参数和模型。修订只复用具备转录边界的已完成缓存。

旧版本写入 `dsh-workflow/run` 导致历史读取失败时，可在关闭 DSH 后运行 `node scripts/repair-session-records.mjs <dsh-home> <backup-directory>` 预览修复，追加 `--apply` 执行。脚本仅修复工作流锚点并给无标题的运行会话补名，保留事件序号与内容，先备份原始压缩日志，再原子替换；需要本机 `zstd` 命令。重复运行不会重复追加标题。

工具：`workflow_compile`、`workflow_create_run`、`workflow_save`、`workflow_list_saved`、`workflow_get_saved`、`workflow_delete_saved`、`workflow_get_run`、`workflow_status`、`workflow_runs`、`workflow_stop`、`workflow_resume`、`workflow_amend`、`workflow_asks`、`workflow_submit_ask`、`workflow_holes`、`workflow_fill_hole`、`workflow_graphs`。

尚未完成的 1:1 差异与验证边界见 [对照清单](spec/mcode-parity.md)，测试见 [SELFTEST](SELFTEST.md)。
