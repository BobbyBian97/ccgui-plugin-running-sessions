// 运行中会话：跨全部工作区回显正在执行的轮次（单文件 ESM，无模块引入）。
// 归并主键是 engine|turnId：宿主发送后会重映射 runId，但 turnId 全程不变，不能拿 runId 去重。

const RETENTION_MS = 30 * 1000;
const RUN_CAPACITY = 200;
// 已读/未读：新轮次一律未读；打开会话或点「标为已读」后转已读。
// 未读轮次无论 phase 都保留（含终态）；只有已读且已结束的轮次才进入 30s 清理窗。
const EVENT_ID_CAP = 64;
const MAX_CARDS = 50;
const ERROR_STORE_LIMIT = 600;
const ERROR_SHOW_LIMIT = 160;
const ACTIVITY_LIMIT = 120;

// 标题来自宿主会话库（~/.ccgui-next/app.db 的 sessions 表，与左侧会话列表同源）。
// 宿主没有开放读取标题的插件 API，只能经 exec 授权用 node/python 只读查询。
const TITLE_TTL_MS = 60 * 1000;
const TITLE_MISS_TTL_MS = 15 * 1000; // 库里还没落行的新会话，15s 后再试
const TITLE_SYNC_DELAY_MS = 600;
const TITLE_TEXT_LIMIT = 240;
const TITLE_FETCH_TIMEOUT_MS = 8000;
const TITLE_CACHE_CAP = 400;
const TITLE_RETRY_COOLDOWN_MS = 60 * 1000;

const TERMINAL_PHASES = new Set(["completed", "cancelled", "failed"]);
const ACTIVE_PHASES = new Set(["running", "waiting", "settling"]);

// 只有这些「后续活动/终态」事件能解除等待授权；未知 kind 与 runtime-exited 不动等待态。
const CLEARS_WAITING = new Set([
  "command-started",
  "command-finished",
  "file-changed",
  "tool-finished",
  "assistant-completed",
  "turn-failed",
  "turn-cancelled",
]);

// 未匹配 run 的 runtime 事件：只采纳仍在活动的 kind，避免凭空冒出完成/退化卡。
const NON_ADOPT_KINDS = new Set(["", "turn-failed", "turn-cancelled", "assistant-completed", "runtime-exited"]);

const ENGINE_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  qwen: "Qwen",
  kimi: "Kimi",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
};

const PHASE_LABELS = {
  running: "运行中",
  waiting: "等待授权",
  settling: "正在收尾",
  completed: "完成",
  cancelled: "已取消",
  failed: "失败",
};

const STATUS_COLORS = {
  running: "#22c55e",
  waiting: "#f59e0b",
  settling: "#9ca3af",
  completed: "#9ca3af",
  cancelled: "#9ca3af",
  failed: "var(--color-text-error-primary)",
};

const TEXT_PRIMARY = "var(--color-text-primary)";
const TEXT_SECONDARY = "var(--color-text-secondary)";
const TEXT_TERTIARY = "var(--color-text-tertiary)";
const TEXT_ERROR = "var(--color-text-error-primary)";
const BG_SECONDARY = "var(--color-background-secondary-default)";
const BORDER = "1px solid var(--color-border-button-default)";

