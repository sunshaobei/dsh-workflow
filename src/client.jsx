import React, {
  useState,
  useEffect,
  useRef,
  useContext,
  useSyncExternalStore,
  createContext,
} from "react";
import css from "./workflow.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workflowRunId } from "../lib/session-records.js";

const Context = createContext(null);
const BASE = "/_dsh/dsh-workflow";
const STATUS = {
  pending: "尚未开始",
  running: "运行中",
  completed: "已完成",
  errored: "运行失败",
  stopped: "已停止",
};
const COLORS = [
  "#50b5a5",
  "#f5a12b",
  "#6761eb",
  "#8d58ed",
  "#3c83f5",
  "#ed7628",
];
export async function api(path, body, signal) {
  const response = await fetch(BASE + path, {
    credentials: "same-origin",
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false)
    throw new Error(data.error ?? "操作失败");
  return data;
}
export const action = (body) => api("/action", body);
const cache = new Map(),
  subscribers = new Map(),
  inflight = new Map();
function emit(key) {
  for (const f of subscribers.get(key) ?? []) f();
}
async function refresh(key) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = api(key)
    .then((data) => {
      cache.set(key, { data, error: null });
      emit(key);
    })
    .catch((error) => {
      cache.set(key, { data: cache.get(key)?.data, error: error.message });
      emit(key);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
const EMPTY = { data: null, error: null };
export function useData(key) {
  const state = useSyncExternalStore(
    (f) => {
      if (!key) return () => {};
      const listeners = subscribers.get(key) ?? new Set();
      subscribers.set(key, listeners);
      listeners.add(f);
      return () => {
        listeners.delete(f);
        if (!listeners.size) subscribers.delete(key);
      };
    },
    () => cache.get(key) ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    if (key) refresh(key);
  }, [key]);
  return { ...state, refresh: () => refresh(key) };
}
function refreshAll() {
  return Promise.all([...subscribers.keys()].map(refresh));
}
export function Icon({ name = "workflow", size = 16, ...props }) {
  const paths = {
    workflow: "M4 3h6v6H4zM15 15h6v6h-6zM7 9v6a3 3 0 0 0 3 3h5",
    play: "m8 4 12 8-12 8Z",
    stop: "M5 5h14v14H5z",
    refresh: "M20 7a9 9 0 1 0 1 8M21 3v6h-6",
    resume: "M3 11a9 9 0 1 1 2.8 7M3 4v7h7",
    plus: "M12 4v16M4 12h16",
    close: "m5 5 14 14M19 5 5 19",
    back: "m14 5-7 7 7 7",
    down: "m6 9 6 6 6-6",
    next: "m9 5 7 7-7 7",
    expand: "M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7",
    settings: "M4 6h8m4 0h4M4 12h3m4 0h9M4 18h10m4 0h2M12 3v6M7 9v6M14 15v6",
    check: "m5 12 4 4L19 6",
    file: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6",
    clock: "M12 7v6l4 2",
    copy: "M9 8h11v13H9zM15 8V3H4v13h5",
    trash: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    more: "M4 12h.01M12 12h.01M20 12h.01",
    code: "m8 5-6 7 6 7m8-14 6 7-6 7",
    calendar: "M4 5h16v16H4zM4 10h16M8 2v6M16 2v6",
    warning: "m12 3 10 18H2zM12 9v5M12 17h.01",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {name === "clock" && <circle cx="12" cy="12" r="9" />}
      <path d={paths[name] ?? paths.workflow} />
    </svg>
  );
}
function Button({
  icon,
  children,
  title,
  primary,
  danger,
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`wf-btn ${primary ? "wf-primary" : ""} ${danger ? "wf-danger" : ""} ${!children ? "wf-icon-btn" : ""} ${className}`}
      title={title}
      aria-label={!children ? title : undefined}
      {...props}
    >
      {icon && <Icon name={icon} />} {children}
    </button>
  );
}
function ErrorLine({ error }) {
  return error ? (
    <div role="alert" className="wf-error">
      <Icon name="warning" />
      {error}
    </div>
  ) : null;
}
function Empty({ children }) {
  return <p className="wf-empty">{children}</p>;
}
function Status({ value, compact = false }) {
  return (
    <span className={`wf-status wf-${value}`}>
      <i className={`wf-lamp wf-${value}`} />
      {!compact && (STATUS[value] ?? value)}
    </span>
  );
}
export function formatCount(n) {
  return n === undefined
    ? "—"
    : n < 1000
      ? String(n)
      : n < 1e6
        ? `${(n / 1000).toFixed(1)}k`
        : `${(n / 1e6).toFixed(2)}M`;
}
export function duration(ms) {
  if (ms == null) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function relative(time) {
  if (!time) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - Number(time)) / 1000));
  return seconds < 60
    ? "刚刚"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} 小时前`
        : `${Math.floor(seconds / 86400)} 天前`;
}
function useOperation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const perform = async (fn, done) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      await refreshAll();
      done?.(r);
      return r;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, perform, clear: () => setError(null) };
}
export function Modal({ title, children, onClose, wide }) {
  const ref = useRef(),
    titleId = React.useId();
  useEffect(() => {
    const last = document.activeElement;
    ref.current?.querySelector("input,textarea,select,button")?.focus();
    function key(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const els = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          ),
        ];
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      last?.focus?.();
    };
  }, []);
  return (
    <div
      className="wf-modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={`wf-modal ${wide ? "wf-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <Button icon="close" title="关闭" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}
function Menu({ items }) {
  const [open, setOpen] = useState(false),
    ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const escape = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="wf-menu-wrap" ref={ref}>
      <Button
        icon="more"
        title="更多操作"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className="wf-menu" role="menu">
          {items.filter(Boolean).map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "wf-danger" : ""}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon && <Icon name={item.icon} />} {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Face({ index, status }) {
  return (
    <span
      className={`wf-face ${status === "running" ? "wf-working" : ""}`}
      style={{ background: COLORS[index % COLORS.length] }}
    >
      <b />
      <b />
      {status === "pending" && <b />}
    </span>
  );
}
function actorColor(run, actor) {
  const i = (run.actors ?? []).findIndex((a) => a.siteId === actor.siteId);
  if (i >= 0) return i;
  const n = /#(\d+)/.exec(actor.siteId ?? "")?.[1];
  return n ? Number(n) - 1 : 0;
}
function AgentPill({ actor, run }) {
  const ctx = useContext(Context);
  return (
    <button
      className={`wf-agent wf-agent-${actor.status}`}
      disabled={!actor.sessionId}
      onClick={() => ctx.openActor(run, actor)}
      title={
        actor.sessionId
          ? `打开 ${actor.name} 的对话`
          : `${actor.name} · 尚未开始`
      }
    >
      <Face index={actorColor(run, actor)} status={actor.status} />
      <span>{actor.name ?? "子代理"}</span>
      {actor.tasks > 0 && <small>{actor.tasks} 个任务</small>}
      {actor.status === "running" ? (
        <svg className="wf-spinner" viewBox="0 0 16 16" aria-label="运行中">
          <circle className="wf-spinner-track" cx="8" cy="8" r="6" />
          <circle className="wf-spinner-arc" cx="8" cy="8" r="6" />
        </svg>
      ) : actor.status === "completed" ? (
        <span className="wf-agent-check">✓</span>
      ) : actor.status === "errored" ? (
        <Icon name="warning" />
      ) : null}
    </button>
  );
}
export function Timeline({ run, showDetails = true }) {
  const ref = useRef(),
    [hidden, setHidden] = useState(0);
  useEffect(() => {
    const active = ref.current?.querySelector('[data-active="true"]');
    if (active)
      active.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
  }, [run.activePhase]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setHidden(
        Math.max(
          0,
          Math.ceil(
            (el.scrollWidth - el.clientWidth - el.scrollLeft - 4) / 192,
          ),
        ),
      );
    const observer = new ResizeObserver(check);
    observer.observe(el);
    el.addEventListener("scroll", check);
    check();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [run.phases.length]);
  return (
    <div className={`wf-timeline-frame ${showDetails ? "" : "wf-timeline-compact"}`}>
      <div className="wf-timeline" ref={ref}>
        {run.phases.map((phase, i) => (
          <section
            className="wf-station"
            key={phase.id}
            data-active={phase.status === "running"}
          >
            <div className="wf-station-head">
              <i className={`wf-lamp wf-${phase.status}`} />
              <strong title={phase.name}>{phase.name}</strong>
              <span>
                {phase.completed}/{phase.total}
              </span>
              {i < run.phases.length - 1 && <i className="wf-connector" />}
            </div>
            {showDetails && <div className="wf-pills">
              {phase.actors.map((actor) => (
                <AgentPill key={actor.id} actor={actor} run={run} />
              ))}
              {phase.nodes
                .filter((n) => n.kind !== "ask")
                .map((n) => (
                  <div className="wf-world" key={n.siteId + n.ordinal}>
                    <Icon name="code" />
                    <span>{n.input?.op ?? "执行脚本"}</span>
                    <Status
                      value={n.status === "failed" ? "errored" : n.status}
                      compact
                    />
                  </div>
                ))}
            </div>}
          </section>
        ))}
      </div>
      {hidden > 0 && (
        <button
          className="wf-timeline-more"
          aria-label={`向右查看其余 ${hidden} 个阶段`}
          onClick={() =>
            ref.current.scrollBy({ left: 192, behavior: "smooth" })
          }
        >
          {Array.from({ length: Math.min(hidden, 5) }, (_, i) => (
            <i
              key={i}
              className={`wf-lamp wf-${run.phases[run.phases.length - hidden + i]?.status ?? "pending"}`}
            />
          ))}
        </button>
      )}
    </div>
  );
}
function SettingsDialog({ run, settings, onClose }) {
  const models = useData("/models"),
    [model, setModel] = useState(run?.model ?? settings?.model ?? ""),
    [reasoning, setReasoning] = useState(
      run?.reasoningEffort ?? settings?.reasoningEffort ?? "",
    );
  const op = useOperation(),
    [limit, setLimit] = useState(
      run?.caps?.maxConcurrency ?? settings?.maxConcurrency ?? 4,
    ),
    [mode, setMode] = useState(settings?.mode ?? "alwaysOn");
  return (
    <Modal title={run ? "运行配置" : "工作流设置"} onClose={onClose}>
      {!run && (
        <fieldset className="wf-mode-options">
          <legend>何时使用工作流</legend>
          {[
            ["alwaysOn", "始终开启", "代理可以主动创建与运行工作流。"],
            ["onDemand", "按需开启", "仅在你明确要求工作流时使用。"],
            ["disabled", "关闭", "保留已保存的工作流和运行历史。"],
          ].map(([value, label, desc]) => (
            <label key={value}>
              <input
                type="radio"
                name="mode"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span>
                <strong>{label}</strong>
                <small>{desc}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="wf-field">
        最大并发子代理数
        <input
          type="number"
          min="1"
          max="64"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <small>调整仅影响接下来启动的任务，已开始的任务会继续执行。</small>
      </label>
      <label className="wf-field">
        子代理模型
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">跟随会话模型</option>
          {models.data?.models.map((m) => (
            <option
              key={`${m.provider}/${m.id}`}
              value={`${m.provider}/${m.id}`}
            >
              {m.name} · {m.provider}
            </option>
          ))}
        </select>
        <small>对新建的子代理生效；已开始的子代理保留原模型。</small>
      </label>
      <label className="wf-field">
        推理强度
        <select
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
        >
          <option value="">跟随模型默认值</option>
          {["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(
            (level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ),
          )}
        </select>
      </label>
      <ErrorLine error={models.error ?? models.data?.errors?.join("；")} />
      <ErrorLine error={op.error} />
      <footer>
        <Button onClick={onClose}>取消</Button>
        <Button
          primary
          disabled={op.busy}
          onClick={() =>
            op.perform(
              () =>
                action(
                  run
                    ? {
                        action: "run-settings",
                        runId: run.runId,
                        settings: {
                          maxConcurrency: Number(limit),
                          model,
                          reasoningEffort: reasoning,
                        },
                      }
                    : {
                        action: "settings",
                        settings: {
                          mode,
                          maxConcurrency: Number(limit),
                          model,
                          reasoningEffort: reasoning,
                        },
                      },
                ),
              onClose,
            )
          }
        >
          保存
        </Button>
      </footer>
    </Modal>
  );
}
function SaveDialog({ run, onClose }) {
  const hub = useData("/hub"),
    [name, setName] = useState(run.savedName ?? run.name ?? ""),
    [description, setDescription] = useState(""),
    [groupId, setGroup] = useState(run.groupId ?? "global"),
    op = useOperation();
  return (
    <Modal title="保存工作流" onClose={onClose}>
      <p className="wf-muted">
        保存后可在「工作流」中填写参数再次运行。
      </p>
      <label className="wf-field">
        名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-workflow"
        />
      </label>
      <label className="wf-field">
        说明
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows="3"
        />
      </label>
      <label className="wf-field">
        保存到
        <select value={groupId} onChange={(e) => setGroup(e.target.value)}>
          {hub.data?.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <ErrorLine error={op.error} />
      <footer>
        <Button onClick={onClose}>取消</Button>
        <Button
          primary
          disabled={op.busy || !name.trim()}
          onClick={() =>
            op.perform(
              () =>
                action({
                  action: "save",
                  runId: run.runId,
                  name,
                  description,
                  groupId,
                }),
              onClose,
            )
          }
        >
          保存工作流
        </Button>
      </footer>
    </Modal>
  );
}
function RunActions({ run, open, settings, save, compact }) {
  const ctx = useContext(Context),
    op = useOperation();
  return (
    <>
      <div className="wf-run-actions">
        {run.savedName && (
          <span className="wf-saved-mark">
            <Icon name="check" size={12} />
            已保存
          </span>
        )}
        {run.status === "running" ? (
          <>
            <Button icon="settings" title="配置" onClick={settings}>
              {!compact && "配置"}
            </Button>
            <Button
              icon="stop"
              title="停止运行"
              disabled={op.busy}
              onClick={() =>
                op.perform(() => action({ action: "stop", runId: run.runId }))
              }
            >
              {!compact && "停止运行"}
            </Button>
          </>
        ) : (
          <>
            {run.resumable && (
              <Button
                icon="resume"
                title="继续运行：沿用当前运行和已完成步骤"
                disabled={op.busy}
                onClick={() => op.perform(() => ctx.resume(run))}
              >
                {!compact && "继续运行"}
              </Button>
            )}
            {!run.savedName && (
              <Button title="保存工作流" onClick={save}>
                保存
              </Button>
            )}
            {run.savedName && (
              <Button
                icon="play"
                title="再次运行：重新填写参数并新建运行"
                disabled={op.busy}
                onClick={() => op.perform(() => ctx.rerun(run))}
              >
                {!compact && "再次运行"}
              </Button>
            )}
          </>
        )}
        {open && <Button icon="expand" title="打开运行详情" onClick={open} />}
      </div>
      <ErrorLine error={op.error} />
    </>
  );
}
function ArtifactRow({ artifact, run, preview }) {
  const ctx = useContext(Context),
    bytes = useData(
      preview && artifact.uri
        ? `/artifact?runId=${encodeURIComponent(run.runId)}&id=${encodeURIComponent(artifact.id)}`
        : null,
    );
  const snippet = bytes.data?.artifact?.content?.slice(0, 500);
  return (
    <button
      className={`wf-artifact ${preview ? "wf-artifact-main" : ""}`}
      onClick={() => ctx.openArtifact(run, artifact)}
    >
      {preview && (
        <div className="wf-paper">
          <strong>{artifact.title ?? artifact.id}</strong>
          <p>
            {snippet ??
              artifact.preview ??
              artifact.description ??
              "点击查看完整内容"}
          </p>
        </div>
      )}
      <span className="wf-artifact-info">
        <strong>
          <span className="wf-markdown-icon">M↓</span>
          {artifact.title ?? artifact.id}
        </strong>
        {preview && (
          <>
            <span className="wf-clamp">
              {artifact.description ?? "工作流产出"}
            </span>
            <small>
              {artifact.kind === "markdown" ? "文档" : artifact.kind}{" "}
              {artifact.bytes != null
                ? `· ${(artifact.bytes / 1024).toFixed(1)} KB`
                : ""}
            </small>
          </>
        )}
      </span>
      <Icon name="expand" size={12} />
    </button>
  );
}
export function RunCard({ run, completion = false }) {
  const ctx = useContext(Context),
    [dialog, setDialog] = useState(null),
    [expanded, setExpanded] = useState(true);
  const kind = `工作流${STATUS[run.status] ?? ""}`;
  const toggleDetails = () => setExpanded((value) => !value);
  const isControl = (target, root) => {
    const control = target?.closest?.(
      "button, a, input, textarea, select, [role='button']",
    );
    return control != null && control !== root;
  };
  return (
    <section
      className="wf-run-card"
      {...(!completion && run.phases.length
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": expanded,
            "aria-label": `${kind} ${run.name}，${expanded ? "收起" : "展开"}子代理`,
            onClick: (event) => {
              if (!isControl(event.target, event.currentTarget)) toggleDetails();
            },
            onKeyDown: (event) => {
              if (
                (event.key === "Enter" || event.key === " ") &&
                !isControl(event.target, event.currentTarget)
              ) {
                event.preventDefault();
                toggleDetails();
              }
            },
          }
        : {})}
      data-testid={
        completion ? "workflow-completion-card" : "workflow-run-card"
      }
    >
      <header className="wf-card-head">
        <Icon />
        {completion ? (
          <button className="wf-kind" onClick={toggleDetails} aria-expanded={expanded}>
            {kind}
          </button>
        ) : (
          <span className="wf-kind">{kind}</span>
        )}
        <span className="wf-run-name" title={run.name}>
          {run.name}
        </span>
        {!completion && (
          <span className="wf-head-details">
            {run.phases.length} 个阶段 ·{" "}
            {run.status === "running"
              ? `${run.activeActors} 个子代理工作中`
              : `${run.actors.length} 个子代理`}
          </span>
        )}
        {completion && <Status value={run.status} />}
        <RunActions
          run={run}
          compact
          open={() => ctx.openRun(run)}
          settings={() => setDialog("settings")}
          save={() => setDialog("save")}
        />
      </header>
      {(expanded || !completion) && (
        <>
          {completion ? (
            <>
              <div className="wf-deliverables">
                {run.artifacts.length ? (
                  run.artifacts.map((a, i) => (
                    <ArtifactRow
                      key={a.id}
                      artifact={a}
                      run={run}
                      preview={i === 0}
                    />
                  ))
                ) : (
                  <Empty>本次运行没有发布交付物。</Empty>
                )}
              </div>
              <div className="wf-figures">
                {[
                  [duration(run.figures.durationMs), "时间"],
                  [formatCount(run.figures.tokens), "tokens"],
                  [run.figures.subagents ?? "—", "子代理"],
                  [run.figures.phases ?? "—", "阶段"],
                ].map(([value, label]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <Timeline run={run} showDetails={expanded} />
              {run.artifacts.length > 0 && (
                <div className="wf-artifact-strip">
                  {run.artifacts.map((a) => (
                    <ArtifactRow key={a.id} artifact={a} run={run} />
                  ))}
                </div>
              )}
            </>
          )}
          {run.failure && <ErrorLine error={run.failure.message} />}
        </>
      )}
      {dialog === "settings" && (
        <SettingsDialog run={run} onClose={() => setDialog(null)} />
      )}
      {dialog === "save" && (
        <SaveDialog run={run} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}
export function RunDetail({ runId }) {
  const { data, error } = useData(`/run?runId=${encodeURIComponent(runId)}`),
    [expanded, setExpanded] = useState({}),
    [dialog, setDialog] = useState(null),
    [tab, setTab] = useState("stages");
  const run = data?.run;
  useEffect(() => {
    if (run?.activePhase)
      setExpanded((old) => ({ ...old, [run.activePhase]: true }));
  }, [run?.activePhase]);
  if (!run)
    return (
      <div className="wf-pane">
        <ErrorLine error={error} />
        {!error && <Empty>正在加载运行…</Empty>}
      </div>
    );
  return (
    <div className="wf-pane" data-testid="workflow-run-detail">
      <header className="wf-detail-header">
        <div>
          <strong>{run.name}</strong>
          <RunActions
            run={run}
            settings={() => setDialog("settings")}
            save={() => setDialog("save")}
          />
        </div>
        <Status value={run.status} />
        <p className="wf-muted">
          {run.activeActors} 个子代理工作中 ·{" "}
          {
            run.nodes.filter(
              (n) => n.status === "completed" && n.kind === "ask",
            ).length
          }
          /{run.counts.asks} 步 · {formatCount(run.figures.tokens)} tokens
        </p>
        {run.stopReason && run.status === "stopped" && (
          <p className="wf-muted">
            {run.stopReason === "interrupted"
              ? "运行因应用关闭而中断，可从已完成步骤恢复。"
              : "已停止运行"}
          </p>
        )}
        <ErrorLine error={error ?? run.failure?.message} />
      </header>
      <nav className="wf-detail-nav">
        {[
          ["stages", "阶段"],
          ["artifacts", `产物 ${run.artifacts.length}`],
          ["reports", `报告 ${run.reports.length}`],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "stages" ? (
        <div className="wf-vertical">
          {run.phases.map((p, i) => {
            const open = expanded[p.name] ?? p.status === "running";
            return (
              <section
                key={p.id}
                className={`wf-vertical-stage wf-stage-${p.status}`}
              >
                <button
                  className="wf-vertical-heading"
                  onClick={() =>
                    setExpanded((old) => ({ ...old, [p.name]: !open }))
                  }
                  aria-expanded={open}
                >
                  <i className={`wf-lamp wf-${p.status}`} />
                  <strong>{p.name}</strong>
                  {open ? (
                    <small>
                      {p.completed}/{p.total}
                    </small>
                  ) : (
                    <span className="wf-mini-faces">
                      {p.actors.map((a) => (
                        <Face
                          key={a.id}
                          index={actorColor(run, a)}
                          status={a.status}
                        />
                      ))}
                    </span>
                  )}
                  <Icon name={open ? "down" : "next"} size={14} />
                </button>
                {open && (
                  <div className="wf-vertical-content">
                    {p.actors.map((a) => (
                      <AgentPill key={a.id} actor={a} run={run} />
                    ))}
                    {p.nodes
                      .filter((n) => n.kind !== "ask")
                      .map((n) => (
                        <details key={n.siteId + n.ordinal} className="wf-node">
                          <summary>
                            <Icon name="code" />
                            {n.input?.op ?? n.kind}
                            <Status value={n.status} />
                          </summary>
                          <pre>
                            {JSON.stringify(n.result ?? n.error, null, 2)}
                          </pre>
                        </details>
                      ))}
                    {p.rounds > 1 && (
                      <small className="wf-muted">已进入 {p.rounds} 轮</small>
                    )}
                    {!p.actors.length && !p.nodes.length && (
                      <Empty>此阶段尚未开始</Empty>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {(data.holes ?? []).map((h) => (
            <Hole key={h.siteId} hole={h} run={run} />
          ))}
        </div>
      ) : tab === "artifacts" ? (
        <div className="wf-pane-content">
          {run.artifacts.map((a) => (
            <ArtifactRow key={a.id} run={run} artifact={a} preview />
          ))}
          {!run.artifacts.length && <Empty>尚未发布产物</Empty>}
        </div>
      ) : (
        <div className="wf-pane-content">
          {run.reports.map((r, i) => (
            <pre className="wf-report" key={i}>
              {typeof r.item === "string"
                ? r.item
                : JSON.stringify(r.item, null, 2)}
            </pre>
          ))}
          {!run.reports.length && <Empty>尚无报告</Empty>}
        </div>
      )}
      {dialog === "settings" && (
        <SettingsDialog run={run} onClose={() => setDialog(null)} />
      )}
      {dialog === "save" && (
        <SaveDialog run={run} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
function Hole({ hole, run }) {
  const [code, setCode] = useState(""),
    op = useOperation();
  return (
    <details className="wf-hole">
      <summary>待补全：{hole.name ?? hole.siteId}</summary>
      <p>{hole.prompt}</p>
      <textarea
        aria-label="补全代码"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        rows="8"
      />
      <ErrorLine error={op.error} />
      <Button
        primary
        disabled={op.busy || !code.trim()}
        onClick={() =>
          op.perform(() =>
            action({
              action: "fill-hole",
              runId: run.runId,
              siteId: hole.siteId,
              code,
            }),
          )
        }
      >
        提交补全
      </Button>
    </details>
  );
}
export function ArtifactDetail({ runId, id }) {
  const { data, error } = useData(
      `/artifact?runId=${encodeURIComponent(runId)}&id=${encodeURIComponent(id)}`,
    ),
    [view, setView] = useState("preview");
  const item = data?.artifact;
  if (!item)
    return (
      <div className="wf-pane">
        <ErrorLine error={error} />
        {!error && <Empty>加载产物…</Empty>}
      </div>
    );
  const href = item.base64
    ? `data:${item.contentType};base64,${item.base64}`
    : `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(item.items ?? [], null, 2))}`;
  return (
    <div className="wf-pane wf-artifact-pane">
      <header className="wf-artifact-header">
        <strong>{item.title ?? item.id}</strong>
        <Button
          icon="code"
          title={view === "source" ? "预览" : "查看源码"}
          onClick={() => setView(view === "source" ? "preview" : "source")}
        />
        <a
          className="wf-btn"
          href={href}
          download={`${item.title ?? item.id}${item.kind === "markdown" ? ".md" : ""}`}
        >
          <Icon name="download" />
          下载
        </a>
      </header>
      <ErrorLine error={error} />
      {view === "source" ? (
        <pre className="wf-source">
          {item.content ?? JSON.stringify(item.items ?? item.spec, null, 2)}
        </pre>
      ) : item.contentType === "text/html" ? (
        <iframe
          title={item.title ?? item.id}
          sandbox=""
          srcDoc={item.content}
        />
      ) : item.contentType?.startsWith("image/") ? (
        <img className="wf-image" alt={item.title ?? item.id} src={href} />
      ) : item.contentType === "application/pdf" ? (
        <iframe title={item.title ?? item.id} src={href} />
      ) : item.contentType === "text/markdown" ? (
        <Markdown text={item.content ?? ""} />
      ) : item.items ? (
        <PresetArtifact item={item} />
      ) : (
        <pre className="wf-source">{item.content ?? "此文件可下载查看。"}</pre>
      )}
    </div>
  );
}
function Markdown({ text }) {
  return (
    <article className="wf-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </article>
  );
}
export function fieldValue(row, field) {
  return String(field ?? "")
    .split(".")
    .reduce((value, key) => value?.[key], row);
}
const displayValue = (value) =>
  value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
export function PresetArtifact({ item }) {
  const spec = item.spec ?? {},
    all = item.items ?? [];
  const rows = spec.key
    ? [...new Map(all.map((row) => [fieldValue(row, spec.key), row])).values()]
    : all;
  if (item.kind === "metrics")
    return (
      <div className="wf-metrics">
        {(spec.metrics ?? []).map((field) => {
          const row = [...rows]
            .reverse()
            .find((r) => fieldValue(r, field.field) !== undefined);
          return (
            <div key={field.field}>
              <small>{field.label ?? field.field}</small>
              <strong>
                {displayValue(fieldValue(row, field.field))}{" "}
                <small>{field.unit}</small>
              </strong>
            </div>
          );
        })}
      </div>
    );
  if (item.kind === "table")
    return (
      <div className="wf-table-wrap">
        <table>
          <thead>
            <tr>
              {spec.columns?.map((c) => (
                <th key={c.field}>{c.label ?? c.field}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {spec.columns?.map((c) => (
                  <td key={c.field}>
                    {displayValue(fieldValue(r, c.field))} {c.unit}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>等待工作流报告数据…</Empty>}
      </div>
    );
  if (item.kind === "board") {
    const columns = [...(spec.columns ?? [])];
    if (rows.some((r) => !columns.includes(fieldValue(r, spec.status))))
      columns.push("其他");
    return (
      <div className="wf-board">
        {columns.map((column) => (
          <section key={column}>
            <h3>{column}</h3>
            {rows
              .filter(
                (r) =>
                  (spec.columns?.includes(fieldValue(r, spec.status))
                    ? fieldValue(r, spec.status)
                    : "其他") === column,
              )
              .map((r, i) => (
                <article key={i}>
                  <strong>
                    {displayValue(fieldValue(r, spec.cardTitle ?? spec.key))}
                  </strong>
                  {spec.detail?.map((d) => (
                    <p key={d.field}>
                      {d.label ?? d.field}：
                      {displayValue(fieldValue(r, d.field))} {d.unit}
                    </p>
                  ))}
                </article>
              ))}
          </section>
        ))}
      </div>
    );
  }
  if (item.kind === "chart") return <ChartArtifact rows={rows} spec={spec} />;
  return (
    <div className="wf-pane-content">
      {rows.map((row, i) => (
        <pre key={i}>{JSON.stringify(row, null, 2)}</pre>
      ))}
    </div>
  );
}
function ChartArtifact({ rows, spec }) {
  const series = (Array.isArray(spec.y) ? spec.y : [spec.y]).filter(Boolean);
  const values = rows
    .flatMap((r) => series.map((s) => Number(fieldValue(r, s.field))))
    .filter((n) => Number.isFinite(n) && (spec.scale !== "log" || n > 0));
  if (!values.length) return <Empty>等待工作流报告图表数据…</Empty>;
  const transform = (n) => (spec.scale === "log" ? Math.log10(n) : n);
  const min =
      spec.scale === "log" ? Math.min(...values) : Math.min(0, ...values),
    max = spec.scale === "log" ? Math.max(...values) : Math.max(0, ...values);
  const range = transform(max) - transform(min) || 1;
  const y = (v) => 240 - ((transform(v) - transform(min)) / range) * 200;
  const x = (i) => 60 + (i * 500) / Math.max(1, rows.length - 1);
  const baseline =
    spec.baseline &&
    rows
      .map((r) => Number(fieldValue(r, spec.baseline.field)))
      .find(Number.isFinite);
  return (
    <div className="wf-chart">
      <svg
        viewBox="0 0 600 290"
        role="img"
        aria-label={spec.title ?? "工作流图表"}
      >
        <path
          d="M60 30V240H565"
          fill="none"
          stroke="currentColor"
          opacity=".3"
        />
        {[min, max].map((n, i) => (
          <text key={i} x="52" y={y(n) + 4} textAnchor="end">
            {Number(n.toPrecision(4))}
          </text>
        ))}
        {rows.map((r, i) => (
          <text key={i} x={x(i)} y="260" textAnchor="middle">
            {String(fieldValue(r, spec.x?.field) ?? i + 1).slice(0, 16)}
          </text>
        ))}
        {series.map((s, j) => {
          const points = rows
            .map((r, i) => ({ x: x(i), v: Number(fieldValue(r, s.field)), r }))
            .filter(
              (p) => Number.isFinite(p.v) && (spec.scale !== "log" || p.v > 0),
            );
          return (
            <g
              key={s.field}
              fill={COLORS[j % COLORS.length]}
              stroke={COLORS[j % COLORS.length]}
            >
              {spec.type !== "scatter" && spec.type !== "bar" && (
                <polyline
                  fill="none"
                  strokeWidth="2"
                  points={points.map((p) => `${p.x},${y(p.v)}`).join(" ")}
                />
              )}
              {points.map((p, i) =>
                spec.type === "bar" ? (
                  <rect
                    key={i}
                    x={p.x - 8 + j * 12}
                    y={Math.min(y(p.v), y(spec.scale === "log" ? min : 0))}
                    width="10"
                    height={Math.max(
                      1,
                      Math.abs(y(p.v) - y(spec.scale === "log" ? min : 0)),
                    )}
                  >
                    <title>
                      {s.label ?? s.field}: {p.v} {s.unit}
                    </title>
                  </rect>
                ) : (
                  <circle key={i} cx={p.x} cy={y(p.v)} r="3">
                    <title>
                      {s.label ?? s.field}: {p.v} {s.unit}
                    </title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
        {baseline !== undefined && (spec.scale !== "log" || baseline > 0) && (
          <line
            x1="60"
            x2="565"
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="currentColor"
            strokeDasharray="4 4"
          />
        )}
      </svg>
      <div className="wf-chart-legend">
        {series.map((s, i) => (
          <span key={s.field} style={{ color: COLORS[i % COLORS.length] }}>
            ● {s.label ?? s.field} {s.unit}
          </span>
        ))}
      </div>
    </div>
  );
}
export function LaunchDialog({ entry, groups, onClose, initialArgs }) {
  const ctx = useContext(Context),
    op = useOperation(),
    [values, setValues] = useState(
      Object.fromEntries(
        Object.entries(entry.args ?? {})
          .filter(
            ([k, s]) =>
              initialArgs?.[k] !== undefined || s.default !== undefined,
          )
          .map(([k, s]) => {
            const value = initialArgs?.[k] ?? s.default;
            return [
              k,
              s.type === "json" ? JSON.stringify(value, null, 2) : value,
            ];
          }),
      ),
    ),
    [target, setTarget] = useState(
      entry.scope === "project"
        ? entry.groupId
        : (groups.find((g) => g.scope === "project")?.id ?? ""),
    );
  const fields = Object.entries(entry.args ?? {});
  async function launch() {
    const args = {};
    for (const [key, spec] of fields) {
      const value = values[key];
      if (value === undefined || (value === "" && spec.type !== "string")) {
        if (spec.required && spec.default === undefined)
          throw new Error(`请填写 ${key}`);
        continue;
      }
      if (spec.required && value === "") throw new Error(`请填写 ${key}`);
      if (spec.type === "number") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
        args[key] = n;
      } else if (spec.type === "json") {
        try {
          args[key] = JSON.parse(value);
        } catch {
          throw new Error(`${key} 不是有效的 JSON`);
        }
      } else args[key] = value;
    }
    if (!target) throw new Error("请选择运行项目");
    await ctx.launch(entry, args, target);
  }
  return (
    <Modal title={`运行 ${entry.name}`} onClose={onClose}>
      <p className="wf-muted">{entry.description}</p>
      <label className="wf-field">
        运行项目
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={entry.scope === "project"}
        >
          <option value="" disabled>
            选择项目
          </option>
          {groups
            .filter((g) => g.scope === "project")
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </label>
      {fields.map(([key, spec]) => (
        <label className="wf-field" key={key}>
          <span>
            <code>{key}</code>
            {spec.required && <b className="wf-required"> *</b>}
            <small className="wf-type">{spec.type}</small>
          </span>
          {spec.type === "boolean" ? (
            <select
              value={values[key] === undefined ? "" : String(values[key])}
              onChange={(e) =>
                setValues({
                  ...values,
                  [key]:
                    e.target.value === ""
                      ? undefined
                      : e.target.value === "true",
                })
              }
            >
              <option value="">使用默认值</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : spec.type === "number" ? (
            <input
              type="number"
              value={values[key] ?? ""}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          ) : (
            <textarea
              rows={spec.type === "json" ? 4 : 2}
              value={values[key] ?? ""}
              placeholder={
                spec.default !== undefined ? `默认：${spec.default}` : ""
              }
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          )}
          <small>{spec.description}</small>
        </label>
      ))}
      {!fields.length && <Empty>此工作流不需要填写参数。</Empty>}
      <ErrorLine error={op.error} />
      <footer>
        <Button onClick={onClose}>取消</Button>
        <Button
          primary
          icon="play"
          disabled={op.busy || !target}
          onClick={() => op.perform(launch, onClose)}
        >
          {op.busy ? "正在启动…" : "运行工作流"}
        </Button>
      </footer>
    </Modal>
  );
}
function SavedCard({ entry, lastRun, onOpen, onRun, onMenu }) {
  return (
    <article
      className="wf-saved-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="workflow-saved-card"
    >
      <div className="wf-saved-title">{entry.name}</div>
      <div
        className="wf-saved-actions"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Button icon="play" onClick={onRun}>
          运行
        </Button>
        <Menu items={onMenu} />
      </div>
      <p className="wf-clamp">{entry.description}</p>
      <footer>
        <span>
          {lastRun ? (
            <>
              <Status value={lastRun.status} />
              <small> · {relative(lastRun.startedAt)}</small>
            </>
          ) : (
            "尚未运行"
          )}
        </span>
        <span className="wf-arg-chips">
          {Object.keys(entry.args ?? {})
            .slice(0, 3)
            .map((k) => (
              <code key={k}>{k}</code>
            ))}
          {Object.keys(entry.args ?? {}).length > 3 && (
            <small>+{Object.keys(entry.args).length - 3}</small>
          )}
        </span>
      </footer>
    </article>
  );
}
function SavedDetail({ entry, runs, onBack, onRun, onRevise }) {
  const ctx = useContext(Context),
    source = useData(
      `/saved?name=${encodeURIComponent(entry.name)}&groupId=${encodeURIComponent(entry.groupId)}`,
    ),
    [tab, setTab] = useState("history");
  return (
    <>
      <Button icon="back" onClick={onBack}>
        工作流
      </Button>
      <header className="wf-saved-detail-head">
        <div>
          <h1>{entry.name}</h1>
          <p className="wf-muted">{entry.description}</p>
        </div>
        <Button onClick={onRevise}>通过对话修订</Button>
        <Button primary icon="play" onClick={onRun}>
          运行
        </Button>
      </header>
      <p className="wf-path">{entry.path}</p>
      {entry.whenToUse && <p>{entry.whenToUse}</p>}
      <nav className="wf-detail-nav">
        {[
          ["history", "运行历史"],
          ["args", "参数"],
          ["source", "工作流脚本"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "args" ? (
        <div className="wf-table-wrap">
          <table>
            <thead>
              <tr>
                <th>参数</th>
                <th>类型</th>
                <th>说明</th>
                <th>默认值</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(entry.args ?? {}).map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                    {v.required && " *"}
                  </td>
                  <td>{v.type}</td>
                  <td>{v.description}</td>
                  <td>
                    {v.default === undefined ? "—" : JSON.stringify(v.default)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === "source" ? (
        <>
          <ErrorLine error={source.error} />
          <pre className="wf-source">
            {source.data?.entry?.source ?? "正在加载…"}
          </pre>
        </>
      ) : (
        <div className="wf-history">
          {runs.length ? (
            runs.map((run) => (
              <button
                key={run.runId}
                className="wf-history-row"
                onClick={() => ctx.openRun(run)}
              >
                <Status value={run.status} />
                <span>{new Date(run.startedAt).toLocaleString()}</span>
                <span>
                  {run.finishedAt
                    ? duration(run.finishedAt - run.startedAt)
                    : "运行中"}
                </span>
                <Icon name="next" />
              </button>
            ))
          ) : (
            <Empty>尚未运行此工作流。</Empty>
          )}
        </div>
      )}
    </>
  );
}
export function Hub() {
  const ctx = useContext(Context),
    { data, error, refresh } = useData("/hub"),
    [detail, setDetail] = useState(null),
    [dialog, setDialog] = useState(null),
    [toast, setToast] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    op = useOperation();
  const groups = data?.groups ?? [],
    runs = data?.runs ?? [];
  const entries = groups.flatMap((g) => g.entries);
  const selected =
    detail &&
    entries.find((e) => e.name === detail.name && e.groupId === detail.groupId);
  const history = (entry) =>
    runs.filter(
      (r) =>
        (r.savedName ?? r.name) === entry.name &&
        (r.groupId ?? "global") === entry.groupId,
    );
  const create = (group) =>
    ctx.draft(
      group.scope === "project" ? group.id : undefined,
      `请和我一起创建一个可复用的 TypeScript 工作流。使用 workflow_compile 校验，并在确认后用 workflow_save 保存到 ${group.id === "global" ? "全局" : group.name}（groupId: ${group.id}）。先问清楚我要完成什么。`,
    );
  const revise = (entry) =>
    ctx.draft(
      entry.scope === "project" ? entry.groupId : undefined,
      `请读取并修订工作流 ${entry.name}（groupId: ${entry.groupId}，路径：${entry.path}）。先和我确认要修改的内容，再编译并保存。`,
    );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  const menu = (entry) => [
    { label: "查看详情", onClick: () => setDetail(entry) },
    { label: "通过对话修订", onClick: () => revise(entry) },
    {
      label: "复制路径",
      icon: "copy",
      onClick: () =>
        op.perform(async () => {
          await navigator.clipboard.writeText(entry.path);
          setToast("已复制工作流路径");
        }),
    },
    {
      label: entry.scope === "global" ? "移到项目…" : "提升为全局",
      onClick: () => setDialog({ kind: "move", entry }),
    },
    {
      label: "删除",
      icon: "trash",
      danger: true,
      onClick: () => setDialog({ kind: "delete", entry }),
    },
  ];
  return (
    <main className="wf-hub" data-testid="workflow-hub">
      {selected ? (
        <SavedDetail
          entry={selected}
          runs={history(selected)}
          onBack={() => setDetail(null)}
          onRun={() => setDialog({ kind: "launch", entry: selected })}
          onRevise={() => revise(selected)}
        />
      ) : (
        <>
          <header className="wf-hub-header">
            <h1>
              <span>工作流</span>
            </h1>
            <p>保存在已打开项目里的工作流，填好参数就能再跑一次。</p>
          </header>
          <div className="wf-hub-toolbar">
            <strong>
              已保存的工作流 <span>{entries.length}</span>
            </strong>
            <span className="wf-flex" />
            <Button
              icon="settings"
              onClick={() => setDialog({ kind: "settings" })}
            >
              工作流设置{" "}
              <small>
                {
                  {
                    alwaysOn: "始终开启",
                    onDemand: "按需开启",
                    disabled: "关闭",
                  }[data?.settings.mode]
                }
              </small>
            </Button>
            <Button
              icon="refresh"
              className={refreshing ? "wf-refreshing" : ""}
              title="刷新工作流"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await refresh();
                setRefreshing(false);
              }}
            />
          </div>
          {!data && !error && <Empty>正在读取工作流…</Empty>}
          {groups.map((group) => (
            <section className="wf-group" key={group.id}>
              <header>
                <h2>
                  {group.name}{" "}
                  {group.id === "global" ? (
                    <span className="wf-scope-badge">对所有项目可见</span>
                  ) : (
                    <small>{group.entries.length || ""}</small>
                  )}
                </h2>
                <Button primary icon="plus" onClick={() => create(group)}>
                  通过对话创建
                </Button>
              </header>
              {group.entries.length ? (
                <div className="wf-saved-grid">
                  {group.entries.map((entry) => (
                    <SavedCard
                      key={entry.name}
                      entry={entry}
                      lastRun={history(entry)[0]}
                      onOpen={() => setDetail(entry)}
                      onRun={() => setDialog({ kind: "launch", entry })}
                      onMenu={menu(entry)}
                    />
                  ))}
                </div>
              ) : (
                <Empty>
                  {group.id === "global"
                    ? "还没有全局工作流。适合放不依赖某个项目的流程，例如深度调研。"
                    : "这个项目还没有保存的工作流。通过对话创建一个吧。"}
                </Empty>
              )}
              {group.errors.map((e) => (
                <ErrorLine key={e.file} error={`${e.file}：${e.error}`} />
              ))}
            </section>
          ))}
        </>
      )}
      <ErrorLine error={error ?? op.error} />
      {dialog?.kind === "settings" && (
        <SettingsDialog
          settings={data?.settings}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "launch" && (
        <LaunchDialog
          entry={dialog.entry}
          groups={groups}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <Modal
          title={`删除 ${dialog.entry.name}？`}
          onClose={() => setDialog(null)}
        >
          <p>删除保存的工作流文件，已有运行记录和交付物仍会保留。</p>
          <ErrorLine error={op.error} />
          <footer>
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              danger
              disabled={op.busy}
              onClick={() =>
                op.perform(
                  () =>
                    action({
                      action: "delete-saved",
                      name: dialog.entry.name,
                      groupId: dialog.entry.groupId,
                    }),
                  () => {
                    setDialog(null);
                    setDetail(null);
                  },
                )
              }
            >
              删除工作流
            </Button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === "move" && (
        <MoveDialog
          entry={dialog.entry}
          groups={groups}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && (
        <div role="status" className="wf-toast">
          {toast}
        </div>
      )}
    </main>
  );
}
function MoveDialog({ entry, groups, onClose }) {
  const [target, setTarget] = useState(
      entry.scope === "project"
        ? "global"
        : (groups.find((g) => g.scope === "project")?.id ?? ""),
    ),
    op = useOperation();
  return (
    <Modal
      title={entry.scope === "global" ? "移到项目" : "提升为全局"}
      onClose={onClose}
    >
      <p className="wf-muted">{entry.name}</p>
      <label className="wf-field">
        目标位置
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {groups
            .filter((g) => g.id !== entry.groupId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </label>
      <ErrorLine error={op.error} />
      <footer>
        <Button onClick={onClose}>取消</Button>
        <Button
          primary
          disabled={op.busy || !target}
          onClick={() =>
            op.perform(
              () =>
                action({
                  action: "move-saved",
                  name: entry.name,
                  groupId: entry.groupId,
                  targetGroupId: target,
                }),
              onClose,
            )
          }
        >
          移动
        </Button>
      </footer>
    </Modal>
  );
}
export function ToolCard(props) {
  let output = {},
    args = {};
  try {
    output = JSON.parse(
      (props.block?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  } catch {}
  try {
    args = JSON.parse(
      props.block?.call?.argsRaw ?? props.block?.argsRaw ?? "{}",
    );
  } catch {}
  const hub = useData("/runs");
  const runId =
    output.runId ??
    output.newRunId ??
    output.run?.runId ??
    hub.data?.runs.find(
      (r) =>
        r.toolCallId === props.callId && r.parentSessionId === props.sessionId,
    )?.runId;
  const state = useData(
    runId ? `/run?runId=${encodeURIComponent(runId)}` : null,
  );
  const run = state.data?.run ?? output.run;
  if (run) return <RunCard run={run} />;
  return (
    <details className="wf-run-card" open={props.block?.isError}>
      <summary>
        <Icon />
        {props.toolName === "workflow_save"
          ? "保存工作流"
          : props.toolName === "workflow_compile"
            ? "工作流编译"
            : "工作流"}{" "}
        {args.name ?? ""}
      </summary>
      <ErrorLine error={state.error ?? output.error} />
      <pre>
        {props.block?.isError
          ? (props.block.content ?? []).map((c) => c.text).join("\n")
          : JSON.stringify(output, null, 2)}
      </pre>
    </details>
  );
}
function CompletionTail({ sessionId, turn, seq }) {
  const { data } = useData("/runs");
  return (
    <>
      {data?.runs
        .filter(
          (r) =>
            r.parentSessionId === sessionId &&
            r.status === "completed" &&
            r.completionSeq >= (turn.start?.seq ?? Infinity) &&
            r.completionSeq <= seq,
        )
        .map((r) => (
          <LiveCompletion key={r.runId} runId={r.runId} />
        ))}
    </>
  );
}
function LiveCompletion({ runId }) {
  const { data } = useData(`/run?runId=${encodeURIComponent(runId)}`);
  return data?.run ? <RunCard run={data.run} completion /> : null;
}
function MiniRail({ sessionId }) {
  const { data } = useData("/runs"),
    run = data?.runs.find(
      (r) => r.parentSessionId === sessionId && r.status === "running",
    );
  const detail = useData(
      run ? `/run?runId=${encodeURIComponent(run.runId)}` : null,
    ),
    ctx = useContext(Context);
  if (!detail.data?.run) return null;
  const r = detail.data.run;
  return (
    <button
      className="wf-mini-rail"
      onClick={(e) => {
        e.stopPropagation();
        ctx.openRun(r);
      }}
    >
      <Icon size={12} />
      {r.phases.map((p) => (
        <i key={p.id} className={`wf-lamp wf-${p.status}`} />
      ))}
      <span>{r.activePhase}</span>
    </button>
  );
}
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

export function flushPendingOpen(pending, sessionId, openResource) {
  if (!pending || pending.sessionId !== sessionId) return pending;
  openResource(pending.address, { kind: "workflow" });
  return undefined;
}
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div
          style={{
            padding: 24,
            color: "#e5484d",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          工作流面板渲染出错：
          {String(this.state.error?.stack || this.state.error)}
        </div>
      );
    return this.props.children;
  }
}
export function Root({ context, children, fill = false }) {
  const mounted = useSyncExternalStore(
    context.sidebarMounted?.subscribe ?? noSubscribe,
    context.sidebarMounted?.getSnapshot ?? noSnapshot,
    noSnapshot,
  );
  useEffect(() => {
    context.flushOpen?.(mounted);
  }, [context, mounted]);
  const [scheme, setScheme] = useState(
    () => context.theme?.getTheme().active.colorScheme ?? "dark",
  );
  useEffect(
    () =>
      context.onTheme?.(() =>
        setScheme(context.theme?.getTheme().active.colorScheme ?? "dark"),
      ),
    [context],
  );
  return (
    <Context.Provider value={context}>
      <ErrorBoundary>
        <div
          className={`wf-root${fill ? " wf-root-fill" : ""}`}
          data-theme={scheme}
        >
          {children}
        </div>
      </ErrorBoundary>
    </Context.Provider>
  );
}
export const inject = [
  "slots",
  "theme",
  "uiWorkspace",
  "sessions",
  "uiConversation",
  "sidebarRight",
  "sidebarRightTabs",
  "layout",
];
export function startWorkflowDraft(uiWorkspace, groupId, prompt) {
  uiWorkspace.startSession(groupId, { prompt, clearPreviousDraft: true });
}
export function apply(ctx) {
  let pendingOpen;
  const openResource = (run) => {
    const address = `dsh-resource://workflow/${encodeURIComponent(run.runId)}`;
    if (ctx.sidebarRight.mounted.getSnapshot() === run.parentSessionId)
      ctx.sidebarRight.openResource(address, { kind: "workflow" });
    else {
      pendingOpen = { sessionId: run.parentSessionId, address };
      ctx.uiWorkspace.openSession(run.parentSessionId);
    }
  };
  const context = {
    sidebarMounted: ctx.sidebarRight.mounted,
    flushOpen: (sessionId) => {
      pendingOpen = flushPendingOpen(
        pendingOpen,
        sessionId,
        ctx.sidebarRight.openResource.bind(ctx.sidebarRight),
      );
    },
    theme: ctx.theme,
    onTheme: (fn) => ctx.on("theme/change", fn),
    draft: (groupId, prompt) =>
      startWorkflowDraft(ctx.uiWorkspace, groupId, prompt),
    async launch(entry, args, workspaceId) {
      const sessionId = await ctx.sessions.create({ workspaceId });
      await ctx.sessions.using(
        sessionId,
        { source: "dsh-workflow.launch" },
        async (ref) => {
          await ref.ready;
          const { result } = await action({
            action: "create-run",
            savedName: entry.name,
            groupId: entry.groupId,
            args,
            parentSessionId: sessionId,
          });
          openResource({ runId: result.runId, parentSessionId: sessionId });
        },
      );
    },
    resume: async (run) => {
      ctx.uiWorkspace.openSession(run.parentSessionId);
      return ctx.sessions.using(
        run.parentSessionId,
        { source: "dsh-workflow.resume" },
        async (ref) => {
          await ref.ready;
          return action({ action: "resume", runId: run.runId });
        },
      );
    },
    rerun: async (run) => {
      const hub = await api("/hub");
      const entry = hub.groups
        .flatMap((g) => g.entries)
        .find(
          (e) =>
            e.name === run.savedName && e.groupId === (run.groupId ?? "global"),
        );
      if (!entry) throw new Error("保存的工作流不存在，请重新保存后再运行");
      if (entry) {
        currentLaunch = { ...entry, initialArgs: run.args };
        ctx.layout.selectPanel("workflows");
        launchListeners.forEach((f) => f());
      }
    },
    openRun: openResource,
    openActor: (run, actor) =>
      ctx.sidebarRight.openResource(
        `dsh-resource://subagentchat/session/${encodeURIComponent(actor.sessionId)}?parent=${encodeURIComponent(run.parentSessionId)}&mode=continuable`,
        { kind: "subagentchat" },
      ),
    openArtifact: (run, artifact) =>
      ctx.sidebarRight.openResource(
        `dsh-resource://workflow-artifact/${encodeURIComponent(run.runId)}/${encodeURIComponent(artifact.id)}`,
        { kind: "workflow-artifact" },
      ),
  };
  let currentLaunch = null;
  const launchListeners = new Set();
  function Page() {
    const [entry, setEntry] = useState(currentLaunch);
    const hub = useData("/hub");
    useEffect(() => {
      const listener = () => setEntry(currentLaunch);
      launchListeners.add(listener);
      return () => launchListeners.delete(listener);
    }, []);
    return (
      <Root context={context} fill>
        <Hub />
        {entry && (
          <LaunchDialog
            entry={entry}
            initialArgs={entry.initialArgs}
            groups={hub.data?.groups ?? []}
            onClose={() => {
              currentLaunch = null;
              setEntry(null);
            }}
          />
        )}
      </Root>
    );
  }
  const wrap = (Component) => (props) => (
    <Root context={context}>
      <Component {...props} />
    </Root>
  );
  const register = (name, options, Component) =>
    ctx.slots.inject(name, () =>
      ctx.slots.register({ name, ...options }, Component),
    );
  register(
    "sidebar.panellist",
    { id: "workflows", order: 5, label: () => "工作流" },
    () => <Icon />,
  );
  register("main", { key: "workflows" }, Page);
  for (const key of [
    "workflow_create_run",
    "workflow_get_run",
    "workflow_resume",
    "workflow_amend",
    "workflow_save",
    "workflow_compile",
  ])
    register("tool.call.toolview", { key }, wrap(ToolCard));
  ctx.uiConversation.events.register({
    kind: "dsh-workflow-run",
    target: "chat",
    match: (event) =>
      workflowRunId(event)
        ? { id: workflowRunId(event), role: "start" }
        : null,
    start: (_context, match) => ({
      runId: match.event.data.runId,
      seq: match.event.seq,
    }),
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state
        ? {
            key: context.key,
            id: context.id,
            kind: "dsh-workflow-run",
            target: "chat",
            anchorSeq: context.state.seq,
            location: { kind: "session" },
            visibility: "visible",
            data: context.state,
          }
        : null,
  });
  register(
    "conversation.chat.node",
    { key: "dsh-workflow-run" },
    wrap(function WorkflowNode({ node }) {
      const state = useData(
        `/run?runId=${encodeURIComponent(node.data.runId)}`,
      );
      return state.data?.run ? (
        <RunCard run={state.data.run} />
      ) : (
        <ErrorLine error={state.error} />
      );
    }),
  );
  register(
    "conversation.chat.turnTail",
    { id: "dsh-workflow.completion", order: 80 },
    wrap(CompletionTail),
  );
  register(
    "sidebar.session.row.hover",
    { id: "dsh-workflow.progress", order: 50 },
    wrap(MiniRail),
  );
  for (const [kind, title] of [
    ["workflow", "工作流"],
    ["workflow-artifact", "产物"],
  ])
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: `dsh-workflow.${kind}`,
          kind,
          patterns: [`dsh-resource://${kind}/**`],
          canOpen: (address) => address.startsWith(`dsh-resource://${kind}/`),
          title: () => title,
        }),
      `dsh-workflow:${kind}`,
    );
  register(
    "sidebar.right.pane.tab",
    { key: "dsh-workflow.workflow" },
    wrap(function RunTab({ useTabInfo }) {
      const tab = useTabInfo();
      const id = decodeURIComponent(
        new URL(tab.tab.navigation.address).pathname.slice(1),
      );
      return <RunDetail runId={id} />;
    }),
  );
  register(
    "sidebar.right.pane.tab",
    { key: "dsh-workflow.workflow-artifact" },
    wrap(function ArtifactTab({ useTabInfo }) {
      const tab = useTabInfo();
      const [runId, id] = new URL(tab.tab.navigation.address).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent);
      return <ArtifactDetail runId={runId} id={id} />;
    }),
  );
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.dshWorkflow = "2";
    style.textContent = css;
    document.head.appendChild(style);
    const source = new EventSource(BASE + "/events");
    source.onmessage = refreshAll;
    const focus = () => refreshAll();
    window.addEventListener("focus", focus);
    return () => {
      style.remove();
      source.close();
      window.removeEventListener("focus", focus);
      cache.clear();
    };
  }, "dsh-workflow:client");
}