// 样式对象只定义一次；面板整体内联，不注入 CSS。
const S = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    padding: "12px 12px 0",
    boxSizing: "border-box",
    color: TEXT_PRIMARY,
  },
  header: { flex: "none", display: "flex", flexDirection: "column", gap: 6, paddingBottom: 8 },
  titleRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
  title: { fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY },
  countChip: {
    fontSize: 11,
    padding: "1px 8px",
    borderRadius: 999,
    border: BORDER,
    color: TEXT_SECONDARY,
    whiteSpace: "nowrap",
  },
  scopeChip: {
    fontSize: 11,
    padding: "1px 8px",
    borderRadius: 999,
    border: BORDER,
    color: TEXT_TERTIARY,
    whiteSpace: "nowrap",
  },
  banner: {
    flex: "none",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 8,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid " + TEXT_ERROR,
    background: "rgba(239, 68, 68, 0.08)",
  },
  bannerText: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    lineHeight: 1.5,
    color: TEXT_ERROR,
    wordBreak: "break-word",
  },
  bannerClose: {
    flex: "none",
    border: "none",
    background: "transparent",
    color: TEXT_ERROR,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  list: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 2 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
    padding: "10px 12px",
    marginBottom: 8,
    borderRadius: 8,
    border: BORDER,
    background: BG_SECONDARY,
    cursor: "pointer",
  },
  cardDisabled: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
    padding: "10px 12px",
    marginBottom: 8,
    borderRadius: 8,
    border: BORDER,
    background: BG_SECONDARY,
    cursor: "default",
    opacity: 0.75,
  },
  cardTop: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  projectName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 600,
    color: TEXT_PRIMARY,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  engineChip: {
    flex: "none",
    fontSize: 10,
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: 999,
    border: BORDER,
    color: TEXT_SECONDARY,
    whiteSpace: "nowrap",
  },
  runCountChip: {
    flex: "none",
    fontSize: 10,
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: 999,
    background: "rgba(34, 197, 94, 0.12)",
    color: TEXT_SECONDARY,
    whiteSpace: "nowrap",
  },
  elapsed: {
    flex: "none",
    fontSize: 11,
    color: TEXT_TERTIARY,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  cardMeta: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" },
  sessionId: { fontSize: 11, color: TEXT_SECONDARY, whiteSpace: "nowrap" },
  sessionTitle: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 },
  sessionTitleLabel: { flex: "none", fontSize: 10, color: TEXT_TERTIARY, whiteSpace: "nowrap" },
  sessionTitleText: {
    minWidth: 0,
    fontSize: 11,
    color: TEXT_SECONDARY,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  statusChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 999,
    border: BORDER,
    whiteSpace: "nowrap",
  },
  statusDot: { width: 6, height: 6, borderRadius: "50%", display: "inline-block", flex: "none" },
  unreadDot: {
    flex: "none",
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#3b82f6",
    display: "inline-block",
  },
  unreadChip: {
    flex: "none",
    fontSize: 10,
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: 999,
    background: "rgba(59, 130, 246, 0.14)",
    color: "#3b82f6",
    whiteSpace: "nowrap",
  },
  markReadBtn: {
    flex: "none",
    fontSize: 10,
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: 999,
    border: BORDER,
    background: "transparent",
    color: TEXT_SECONDARY,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  opening: { fontSize: 10, color: TEXT_TERTIARY, whiteSpace: "nowrap" },
  activity: {
    fontSize: 11,
    color: TEXT_SECONDARY,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  errorLine: {
    fontSize: 11,
    color: TEXT_ERROR,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  empty: { display: "flex", flexDirection: "column", gap: 6, padding: "28px 8px", textAlign: "center" },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY },
  emptyDesc: { fontSize: 12, lineHeight: 1.6, color: TEXT_SECONDARY },
  emptyNote: { fontSize: 10, lineHeight: 1.6, color: TEXT_TERTIARY },
  footer: { flex: "none", padding: "8px 0 10px", borderTop: BORDER, marginTop: 4 },
  footerLine: { fontSize: 10, color: TEXT_TERTIARY },
  footerNote: { fontSize: 10, color: TEXT_TERTIARY, marginTop: 2 },
};

// exec 子进程只读查询标题。
// node：优先读宿主会话库；库里还没有的新会话，从 Claude 转录的首条用户消息补标题
//（宿主会话库在首轮结束后才落行，而新会话的标题就是首条用户消息）。
// 用 process.getBuiltinModule 而不是 require，保持插件源码里没有 require 调用。
const TITLE_NODE_SCRIPT = [
  "const g = process.getBuiltinModule;",
  "const fs = g('fs'), os = g('os'), path = g('path');",
  "const ids = JSON.parse(process.argv[1] || '[]');",
  "const out = [];",
  "const seen = new Set();",
  "const home = os.homedir();",
  "try {",
  "  const dbPath = path.join(home, '.ccgui-next', 'app.db');",
  "  if (fs.existsSync(dbPath)) {",
  "    const mod = g('node:sqlite');",
  "    const db = new mod.DatabaseSync(dbPath, { readOnly: true });",
  "    const uniq = [];",
  "    for (const id of ids) { if (typeof id === 'string' && id && uniq.indexOf(id) < 0) uniq.push(id); }",
  "    if (uniq.length) {",
  "      const marks = uniq.map(function () { return '?'; }).join(',');",
  "      const stmt = db.prepare('SELECT engine, session_id, title, custom_title FROM sessions WHERE session_id IN (' + marks + ')');",
  "      for (const row of stmt.all.apply(stmt, uniq)) { out.push(row); seen.add(row.session_id); }",
  "    }",
  "    db.close();",
  "  }",
  "} catch (e) { process.stderr.write(String((e && e.message) || e)); process.exit(3); }",
  "const roots = [];",
  "try {",
  "  for (const name of fs.readdirSync(home)) {",
  "    if (name.indexOf('.claude') !== 0) continue;",
  "    const dir = path.join(home, name, 'projects');",
  "    try { if (fs.statSync(dir).isDirectory()) roots.push(dir); } catch (err) {}",
  "  }",
  "} catch (e) {}",
  "function titleOf(file) {",
  "  let text = '';",
  "  try {",
  "    const buf = Buffer.alloc(262144);",
  "    const fd = fs.openSync(file, 'r');",
  "    let size = 0;",
  "    try { size = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }",
  "    for (const line of buf.slice(0, size).toString('utf8').split('\\n')) {",
  "      if (!line) continue;",
  "      let obj;",
  "      try { obj = JSON.parse(line); } catch (err) { continue; }",
  "      if (!obj || obj.type !== 'user' || obj.isMeta) continue;",
  "      const msg = obj.message;",
  "      if (!msg || msg.role !== 'user') continue;",
  "      let raw = '';",
  "      if (typeof msg.content === 'string') raw = msg.content;",
  "      else if (Array.isArray(msg.content)) {",
  "        raw = msg.content.filter(function (p) { return p && p.type === 'text' && typeof p.text === 'string'; })",
  "          .map(function (p) { return p.text; }).join(' ');",
  "      }",
  "      text = String(raw).replace(/\\s+/g, ' ').trim();",
  "      if (!text) continue;",
  "      if (/local-command-caveat|<command-name>|<local-command-stdout>/.test(text)) { text = ''; continue; }",
  "      break;",
  "    }",
  "  } catch (err) { text = ''; }",
  "  return text.slice(0, 240);",
  "}",
  "for (const id of ids) {",
  "  if (typeof id !== 'string' || !id || seen.has(id)) continue;",
  "  let found = '';",
  "  for (const root of roots) {",
  "    let dirs = [];",
  "    try { dirs = fs.readdirSync(root); } catch (err) { continue; }",
  "    for (const dir of dirs) {",
  "      const file = path.join(root, dir, id + '.jsonl');",
  "      try { if (!fs.statSync(file).isFile()) continue; } catch (err) { continue; }",
  "      found = titleOf(file);",
  "      if (found) break;",
  "    }",
  "    if (found) break;",
  "  }",
  "  if (found) out.push({ engine: 'claude', session_id: id, title: found, custom_title: null });",
  "}",
  "process.stdout.write(JSON.stringify(out));",
].join("\n");

const TITLE_PY_SCRIPT = [
  "js=__import__('json'); sy=__import__('sys'); sq=__import__('sqlite3'); os=__import__('os')",
  "ids=[i for i in dict.fromkeys(js.loads(sy.argv[1] or '[]')) if isinstance(i,str) and i]",
  "p=os.path.expanduser('~/.ccgui-next/app.db')",
  "rows=[]",
  "if ids and os.path.exists(p):",
  "    con=sq.connect(p)",
  "    q='select engine,session_id,title,custom_title from sessions where session_id in ('+','.join(['?']*len(ids))+')'",
  "    rows=[{'engine':a,'session_id':b,'title':c,'custom_title':d} for a,b,c,d in con.execute(q,ids)]",
  "    con.close()",
  "sy.stdout.write(js.dumps(rows))",
].join("\n");

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(text, limit) {
  const value = text === null || text === undefined ? "" : String(text);
  return value.length > limit ? value.slice(0, limit) : value;
}

function resolveNow(nowMs) {
  return typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
}

function toTimeMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallback;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function basename(path) {
  if (typeof path !== "string" || !path) return "";
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  if (end === 0) return "";
  let start = end;
  while (start > 0 && path[start - 1] !== "/" && path[start - 1] !== "\\") start -= 1;
  return path.slice(start, end);
}

function dirnameOf(path) {
  if (typeof path !== "string" || !path) return "";
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  while (end > 0 && path[end - 1] !== "/" && path[end - 1] !== "\\") end -= 1;
  if (end === 0) return "";
  let cut = end;
  while (cut > 1 && (path[cut - 1] === "/" || path[cut - 1] === "\\")) cut -= 1;
  return path.slice(0, cut);
}

function engineLabel(engine) {
  return ENGINE_LABELS[engine] || engine || "未知引擎";
}

function sessionShort(sessionId) {
  if (!isText(sessionId)) return "";
  return "会话 " + sessionId.slice(-8);
}

export function formatElapsed(ms) {
  let total = Math.floor((typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  const hours = Math.floor(total / 3600);
  total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const two = (value) => (value < 10 ? "0" + value : String(value));
  return hours > 0 ? hours + ":" + two(minutes) + ":" + two(seconds) : two(minutes) + ":" + two(seconds);
}

function formatClock(ms) {
  const date = new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now());
  const two = (value) => (value < 10 ? "0" + value : String(value));
  return two(date.getHours()) + ":" + two(date.getMinutes()) + ":" + two(date.getSeconds());
}

function runKeyOf(engine, turnId) {
  return engine + "|" + turnId;
}

// 卡片标识：有 sessionId 的轮次并成一张会话卡，否则匿名轮次各自一卡。
function cardKeyOf(run) {
  return run.sessionId ? "s:" + run.engine + "|" + run.sessionId + "|" + run.workspacePath : "a:" + run.key;
}

export function sessionKeyOf(engine, sessionId) {
  return engine + "|" + sessionId;
}

function collapseSpace(text) {
  const value = text === null || text === undefined ? "" : String(text);
  return value.replace(/\s+/g, " ").trim();
}

export function titleFromRow(row) {
  if (!row || typeof row !== "object") return "";
  const custom = collapseSpace(row.customTitle !== undefined ? row.customTitle : row.custom_title);
  if (custom) return clip(custom, TITLE_TEXT_LIMIT);
  const base = collapseSpace(row.title);
  return base ? clip(base, TITLE_TEXT_LIMIT) : "";
}

export function parseTitleRows(stdout) {
  const rows = [];
  if (typeof stdout !== "string" || !stdout.trim()) return rows;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return rows;
  }
  if (!Array.isArray(data)) return rows;
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const engine = isText(row.engine) ? row.engine : "";
    const sessionId = isText(row.session_id) ? row.session_id : isText(row.sessionId) ? row.sessionId : "";
    if (!engine || !sessionId) continue;
    rows.push({ engine, sessionId, text: titleFromRow(row) });
  }
  return rows;
}

// 需要（重新）查询标题的会话：文本标题按 TTL 刷新（用户可能改名），
// 空标题代表库里还没这个会话（新会话首轮），按更短的 miss TTL 重试。
export function collectTitleRequests(state, nowMs, ttlMs, missTtlMs) {
  const now = resolveNow(nowMs);
  const fresh = typeof ttlMs === "number" && ttlMs >= 0 ? ttlMs : TITLE_TTL_MS;
  const miss = typeof missTtlMs === "number" && missTtlMs >= 0 ? missTtlMs : TITLE_MISS_TTL_MS;
  const requests = new Map();
  if (!state || !state.runs) return requests;
  const titles = state.titles instanceof Map ? state.titles : null;
  for (const run of state.runs.values()) {
    if (!run.sessionId || requests.has(run.sessionId)) continue;
    const entry = titles ? titles.get(sessionKeyOf(run.engine, run.sessionId)) : null;
    if (entry && typeof entry.at === "number") {
      const age = now - entry.at;
      const limit = isText(entry.text) ? fresh : miss;
      if (age >= 0 && age < limit) continue;
    }
    requests.set(run.sessionId, run.engine);
  }
  return requests;
}

function createRun(payload, occurredAt) {
  return {
    key: runKeyOf(payload.engine, payload.turnId),
    engine: payload.engine,
    turnId: payload.turnId,
    runId: isText(payload.runId) ? payload.runId : "",
    sessionId: isText(payload.sessionId) ? payload.sessionId : null,
    workspaceId: payload.workspace && isText(payload.workspace.id) ? payload.workspace.id : null,
    workspacePath: payload.workspace.path,
    startedAt: occurredAt,
    lastEventAt: occurredAt,
    phase: "running",
    activity: "已开始执行",
    waitingTool: null,
    waitingPath: null,
    error: "",
    endedAt: null,
    read: false,
    eventIds: new Set(),
  };
}

export function ingestTurnStarted(state, payload, nowMs) {
  if (!state || !state.runs || !payload) return false;
  const engine = isText(payload.engine) ? payload.engine : "";
  const turnId = isText(payload.turnId) ? payload.turnId : "";
  const workspacePath = payload.workspace && isText(payload.workspace.path) ? payload.workspace.path : "";
  if (!engine || !turnId || !workspacePath) return false;

  const now = resolveNow(nowMs);
  const occurredAt = toTimeMs(payload.occurredAt, now);
  const key = runKeyOf(engine, turnId);
  const existing = state.runs.get(key);
  if (existing) {
    let changed = false;
    if (!existing.sessionId && isText(payload.sessionId)) {
      existing.sessionId = payload.sessionId;
      changed = true;
    }
    if (!existing.runId && isText(payload.runId)) {
      existing.runId = payload.runId;
      changed = true;
    }
    if (occurredAt < existing.startedAt) {
      existing.startedAt = occurredAt;
      changed = true;
    }
    return changed;
  }
  state.runs.set(key, createRun(payload, occurredAt));
  return true;
}

export function ingestRuntimeEvent(state, payload, nowMs) {
  if (!state || !state.runs || !payload) return false;
  const engine = isText(payload.engine) ? payload.engine : "";
  const turnId = isText(payload.turnId) ? payload.turnId : "";
  if (!engine || !turnId) return false;
  let run = state.runs.get(runKeyOf(engine, turnId));

  // 没有 onTurnStarted 的轮次（插件热重载、容量淘汰后）用事件自带标识补建，
  // 否则该轮在整个生命周期内都不可见。只采纳仍在活动的事件，终态事件不建卡。
  if (!run) {
    const probeKind = isText(payload.kind) ? payload.kind : "";
    if (!isText(payload.workspacePath) || NON_ADOPT_KINDS.has(probeKind)) return false;
    run = createRun(
      {
        engine,
        turnId,
        runId: payload.runId,
        sessionId: payload.sessionId,
        workspace: { id: payload.workspaceId, path: payload.workspacePath },
        occurredAt: payload.occurredAt,
      },
      toTimeMs(payload.occurredAt, resolveNow(nowMs))
    );
    run.activity = "已接入运行中";
    state.runs.set(run.key, run);
  }

  const now = resolveNow(nowMs);
  const occurredAt = toTimeMs(payload.occurredAt, now);
  let changed = false;

  // sessionId 迟到：新会话先以空 sessionId 开跑，后续事件带来标识后回填。
  if (!run.sessionId && isText(payload.sessionId)) {
    run.sessionId = payload.sessionId;
    changed = true;
  }

  if (isText(payload.eventId) && run.eventIds) {
    if (run.eventIds.has(payload.eventId)) return changed;
    if (run.eventIds.size >= EVENT_ID_CAP) {
      const oldest = run.eventIds.values().next().value;
      if (oldest !== undefined) run.eventIds.delete(oldest);
    }
    run.eventIds.add(payload.eventId);
  }

  // 终态之后只允许回填 sessionId，其它事件一律忽略。
  if (TERMINAL_PHASES.has(run.phase)) return changed;

  const kind = isText(payload.kind) ? payload.kind : "";
  if (CLEARS_WAITING.has(kind)) {
    // 等待授权只被确证的后续活动/终态解除；未知 kind、runtime-exited 保持等待态。
    run.waitingTool = null;
    run.waitingPath = null;
    if (run.phase === "waiting") run.phase = "running";
  }
  run.lastEventAt = Math.max(run.lastEventAt, occurredAt);
  changed = true;

  switch (kind) {
    case "permission-requested": {
      run.phase = "waiting";
      run.waitingTool = isText(payload.tool) ? payload.tool : null;
      run.waitingPath = isText(payload.path) ? payload.path : null;
      let text = "等待授权：" + (run.waitingTool || "未知工具");
      if (run.waitingPath) text += " · " + basename(run.waitingPath);
      run.activity = clip(text, ACTIVITY_LIMIT);
      break;
    }
    case "turn-failed": {
      run.phase = "failed";
      run.endedAt = occurredAt;
      run.error = clip(payload.error === null || payload.error === undefined ? "" : payload.error, ERROR_STORE_LIMIT);
      run.activity = "执行失败";
      break;
    }
    case "turn-cancelled": {
      run.phase = "cancelled";
      run.endedAt = occurredAt;
      run.activity = "已取消";
      break;
    }
    case "assistant-completed": {
      run.phase = "settling";
      run.endedAt = occurredAt;
      run.activity = "本轮输出完成";
      break;
    }
    case "command-started": {
      const command = isText(payload.command) ? clip(payload.command, 80) : "";
      run.activity = clip("执行命令" + (command ? "：" + command : ""), ACTIVITY_LIMIT);
      break;
    }
    case "command-finished": {
      const exitCode =
        typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode) ? payload.exitCode : null;
      run.activity = exitCode === 0 ? "命令完成（退出码 0）" : exitCode === null ? "命令结束" : "命令结束（退出码 " + exitCode + "）";
      break;
    }
    case "file-changed": {
      const name = basename(payload.path);
      run.activity = clip("修改文件" + (name ? "：" + name : ""), ACTIVITY_LIMIT);
      break;
    }
    case "tool-finished": {
      const toolName = isText(payload.toolName) ? payload.toolName : "";
      run.activity = clip("工具完成" + (toolName ? "：" + toolName : ""), ACTIVITY_LIMIT);
      break;
    }
    case "runtime-exited": {
      const exitCode =
        typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode) ? payload.exitCode : null;
      // runtime-exited 不终结轮次：等 afterTurn 给出的最终状态。
      run.activity = clip(exitCode === null ? "运行时退出" : "运行时退出（退出码 " + exitCode + "）", ACTIVITY_LIMIT);
      break;
    }
    default:
      // 未来新增的 kind：只刷新活动时间，不改 phase / 活动文案（等待态也不解除）。
      break;
  }
  return changed;
}

export function ingestAfterTurn(state, payload, nowMs) {
  if (!state || !state.runs || !payload) return false;
  const engine = isText(payload.engine) ? payload.engine : "";
  const turnId = isText(payload.turnId) ? payload.turnId : "";
  const workspacePath = payload.workspace && isText(payload.workspace.path) ? payload.workspace.path : "";
  if (!engine || !turnId || !workspacePath) return false;
  const run = state.runs.get(runKeyOf(engine, turnId));
  if (!run) return false;

  const now = resolveNow(nowMs);
  const occurredAt = toTimeMs(payload.occurredAt, now);
  let changed = false;

  if (!run.sessionId && isText(payload.sessionId)) {
    run.sessionId = payload.sessionId;
    changed = true;
  }

  const status = payload.status;
  if (status !== "completed" && status !== "cancelled" && status !== "failed") return changed;

  // afterTurn 是宿主权威终态：即便 runtime 事件已给出终态，也以这里覆盖。
  run.phase = status;
  run.endedAt = occurredAt;
  run.lastEventAt = occurredAt;
  run.waitingTool = null;
  run.waitingPath = null;
  if (status === "failed") {
    const message = payload.error === null || payload.error === undefined ? "" : payload.error;
    if (message) run.error = clip(message, ERROR_STORE_LIMIT);
    run.activity = "执行失败";
  } else if (status === "cancelled") {
    run.activity = "已取消";
  } else {
    run.activity = "本轮输出完成";
  }
  return true;
}

export function pruneRuns(state, nowMs) {
  if (!state || !state.runs) return false;
  const now = resolveNow(nowMs);
  let changed = false;

  // 已结束（终态 / 已预置 endedAt 的 settling）且已读的轮次保留 30 秒；
  // 未读轮次不按时间清理——「未读时无论什么状态都保留」，直到用户标记已读。
  for (const [key, run] of Array.from(state.runs)) {
    const expirable = TERMINAL_PHASES.has(run.phase) || run.phase === "settling";
    if (!expirable || run.read !== true) continue;
    if (typeof run.endedAt === "number" && now - run.endedAt >= RETENTION_MS) {
      state.runs.delete(key);
      changed = true;
    }
  }

  // 超容量兜底：先淘汰最老的已读终态，再最老的未读终态，最后才动活动轮次。
  while (state.runs.size > RUN_CAPACITY) {
    let victim = null;
    let victimRank = Infinity;
    let victimAt = Infinity;
    for (const [key, run] of state.runs) {
      const terminal = TERMINAL_PHASES.has(run.phase) || run.phase === "settling";
      const rank = terminal ? (run.read === true ? 0 : 1) : 2;
      const at = terminal && typeof run.endedAt === "number" ? run.endedAt : run.startedAt;
      if (rank < victimRank || (rank === victimRank && at < victimAt)) {
        victim = key;
        victimRank = rank;
        victimAt = at;
      }
    }
    if (victim === null) break;
    state.runs.delete(victim);
    changed = true;
  }

  return changed;
}

// 把某张卡（同一会话 / 同一条匿名轮次）的所有轮次标为已读。
// 已读的终态轮次会立刻进入清理判定：超过 30 秒的直接消失。
export function markCardRead(state, cardKey) {
  if (!state || !state.runs || !isText(cardKey)) return false;
  let changed = false;
  for (const run of state.runs.values()) {
    if (run.read === true) continue;
    if (cardKeyOf(run) !== cardKey) continue;
    run.read = true;
    changed = true;
  }
  return changed;
}

function aggregatePhase(runs) {
  let hasWaiting = false;
  let hasRunning = false;
  let hasSettling = false;
  let hasFailed = false;
  let hasCancelled = false;
  for (const run of runs) {
    if (run.phase === "waiting") hasWaiting = true;
    else if (run.phase === "running") hasRunning = true;
    else if (run.phase === "settling") hasSettling = true;
    else if (run.phase === "failed") hasFailed = true;
    else if (run.phase === "cancelled") hasCancelled = true;
  }
  if (hasWaiting) return "waiting";
  if (hasRunning) return "running";
  if (hasSettling) return "settling";
  if (hasFailed) return "failed";
  if (hasCancelled) return "cancelled";
  return "completed";
}

function phaseBucket(phase) {
  if (phase === "waiting") return 0;
  if (phase === "running") return 1;
  if (phase === "settling") return 2;
  return 3;
}

export function deriveCards(state, nowMs) {
  const now = resolveNow(nowMs);
  const groups = new Map();
  if (state && state.runs) {
    for (const run of state.runs.values()) {
      const key = cardKeyOf(run);
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(run);
    }
  }

  const cards = [];
  for (const [key, runs] of groups) {
    let latest = runs[0];
    let waitingRun = null;
    let activeLatest = null;
    let activeStartedAt = Infinity;
    let startedAt = Infinity;
    let endedAt = null;
    let lastEventAt = -Infinity;
    for (const run of runs) {
      if (run.lastEventAt > latest.lastEventAt) latest = run;
      if (run.lastEventAt > lastEventAt) lastEventAt = run.lastEventAt;
      if (run.startedAt < startedAt) startedAt = run.startedAt;
      if (typeof run.endedAt === "number" && (endedAt === null || run.endedAt > endedAt)) endedAt = run.endedAt;
      if (ACTIVE_PHASES.has(run.phase)) {
        // 计时只从活跃轮次起算：上一轮终态在 30s 保留窗内不该把新轮时长算进去。
        if (run.startedAt < activeStartedAt) activeStartedAt = run.startedAt;
        if (!activeLatest || run.lastEventAt > activeLatest.lastEventAt) activeLatest = run;
      }
      if (run.phase === "waiting" && (!waitingRun || run.lastEventAt > waitingRun.lastEventAt)) waitingRun = run;
    }

    const phase = aggregatePhase(runs);
    // 状态与活动文案都取活跃轮次，避免「运行中」配上已终态轮的「本轮输出完成」。
    const representative = waitingRun || activeLatest || latest;
    const elapsedStart = activeLatest ? activeStartedAt : startedAt;
    const frozen = phase === "settling" || TERMINAL_PHASES.has(phase);
    const elapsedEnd = frozen ? (endedAt === null ? now : endedAt) : now;

    let error = "";
    let errorAt = -Infinity;
    for (const run of runs) {
      if (run.phase === "failed" && run.error) {
        const at = typeof run.endedAt === "number" ? run.endedAt : 0;
        if (at >= errorAt) {
          errorAt = at;
          error = run.error;
        }
      }
    }

    let activityTitle = representative.activity;
    if (representative.phase === "waiting" && representative.waitingTool) {
      activityTitle =
        "等待授权：" +
        representative.waitingTool +
        (representative.waitingPath ? " · " + representative.waitingPath : "");
    }

    const sessionId = runs[0].sessionId || null;
    let titleText = "";
    if (sessionId && state && state.titles instanceof Map) {
      const titleEntry = state.titles.get(sessionKeyOf(runs[0].engine, sessionId));
      if (titleEntry && isText(titleEntry.text)) titleText = titleEntry.text;
    }
    // 卡内只要还有未读轮次，整卡就是未读（新轮次会让已读会话重新变未读）。
    const unread = runs.some((run) => run.read !== true);
    cards.push({
      key,
      unread,
      engine: runs[0].engine,
      engineLabel: engineLabel(runs[0].engine),
      sessionId,
      sessionShort: sessionShort(sessionId),
      titleText,
      workspaceId: runs[0].workspaceId,
      workspacePath: representative.workspacePath,
      projectName: basename(representative.workspacePath),
      phase,
      phaseLabel: PHASE_LABELS[phase],
      activity: representative.activity,
      activityTitle,
      error,
      runCount: runs.length,
      anonymous: !sessionId,
      startedAt,
      endedAt,
      lastEventAt,
      elapsedMs: Math.max(0, elapsedEnd - elapsedStart),
    });
  }

  // 项目重名时追加父目录名区分。
  const baseCounts = new Map();
  for (const card of cards) {
    const name = basename(card.workspacePath);
    baseCounts.set(name, (baseCounts.get(name) || 0) + 1);
  }
  for (const card of cards) {
    const name = basename(card.workspacePath) || card.workspacePath || "未知项目";
    if (baseCounts.get(basename(card.workspacePath)) > 1) {
      const parent = basename(dirnameOf(card.workspacePath));
      card.projectName = parent ? name + "（" + parent + "）" : name;
    } else {
      card.projectName = name;
    }
    if (!card.sessionId) card.sessionShort = "";
  }

  cards.sort((a, b) => {
    const bucketDiff = phaseBucket(a.phase) - phaseBucket(b.phase);
    if (bucketDiff !== 0) return bucketDiff;
    if (phaseBucket(a.phase) === 3) {
      const endedDiff = (b.endedAt || 0) - (a.endedAt || 0);
      if (endedDiff !== 0) return endedDiff;
      return b.startedAt - a.startedAt;
    }
    return b.startedAt - a.startedAt;
  });

  return cards.slice(0, MAX_CARDS);
}

export function countActiveRuns(state) {
  if (!state || !state.runs) return 0;
  let count = 0;
  for (const run of state.runs.values()) {
    if (ACTIVE_PHASES.has(run.phase)) count += 1;
  }
  return count;
}

export function createSessionStore(options) {
  const nowFn = options && typeof options.now === "function" ? options.now : Date.now;
  const state = { runs: new Map(), titles: new Map(), lastChangedAt: nowFn() };
  const subscribers = new Set();
  let timer = null;
  let visibilityBound = false;

  function notify() {
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber();
      } catch {
        // 单个订阅者出错不影响其它的。
      }
    }
  }

  function handleVisibility() {
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") notify();
  }

  function bindVisibility() {
    if (visibilityBound) return;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    document.addEventListener("visibilitychange", handleVisibility);
    visibilityBound = true;
  }

  function unbindVisibility() {
    if (!visibilityBound) return;
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
    visibilityBound = false;
  }

  function tick() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (pruneRuns(state, nowFn())) state.lastChangedAt = nowFn();
    notify();
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setInterval(tick, 1000);
    bindVisibility();
  }

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    unbindVisibility();
  }

  function commit(changed) {
    if (!changed) return;
    state.lastChangedAt = nowFn();
    pruneRuns(state, nowFn());
    notify();
  }

  return {
    state,
    subscribe(handler) {
      if (typeof handler !== "function") return () => {};
      subscribers.add(handler);
      if (subscribers.size === 1) startTimer();
      return () => {
        subscribers.delete(handler);
        if (subscribers.size === 0) stopTimer();
      };
    },
    turnStarted(payload) {
      commit(ingestTurnStarted(state, payload, nowFn()));
    },
    runtimeEvent(payload) {
      commit(ingestRuntimeEvent(state, payload, nowFn()));
    },
    turnFinished(payload) {
      commit(ingestAfterTurn(state, payload, nowFn()));
    },
    // 标记整卡已读（打开会话或点「标为已读」）；已读终态轮次随清理窗消失。
    markRead(cardKey) {
      commit(markCardRead(state, cardKey));
    },
    // 标题查询结果（engine + sessionId → 文本）。标题变化才通知面板。
    applyTitles(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return false;
      const at = nowFn();
      let changed = false;
      for (const row of rows) {
        if (!row || !isText(row.engine) || !isText(row.sessionId)) continue;
        const key = sessionKeyOf(row.engine, row.sessionId);
        const text = clip(collapseSpace(row.text), TITLE_TEXT_LIMIT);
        const prev = state.titles.get(key);
        if (prev && prev.text === text) {
          prev.at = at;
          continue;
        }
        state.titles.set(key, { text, at });
        changed = true;
      }
      if (state.titles.size > TITLE_CACHE_CAP) {
        const entries = Array.from(state.titles.entries()).sort((a, b) => a[1].at - b[1].at);
        for (let i = 0; i < entries.length - TITLE_CACHE_CAP; i += 1) state.titles.delete(entries[i][0]);
      }
      if (changed) {
        state.lastChangedAt = at;
        notify();
      }
      return changed;
    },
    // 查不到会话（库还没落行）也记一条空标题，避免每个事件都重新 spawn 查询。
    markTitlesMissing(requests) {
      if (!(requests instanceof Map) || requests.size === 0) return;
      const at = nowFn();
      for (const [sessionId, engine] of requests) {
        const key = sessionKeyOf(engine, sessionId);
        if (!state.titles.has(key)) state.titles.set(key, { text: "", at });
      }
    },
    getLastChangedAt() {
      return state.lastChangedAt;
    },
    dispose() {
      stopTimer();
      subscribers.clear();
    },
  };
}

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useRef } = ctx.react;
  const store = createSessionStore({ now: () => Date.now() });

  // ---- 标题同步：exec 只读宿主会话库（node 优先，python 兜底） ----
  const canFetchTitles =
    !!(ctx.bridge && typeof ctx.bridge.invoke === "function") && !(ctx.host && ctx.host.isWeb);
  const titleSync = { timer: null, busy: false, cooldownUntil: 0 };

  function scheduleTitleSync(delay) {
    if (!canFetchTitles || titleSync.timer !== null) return;
    if (Date.now() < titleSync.cooldownUntil) return;
    const wait = typeof delay === "number" && delay >= 0 ? delay : TITLE_SYNC_DELAY_MS;
    titleSync.timer = setTimeout(() => {
      titleSync.timer = null;
      syncTitles();
    }, wait);
  }

  async function invokeTitleCommand(bin, args) {
    const result = await ctx.bridge.invoke("plugin_exec_run", {
      bin,
      args,
      timeoutMs: TITLE_FETCH_TIMEOUT_MS,
    });
    if (result && result.code === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
      return parseTitleRows(result.stdout);
    }
    return null;
  }

  async function queryTitles(ids) {
    const payload = JSON.stringify(ids);
    const attempts = [
      ["node", ["-e", TITLE_NODE_SCRIPT, payload]],
      // 旧版 Node 的 node:sqlite 需要显式开关；新版不接受时这次尝试自然失败，继续兜底。
      ["node", ["--experimental-sqlite", "-e", TITLE_NODE_SCRIPT, payload]],
      ["python", ["-c", TITLE_PY_SCRIPT, payload]],
    ];
    for (const attempt of attempts) {
      try {
        const rows = await invokeTitleCommand(attempt[0], attempt[1]);
        if (rows !== null) return rows;
      } catch {
        // 解释器不存在 / exec 授权被拒 / 超时：换下一种。
      }
    }
    return null;
  }

  async function syncTitles() {
    if (!canFetchTitles || titleSync.busy) return;
    const requests = collectTitleRequests(store.state, Date.now(), TITLE_TTL_MS, TITLE_MISS_TTL_MS);
    if (requests.size === 0) return;
    titleSync.busy = true;
    let rows = null;
    try {
      rows = await queryTitles(Array.from(requests.keys()));
    } finally {
      titleSync.busy = false;
    }
    if (rows === null) {
      // 解释器/授权都不可用：冷却一分钟再试，别让每个事件都去 spawn。
      titleSync.cooldownUntil = Date.now() + TITLE_RETRY_COOLDOWN_MS;
      return;
    }
    if (rows.length) store.applyTitles(rows);
    const found = new Set(rows.map((row) => row.sessionId));
    const missing = new Map();
    for (const [sessionId, engine] of requests) {
      if (!found.has(sessionId)) missing.set(sessionId, engine);
    }
    if (missing.size) store.markTitlesMissing(missing);
  }

  const titlePollTimer = canFetchTitles ? setInterval(() => scheduleTitleSync(0), TITLE_TTL_MS) : null;

  function useStoreRevision() {
    const [revision, setRevision] = useState(0);
    useEffect(
      () =>
        store.subscribe(() => {
          setRevision((value) => value + 1);
        }),
      []
    );
    return revision;
  }

  // 宿主页签条只画 icon（label 仅作 title/无障碍名），还会吞掉 icon 里的 HTML 文本，
  // 所以把图标和名称一起画进同一个加宽 SVG；className 必须挂到根上，未激活色来自它。
  function RunningTabLabel(props) {
    return h(
      "svg",
      {
        width: 76,
        height: 16,
        viewBox: "0 0 76 16",
        fill: "none",
        className: props && props.className,
        style: { flexShrink: 0, width: 76, height: 16 },
        "aria-hidden": "true",
      },
      h(
        "g",
        {
          transform: "scale(0.667)",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
        },
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "M10 8.5l6 3.5-6 3.5z", fill: "currentColor", stroke: "none" })
      ),
      h(
        "text",
        {
          x: 22,
          y: 8,
          fill: "currentColor",
          fontSize: 12,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          dominantBaseline: "central",
        },
        "运行会话"
      )
    );
  }

  // 面板数据范围是全部工作区：忽略宿主传入的 workspacePath。
  function RunningSessionsPanel({ workspacePath }) {
    void workspacePath;
    useStoreRevision();
    const [openingKey, setOpeningKey] = useState(null);
    const [bannerMessage, setBannerMessage] = useState(null);
    const bannerTimerRef = useRef(null);

    useEffect(
      () => () => {
        if (bannerTimerRef.current !== null) clearTimeout(bannerTimerRef.current);
      },
      []
    );

    // 面板一打开就补一次标题（页面重载后内存缓存为空）。
    useEffect(() => {
      scheduleTitleSync(0);
    }, []);

    const nowMs = Date.now();
    const cards = deriveCards(store.state, nowMs);
    const activeCount = countActiveRuns(store.state);

    function dismissError() {
      if (bannerTimerRef.current !== null) {
        clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
      setBannerMessage(null);
    }

    function showError(message) {
      setBannerMessage(message);
      if (bannerTimerRef.current !== null) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => {
        bannerTimerRef.current = null;
        setBannerMessage(null);
      }, 5000);
    }

    function openCard(card) {
      if (!card.sessionId || openingKey !== null) return;
      // 打开会话即视为已读：未读终态卡不再因其保留。
      store.markRead(card.key);
      setOpeningKey(card.key);
      Promise.resolve()
        .then(() => ctx.sessions.selectSession(card.engine, card.sessionId, card.workspacePath))
        .then(
          () => setOpeningKey(null),
          (error) => {
            const message =
              error && typeof error.message === "string" && error.message
                ? error.message
                : String(error === null || error === undefined ? "未知错误" : error);
            showError("打开会话失败：" + message);
            setOpeningKey(null);
          }
        );
    }

    function renderCard(card) {
      const cannotOpen = !card.sessionId;
      const isOpening = openingKey === card.key;
      // 打开某个会话期间，其它卡也进入禁用反馈，避免「点了没反应」。
      const blocked = openingKey !== null && !isOpening;
      const disabled = cannotOpen || blocked;
      const statusColor = STATUS_COLORS[card.phase] || TEXT_TERTIARY;
      const statusTextColor = card.phase === "failed" ? TEXT_ERROR : TEXT_SECONDARY;
      // 等待动画不用 keyframes：tick 每秒切换圆点 opacity。
      const dotOpacity = card.phase === "waiting" ? (Math.floor(nowMs / 1000) % 2 === 0 ? 0.45 : 1) : 1;
      const cardTitle = cannotOpen
        ? "会话标识尚未建立，暂时无法跳转"
        : blocked
          ? "正在打开其他会话…"
          : card.workspacePath;
      const elapsedLabel =
        (TERMINAL_PHASES.has(card.phase) || card.phase === "settling" ? "已结束 · " : "已运行 ") +
        formatElapsed(card.elapsedMs);
      const ariaLabel =
        (card.unread ? "未读 · " : "") +
        card.engineLabel +
        " · " +
        card.projectName +
        (card.titleText ? " · 标题：" + card.titleText : "") +
        " · " +
        card.phaseLabel +
        (card.runCount > 1 ? " · " + card.runCount + " 个轮次" : "") +
        " · " +
        elapsedLabel +
        (cannotOpen ? " · 会话标识尚未建立，暂不可打开" : " · 按回车打开会话");

      return h(
        "div",
        {
          key: card.key,
          style: disabled ? S.cardDisabled : S.card,
          title: cardTitle,
          role: "button",
          tabIndex: 0,
          "aria-disabled": disabled ? "true" : undefined,
          "aria-label": ariaLabel,
          onClick: () => {
            if (!disabled) openCard(card);
          },
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              if (!disabled) openCard(card);
            }
          },
        },
        h(
          "div",
          { style: S.cardTop },
          card.unread ? h("span", { style: S.unreadDot, "aria-hidden": "true" }) : null,
          h("div", { style: S.projectName, title: card.workspacePath }, card.projectName),
          h("span", { style: S.engineChip }, card.engineLabel),
          card.runCount > 1 ? h("span", { style: S.runCountChip }, card.runCount + " 个轮次") : null,
          h("span", { style: S.elapsed }, formatElapsed(card.elapsedMs))
        ),
        card.titleText
          ? h(
              "div",
              { style: S.sessionTitle, title: card.titleText },
              h("span", { style: S.sessionTitleLabel }, "标题"),
              h("span", { style: S.sessionTitleText }, card.titleText)
            )
          : null,
        h(
          "div",
          { style: S.cardMeta },
          h("span", { style: S.sessionId }, disabled ? "新会话 · 等待标识" : card.sessionShort),
          h(
            "span",
            { style: Object.assign({}, S.statusChip, { color: statusTextColor }) },
            h("span", { style: Object.assign({}, S.statusDot, { background: statusColor, opacity: dotOpacity }) }),
            card.phaseLabel
          ),
          card.unread && (TERMINAL_PHASES.has(card.phase) || card.phase === "settling")
            ? h("span", { style: S.unreadChip }, "未读")
            : null,
          isOpening ? h("span", { style: S.opening }, "打开中…") : null,
          card.unread
            ? h(
                "button",
                {
                  type: "button",
                  style: S.markReadBtn,
                  title: "标记为已读；已读且已结束的会话不再保留",
                  "aria-label": "标记 " + card.projectName + " 为已读",
                  onClick: (event) => {
                    event.stopPropagation();
                    store.markRead(card.key);
                  },
                  onKeyDown: (event) => {
                    // 别让 Enter/空格冒泡到整卡，否则会同时打开会话。
                    event.stopPropagation();
                  },
                },
                "标为已读"
              )
            : null
        ),
        h("div", { style: S.activity, title: card.activityTitle }, card.activity),
        card.phase === "failed" && card.error
          ? h("div", { style: S.errorLine, title: card.error }, clip(card.error, ERROR_SHOW_LIMIT))
          : null
      );
    }

    return h(
      "div",
      { style: S.root },
      h(
        "div",
        { style: S.header },
        h(
          "div",
          { style: S.titleRow },
          h("span", { style: S.title }, "运行中会话"),
          h("span", { style: S.countChip }, activeCount + " 个运行中"),
          h("span", { style: S.scopeChip }, "全部项目 · 本窗口")
        )
      ),
      bannerMessage
        ? h(
            "div",
            { style: S.banner, role: "alert" },
            h("span", { style: S.bannerText, title: bannerMessage }, bannerMessage),
            h(
              "button",
              {
                type: "button",
                style: S.bannerClose,
                title: "关闭",
                "aria-label": "关闭错误提示",
                onClick: dismissError,
              },
              "×"
            )
          )
        : null,
      h(
        "div",
        { style: S.list },
        cards.length
          ? cards.map(renderCard)
          : h(
              "div",
              { style: S.empty },
              h("div", { style: S.emptyTitle }, "当前没有正在执行的会话"),
              h("div", { style: S.emptyDesc }, "在任意项目发送消息后，正在执行的轮次会出现在这里。"),
              h("div", { style: S.emptyNote }, "数据来自本窗口的运行事件：插件加载或页面重载前已开始的轮次不会显示。")
            )
      ),
      h(
        "div",
        { style: S.footer },
        h("div", { style: S.footerLine }, "更新于 " + formatClock(store.getLastChangedAt()) + " · 所有项目 · 仅本窗口"),
        h("div", { style: S.footerNote }, "插件加载/页面重载前已在执行的轮次可能不显示")
      )
    );
  }

  ctx.hooks.registerTurnHooks({
    // 面板没打开也要累积：hook 在 activate 时注册。
    onTurnStarted: (payload) => {
      store.turnStarted(payload);
      scheduleTitleSync();
    },
    onRuntimeEvent: (payload) => {
      store.runtimeEvent(payload);
      if (payload && isText(payload.sessionId)) scheduleTitleSync();
    },
    afterTurn: (payload) => {
      store.turnFinished(payload);
      scheduleTitleSync();
    },
  });
  ctx.ui.registerPanelTab({
    key: "running",
    label: () => "运行中会话",
    icon: RunningTabLabel,
    component: RunningSessionsPanel,
    order: 20,
  });

  // 注册返回的 Disposer 由宿主在卸载时逆序自动执行（SDK 契约）；
  // 这里只清理插件自建的计时器与订阅。
  return () => {
    if (titleSync.timer !== null) {
      clearTimeout(titleSync.timer);
      titleSync.timer = null;
    }
    if (titlePollTimer !== null) clearInterval(titlePollTimer);
    store.dispose();
  };
}
