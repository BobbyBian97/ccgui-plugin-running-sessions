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

// 外部轮次（手机 / 其他客户端经中转发起的轮次）：宿主只为本窗口发起的轮次
// 派发 turn hooks，外部轮次没有生命周期，只能靠检测 ccgui 进程下的引擎子进程。
// 宿主事件流仍会广播到本窗口，但插件总线不暴露原始事件、claude 也只在压缩时
// 发 usage，拿不到开跑信号，因此进程枚举是唯一可靠的开跑来源。
const EXTERNAL_POLL_VISIBLE_MS = 10 * 1000; // 面板挂载时
const EXTERNAL_POLL_IDLE_MS = 60 * 1000; // 面板未挂载时降频
const EXTERNAL_POLL_MAX_BACKOFF_MS = 5 * 60 * 1000;
const EXTERNAL_PROBE_TIMEOUT_MS = 15000;
const EXTERNAL_REFRESH_STALE_MS = 3000;
// 本地 hook 轮次是更权威的同源数据：同会话仍有活动（或刚结束）的本地轮次时，
// 进程检测结果让位，避免同一轮次出现两张卡 / 重复计数。
const EXTERNAL_LOCAL_GRACE_MS = 15000;
const EXTERNAL_LOCAL_START_SLACK_MS = 12000;
const EXTERNAL_TEXT_LIMIT = 160;

const TERMINAL_PHASES = new Set(["completed", "cancelled", "failed", "ended"]);
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
  // 外部轮次只能看到进程存在与否，退出即结束（成功/失败不可知）。
  ended: "已结束",
};

const STATUS_COLORS = {
  running: "#22c55e",
  waiting: "#f59e0b",
  settling: "#9ca3af",
  completed: "#9ca3af",
  cancelled: "#9ca3af",
  failed: "var(--color-text-error-primary)",
  ended: "#9ca3af",
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
  externalChip: {
    flex: "none",
    fontSize: 10,
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: 999,
    border: BORDER,
    color: TEXT_TERTIARY,
    whiteSpace: "nowrap",
  },
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

// 进程枚举（Windows PowerShell CIM）：从 ccgui 主进程向下收集全部子进程。
// 引擎 CLI 由宿主逐轮 spawn（cmd shim → node cli.js 或直接 exe），完整参数都在
// 命令行里。$pid 是 PowerShell 保留变量，循环变量一律用 $id2。
const EXTERNAL_PS_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'Stop'",
  "$procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate",
  "$byId = @{}",
  "foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }",
  "$childMap = @{}",
  "foreach ($p in $procs) {",
  "  $pp = [int]$p.ParentProcessId",
  "  if (-not $childMap.ContainsKey($pp)) { $childMap[$pp] = New-Object System.Collections.ArrayList }",
  "  [void]$childMap[$pp].Add([int]$p.ProcessId)",
  "}",
  "$roots = @()",
  "foreach ($p in $procs) { if ($p.Name -imatch '^ccgui') { $roots += [int]$p.ProcessId } }",
  "$out = New-Object System.Collections.ArrayList",
  "$seen = @{}",
  "foreach ($r in $roots) {",
  "  $q = New-Object System.Collections.Queue",
  "  $q.Enqueue([int]$r)",
  "  $seen[[int]$r] = $true",
  "  while ($q.Count -gt 0) {",
  "    $id2 = [int]$q.Dequeue()",
  "    if (-not $childMap.ContainsKey($id2)) { continue }",
  "    foreach ($c in $childMap[$id2]) {",
  "      if ($seen.ContainsKey($c)) { continue }",
  "      $seen[$c] = $true",
  "      $cp = $byId[$c]",
  "      if ($null -eq $cp) { continue }",
  "      $startMs = 0",
  "      try { $startMs = [long]([DateTimeOffset]$cp.CreationDate).ToUnixTimeMilliseconds() } catch { $startMs = 0 }",
  "      [void]$out.Add([pscustomobject]@{ pid = [int]$cp.ProcessId; ppid = [int]$cp.ParentProcessId; name = [string]$cp.Name; startMs = $startMs; cmd = [string]$cp.CommandLine })",
  "      $q.Enqueue([int]$c)",
  "    }",
  "  }",
  "}",
  "[Console]::Out.Write((ConvertTo-Json -InputObject @($out) -Compress -Depth 4))",
].join("\n");

// 外部轮次探测：在子进程里枚举进程 → 识别引擎 CLI 与会话标识 → 解析工作区。
// 用 exec:node 授权下的 node -e 运行；宿主事件流不向插件暴露原始事件，这是
// 唯一能拿到的「外部轮次开跑」信号。输出 [{pid,engine,sessionId,workspacePath,startedAt}]。
export const EXTERNAL_PROBE_SCRIPT = [
  "const g = process.getBuiltinModule;",
  "if (!g) { process.stderr.write('node too old: getBuiltinModule missing'); process.exit(3); }",
  "const cp = g('node:child_process');",
  "const fs = g('fs'), os = g('os'), path = g('path');",
  "const PS = " + JSON.stringify(EXTERNAL_PS_SCRIPT) + ";",
  "let procs;",
  "try {",
  "  const raw = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', windowsHide: true, maxBuffer: 16777216, timeout: 15000 });",
  "  const parsed = JSON.parse(String(raw).trim() || '[]');",
  "  procs = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];",
  "} catch (e) {",
  "  process.stderr.write('probe-enum: ' + String((e && e.message) || e));",
  "  process.exit(2);",
  "}",
  "const ENGINE_BY_NAME = { claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen', kimi: 'kimi', opencode: 'opencode', deepseek: 'deepseek', grok: 'grok', qodercli: 'qodercli', codebuddy: 'codebuddy', mcode: 'mcode', agy: 'agy', dsh: 'dsh' };",
  "const NPM_SCRIPT_ENGINE = [",
  "  [/@anthropic-ai[\\\\/]claude-code[\\\\/]/i, 'claude'],",
  "  [/@openai[\\\\/]codex[\\\\/]/i, 'codex'],",
  "  [/@google[\\\\/]gemini-cli[\\\\/]/i, 'gemini'],",
  "  [/@qwen-code[\\\\/]/i, 'qwen'],",
  "];",
  "const EVAL_RE = /^(?:-e|--eval|-p|--print)$/;",
  "const SKIP_EXE = /^(?:cmd\\.exe|cmd|powershell\\.exe|pwsh\\.exe|conhost\\.exe|git\\.exe|bash\\.exe|sh\\.exe|wsl\\.exe|msedgewebview2\\.exe)$/i;",
  "function baseName(p) { const parts = String(p || '').split(/[\\\\/]+/).filter(Boolean); return (parts[parts.length - 1] || '').toLowerCase(); }",
  "function engineOfBin(p) { const base = baseName(p).replace(/\\.(?:exe|cmd|bat|js|mjs|cjs|ps1)$/i, ''); return ENGINE_BY_NAME[base] || null; }",
  "function takeToken(text) {",
  "  const s = String(text || '').trimStart();",
  "  if (!s) return { token: '', rest: '' };",
  "  if (s[0] === '\"' || s[0] === \"'\") {",
  "    const end = s.indexOf(s[0], 1);",
  "    if (end < 0) return { token: s.slice(1), rest: '' };",
  "    return { token: s.slice(1, end), rest: s.slice(end + 1) };",
  "  }",
  "  const m = s.match(/^\\S+/);",
  "  const token = m ? m[0] : s;",
  "  return { token: token, rest: s.slice(token.length) };",
  "}",
  "function classify(cmd) {",
  "  const first = takeToken(cmd);",
  "  const b0 = baseName(first.token);",
  "  if (b0 === 'cmd.exe' || b0 === 'cmd') {",
  "    const second = takeToken(first.rest);",
  "    if (!/^\\/(?:c|k)$/i.test(second.token)) return null;",
  "    const target = takeToken(second.rest);",
  "    const engine = engineOfBin(target.token);",
  "    if (engine) return engine;",
  "    if (baseName(target.token).indexOf('node') === 0) {",
  "      const script = takeToken(target.rest);",
  "      if (EVAL_RE.test(script.token)) return null;",
  "      for (const entry of NPM_SCRIPT_ENGINE) if (entry[0].test(script.token)) return entry[1];",
  "    }",
  "    return null;",
  "  }",
  "  if (b0 === 'node.exe' || b0 === 'node') {",
  "    const script = takeToken(first.rest);",
  "    if (!script.token || EVAL_RE.test(script.token)) return null;",
  "    for (const entry of NPM_SCRIPT_ENGINE) if (entry[0].test(script.token)) return entry[1];",
  "    return null;",
  "  }",
  "  if (SKIP_EXE.test(b0)) return null;",
  "  return engineOfBin(first.token);",
  "}",
  "const RESUME_RES = [",
  "  /(?:^|\\s)--resume[=\\s]+\"?([A-Za-z0-9][A-Za-z0-9._-]{5,63})\"?(?=\\s|$)/i,",
  "  /(?:^|\\s)--session-id[=\\s]+\"?([A-Za-z0-9][A-Za-z0-9._-]{5,63})\"?(?=\\s|$)/i,",
  "  /(?:^|\\s)--session[=\\s]+\"?([A-Za-z0-9][A-Za-z0-9._-]{5,63})\"?(?=\\s|$)/i,",
  "  /(?:^|\\s)resume\\s+\"?([A-Za-z0-9][A-Za-z0-9._-]{5,63})\"?(?=\\s|$)/i,",
  "];",
  "function sessionOf(cmd) { for (const re of RESUME_RES) { const m = cmd.match(re); if (m) return m[1]; } return null; }",

  "// 自身与自己的子进程（powershell 等）永远不是引擎 CLI。",
  "const selfPids = new Set([process.pid]);",
  "for (let changed = true; changed; ) {",
  "  changed = false;",
  "  for (const p of procs) if (!selfPids.has(p.pid) && selfPids.has(p.ppid)) { selfPids.add(p.pid); changed = true; }",
  "}",
  "const byPid = new Map();",
  "for (const p of procs) byPid.set(p.pid, p);",
  "const matched = [];",
  "for (const p of procs) {",
  "  if (selfPids.has(p.pid) || !p.cmd) continue;",
  "  const engine = classify(p.cmd);",
  "  if (!engine) continue;",
  "  if (!(typeof p.startMs === 'number' && p.startMs > 0)) continue;",
  "  matched.push({ pid: p.pid, ppid: p.ppid, startMs: p.startMs, cmd: p.cmd, engine: engine, sessionId: sessionOf(p.cmd) });",
  "}",
  "// cmd shim → node cli.js 是同一轮的两个包装层：祖先已匹配同引擎同会话时丢弃后代。",
  "const matchedPids = new Set();",
  "for (const m of matched) matchedPids.add(m.pid);",
  "const runs = [];",
  "for (const m of matched) {",
  "  let cur = m;",
  "  let covered = false;",
  "  while (cur && byPid.has(cur.ppid)) {",
  "    const parent = byPid.get(cur.ppid);",
  "    if (!parent) break;",
  "    if (matchedPids.has(parent.pid)) {",
  "      for (const pm of matched) {",
  "        if (pm.pid === parent.pid && pm.engine === m.engine && pm.sessionId === m.sessionId) { covered = true; break; }",
  "      }",
  "    }",
  "    if (covered) break;",
  "    cur = parent;",
  "  }",
  "  if (!covered) runs.push(m);",
  "}",
  "const HOME = os.homedir();",
  "const DB_PATH = path.join(HOME, '.ccgui-next', 'app.db');",
  "function sqliteCtor() { try { return g('node:sqlite').DatabaseSync; } catch (e) { return null; } }",
  "function dbRows(ids) {",
  "  const out = new Map();",
  "  const DatabaseSync = sqliteCtor();",
  "  if (!DatabaseSync || !ids.length || !fs.existsSync(DB_PATH)) return out;",
  "  try {",
  "    const db = new DatabaseSync(DB_PATH, { readOnly: true });",
  "    try {",
  "      const marks = ids.map(function () { return '?'; }).join(',');",
  "      const stmt = db.prepare('SELECT engine, session_id, workspace_path FROM sessions WHERE session_id IN (' + marks + ')');",
  "      for (const row of stmt.all.apply(stmt, ids)) out.set(row.session_id, row);",
  "    } finally { db.close(); }",
  "  } catch (e) {}",
  "  return out;",
  "}",
  "function knownWorkspaces() {",
  "  const set = new Set();",
  "  const DatabaseSync = sqliteCtor();",
  "  if (!DatabaseSync || !fs.existsSync(DB_PATH)) return set;",
  "  try {",
  "    const db = new DatabaseSync(DB_PATH, { readOnly: true });",
  "    try { for (const row of db.prepare('SELECT path FROM workspaces').all()) if (row.path) set.add(String(row.path).toLowerCase().replace(/[\\\\/]+$/, '')); } finally { db.close(); }",
  "  } catch (e) {}",
  "  return set;",
  "}",
  "const roots = [];",
  "try {",
  "  for (const name of fs.readdirSync(HOME)) {",
  "    if (name.indexOf('.claude') !== 0) continue;",
  "    const dir = path.join(HOME, name, 'projects');",
  "    try { if (fs.statSync(dir).isDirectory()) roots.push(dir); } catch (e) {}",
  "  }",
  "} catch (e) {}",
  "function findTranscript(id) {",
  "  for (const root of roots) {",
  "    let dirs = [];",
  "    try { dirs = fs.readdirSync(root); } catch (e) { continue; }",
  "    for (const dir of dirs) {",
  "      const file = path.join(root, dir, id + '.jsonl');",
  "      try { if (fs.statSync(file).isFile()) return file; } catch (e) {}",
  "    }",
  "  }",
  "  return null;",
  "}",
  "// 转录的 cwd 不一定在第一行（首行常是 queue-operation），前 64KB 逐行找。",
  "function cwdOf(file) {",
  "  let text = '';",
  "  try {",
  "    const buf = Buffer.alloc(65536);",
  "    const fd = fs.openSync(file, 'r');",
  "    let size = 0;",
  "    try { size = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }",
  "    text = buf.slice(0, size).toString('utf8');",
  "  } catch (e) { return ''; }",
  "  for (const line of text.split('\\n')) {",
  "    if (!line) continue;",
  "    let obj;",
  "    try { obj = JSON.parse(line); } catch (e) { continue; }",
  "    if (obj && typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;",
  "  }",
  "  return '';",
  "}",

  "const ids = [];",
  "for (const run of runs) if (run.sessionId && ids.indexOf(run.sessionId) < 0) ids.push(run.sessionId);",
  "const rows = dbRows(ids);",
  "for (const run of runs) {",
  "  if (!run.sessionId) continue;",
  "  let ws = '';",
  "  const row = rows.get(run.sessionId);",
  "  if (row && row.workspace_path) ws = String(row.workspace_path);",
  "  if (!ws && run.engine === 'claude') { const file = findTranscript(run.sessionId); if (file) ws = cwdOf(file); }",
  "  run.workspacePath = ws;",
  "}",
  "// 新会话首轮没有 --resume：找进程启动后新生、且 cwd 属于已知工作区的转录，",
  "// 文件名即会话标识。只按启动时间就近配对，多个未知轮次按启动顺序分配。",
  "const known = knownWorkspaces();",
  "const taken = new Set(ids);",
  "const anonymous = [];",
  "for (const run of runs) if (!run.sessionId && run.engine === 'claude') anonymous.push(run);",
  "if (anonymous.length) {",
  "  const candidates = [];",
  "  for (const root of roots) {",
  "    let dirs = [];",
  "    try { dirs = fs.readdirSync(root); } catch (e) { continue; }",
  "    for (const dir of dirs) {",
  "      let files = [];",
  "      try { files = fs.readdirSync(path.join(root, dir)); } catch (e) { continue; }",
  "      for (const name of files) {",
  "        if (name.slice(-6) !== '.jsonl') continue;",
  "        const id = name.slice(0, -6);",
  "        if (taken.has(id)) continue;",
  "        const file = path.join(root, dir, name);",
  "        let st;",
  "        try { st = fs.statSync(file); } catch (e) { continue; }",
  "        const birth = st.birthtimeMs || st.ctimeMs || 0;",
  "        candidates.push({ id: id, file: file, birth: birth });",
  "      }",
  "    }",
  "  }",
  "  anonymous.sort(function (a, b) { return a.startMs - b.startMs; });",
  "  for (const run of anonymous) {",
  "    const pool = [];",
  "    for (const cand of candidates) {",
  "      if (taken.has(cand.id)) continue;",
  "      if (cand.birth < run.startMs - 3000 || cand.birth > run.startMs + 30000) continue;",
  "      pool.push(cand);",
  "    }",
  "    pool.sort(function (a, b) { return Math.abs(a.birth - run.startMs) - Math.abs(b.birth - run.startMs); });",
  "    for (const cand of pool) {",
  "      const cwd = cwdOf(cand.file);",
  "      if (!cwd) continue;",
  "      if (known.size && !known.has(cwd.toLowerCase().replace(/[\\\\/]+$/, ''))) continue;",
  "      run.sessionId = cand.id;",
  "      run.workspacePath = cwd;",
  "      taken.add(cand.id);",
  "      break;",
  "    }",
  "  }",
  "}",
  "const out = [];",
  "for (const run of runs) out.push({ pid: run.pid, engine: run.engine, sessionId: run.sessionId || null, workspacePath: run.workspacePath || '', startedAt: run.startMs });",
  "process.stdout.write(JSON.stringify(out));",
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
    if (existing.sessionId) changed = dropExternalForSession(state, engine, existing.sessionId) || changed;
    return changed;
  }
  const run = createRun(payload, occurredAt);
  state.runs.set(key, run);
  if (run.sessionId) dropExternalForSession(state, engine, run.sessionId);
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
  // 本地轮次是该会话的权威来源：同会话的外部进程记录让位（探测延迟窗口内可能已建卡）。
  if (run.sessionId) changed = dropExternalForSession(state, engine, run.sessionId) || changed;

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

// ---- 外部轮次（进程检测） ----

// 键按进程实例（pid + 启动时刻）唯一：同一会话的后续轮次是新进程，
// 会作为新轮次进同一张会话卡，不会顶掉上一轮（含未读终态）的记录。
export function externalRunKey(pid, startedAt) {
  return "ext:" + pid + ":" + startedAt;
}

function createExternalRun(record, nowMs) {
  return {
    key: externalRunKey(record.pid, record.startedAt),
    engine: record.engine,
    turnId: externalRunKey(record.pid, record.startedAt),
    runId: "",
    sessionId: isText(record.sessionId) ? record.sessionId : null,
    workspaceId: null,
    workspacePath: isText(record.workspacePath) ? record.workspacePath : "",
    startedAt: record.startedAt,
    lastEventAt: nowMs,
    phase: "running",
    activity: "手机或其他客户端发起",
    waitingTool: null,
    waitingPath: null,
    error: "",
    endedAt: null,
    read: false,
    eventIds: new Set(),
    source: "external",
    pid: record.pid,
  };
}

// 本地 hook 事件落到某会话时，进程检测出来的同会话外部轮次让位：
// 本地轮次有真实的事件级状态，重复保留会把同一轮算成两轮。
function dropExternalForSession(state, engine, sessionId) {
  let changed = false;
  for (const [key, run] of Array.from(state.runs)) {
    if (run.source !== "external") continue;
    if (run.engine !== engine || run.sessionId !== sessionId) continue;
    state.runs.delete(key);
    changed = true;
  }
  return changed;
}

// 应用一次成功的进程探测。只处理探测成功的调用方：探测失败时保持现状，
// 不能把「这次没看到」当成「进程已退出」。
export function applyExternalRuns(state, records, nowMs) {
  if (!state || !state.runs || !Array.isArray(records)) return false;
  const now = resolveNow(nowMs);
  let changed = false;

  const locals = [];
  for (const run of state.runs.values()) if (run.source !== "external") locals.push(run);

  function coveredByLocal(record) {
    for (const run of locals) {
      if (run.engine !== record.engine) continue;
      if (record.sessionId && run.sessionId === record.sessionId) {
        // 同会话本地轮次仍活动，或刚结束（进程可能尚未回收）：本地数据优先。
        if (ACTIVE_PHASES.has(run.phase) || now - run.lastEventAt <= EXTERNAL_LOCAL_GRACE_MS) return true;
        continue;
      }
      // 新会话首轮本地轮次可能还没拿到 sessionId：按启动时间对齐。
      if ((!record.sessionId || !run.sessionId) && Math.abs(run.startedAt - record.startedAt) <= EXTERNAL_LOCAL_START_SLACK_MS) {
        return true;
      }
    }
    return false;
  }

  const liveKeys = new Set();
  for (const record of records) {
    if (!record || !isText(record.engine)) continue;
    if (!(typeof record.pid === "number" && record.pid > 0)) continue;
    if (!(typeof record.startedAt === "number" && record.startedAt > 0)) continue;

    const key = externalRunKey(record.pid, record.startedAt);
    liveKeys.add(key);
    const existing = state.runs.get(key);
    if (coveredByLocal(record)) {
      if (existing) {
        state.runs.delete(key);
        changed = true;
      }
      continue;
    }
    if (existing) {
      if (existing.phase === "ended") {
        existing.phase = "running";
        existing.endedAt = null;
        existing.activity = "手机或其他客户端发起";
        changed = true;
      }
      if (!existing.sessionId && isText(record.sessionId)) {
        existing.sessionId = record.sessionId;
        changed = true;
      }
      if (!existing.workspacePath && isText(record.workspacePath)) {
        existing.workspacePath = record.workspacePath;
        changed = true;
      }
      if (existing.lastEventAt < now) {
        existing.lastEventAt = now;
        changed = true;
      }
      continue;
    }
    state.runs.set(key, createExternalRun(record, now));
    changed = true;
  }

  // 进程消失 = 轮次结束（键按进程实例，pid 复用也不会误续）。
  // 外部轮次看不到退出码，只能给中性的「已结束」。
  for (const run of Array.from(state.runs.values())) {
    if (run.source !== "external") continue;
    if (run.phase !== "running") continue;
    if (liveKeys.has(run.key)) continue;
    run.phase = "ended";
    run.endedAt = now;
    run.activity = "外部轮次已结束";
    changed = true;
  }

  return changed;
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
  let hasEnded = false;
  for (const run of runs) {
    if (run.phase === "waiting") hasWaiting = true;
    else if (run.phase === "running") hasRunning = true;
    else if (run.phase === "settling") hasSettling = true;
    else if (run.phase === "failed") hasFailed = true;
    else if (run.phase === "cancelled") hasCancelled = true;
    else if (run.phase === "ended") hasEnded = true;
  }
  if (hasWaiting) return "waiting";
  if (hasRunning) return "running";
  if (hasSettling) return "settling";
  if (hasFailed) return "failed";
  if (hasCancelled) return "cancelled";
  if (hasEnded) return "ended";
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
    // 代表轮次来自进程检测（手机 / 其他客户端）：状态粒度只到进程级。
    const external = representative.source === "external";
    cards.push({
      key,
      unread,
      external,
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
    // 进程探测结果（只在探测成功时调用）。
    applyExternalRuns(records, nowMs) {
      const changed = applyExternalRuns(state, records, nowMs);
      commit(changed);
      return changed;
    },
    // 面板未挂载时降频轮询，避免无谓地反复 spawn 探测子进程。
    hasSubscribers() {
      return subscribers.size > 0;
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

  // ---- 外部轮次：探测 ccgui 子进程里的引擎 CLI（手机 / 其他客户端发起的轮次） ----
  // 宿主只为本窗口发起的轮次派发 turn hooks，外部轮次没有生命周期；这里用
  // exec 授权枚举进程补上开跑/结束信号（结果只是进程级，比 hook 轮次粗）。
  const externalSync = { timer: null, busy: false, lastAt: 0, failures: 0 };

  function externalNextDelay() {
    const base = store.hasSubscribers() ? EXTERNAL_POLL_VISIBLE_MS : EXTERNAL_POLL_IDLE_MS;
    if (externalSync.failures === 0) return base;
    return Math.min(base * Math.pow(2, externalSync.failures), EXTERNAL_POLL_MAX_BACKOFF_MS);
  }

  function scheduleExternalPoll(delay) {
    if (!canFetchTitles || externalSync.timer !== null) return;
    const wait = typeof delay === "number" && delay >= 0 ? delay : externalNextDelay();
    externalSync.timer = setTimeout(() => {
      externalSync.timer = null;
      void pollExternal();
    }, wait);
  }

  // 面板打开 / 窗口回到前台：数据确实陈旧才立刻补探一次。
  function requestExternalRefresh() {
    if (!canFetchTitles) return;
    if (Date.now() - externalSync.lastAt < EXTERNAL_REFRESH_STALE_MS) return;
    if (externalSync.timer !== null) {
      clearTimeout(externalSync.timer);
      externalSync.timer = null;
    }
    scheduleExternalPoll(0);
  }

  async function queryExternalRuns() {
    const result = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "node",
      args: ["-e", EXTERNAL_PROBE_SCRIPT],
      timeoutMs: EXTERNAL_PROBE_TIMEOUT_MS,
    });
    if (!result || result.code !== 0 || typeof result.stdout !== "string") return null;
    let rows;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    return Array.isArray(rows) ? rows : null;
  }

  async function pollExternal() {
    if (!canFetchTitles || externalSync.busy) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      scheduleExternalPoll(EXTERNAL_POLL_VISIBLE_MS);
      return;
    }
    externalSync.busy = true;
    let rows = null;
    try {
      rows = await queryExternalRuns();
    } catch {
      rows = null;
    } finally {
      externalSync.busy = false;
    }
    if (rows === null) {
      // 非 Windows / 没有 Node / 授权被拒：指数退避，不刷屏。
      externalSync.failures = Math.min(externalSync.failures + 1, 5);
    } else {
      externalSync.failures = 0;
      externalSync.lastAt = Date.now();
      // 外部轮次也可能带来新会话标识：补一次标题查询（TTL 内不会重复 spawn）。
      if (store.applyExternalRuns(rows, externalSync.lastAt)) scheduleTitleSync(500);
    }
    scheduleExternalPoll();
  }

  function handleExternalVisibility() {
    if (typeof document === "undefined" || document.visibilityState === "hidden") return;
    requestExternalRefresh();
  }

  const canListenVisibility =
    typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (canFetchTitles) {
    if (canListenVisibility) document.addEventListener("visibilitychange", handleExternalVisibility);
    scheduleExternalPoll(2000);
  }

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

    // 面板一打开就补一次标题（页面重载后内存缓存为空），并补一次进程探测。
    useEffect(() => {
      scheduleTitleSync(0);
      requestExternalRefresh();
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
        (card.external ? " · 手机或其他客户端发起" : "") +
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
          card.external
            ? h(
                "span",
                {
                  style: S.externalChip,
                  title: "手机或其他客户端发起：本窗口没有该轮次的事件，状态按引擎进程推断",
                },
                "外部"
              )
            : null,
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
          h("span", { style: S.scopeChip }, "全部项目 · 含外部客户端")
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
              h(
                "div",
                { style: S.emptyNote },
                "数据来自本窗口的运行事件与桌面引擎进程：手机或其他客户端发起的轮次也会显示（约 10 秒内出现）。"
              )
            )
      ),
      h(
        "div",
        { style: S.footer },
        h("div", { style: S.footerLine }, "更新于 " + formatClock(store.getLastChangedAt()) + " · 所有项目 · 含外部客户端"),
        h("div", { style: S.footerNote }, "「外部」轮次按引擎进程推断，只区分运行/结束；插件加载前已结束的轮次不会显示")
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
    if (externalSync.timer !== null) {
      clearTimeout(externalSync.timer);
      externalSync.timer = null;
    }
    if (canFetchTitles && canListenVisibility) document.removeEventListener("visibilitychange", handleExternalVisibility);
    if (titlePollTimer !== null) clearInterval(titlePollTimer);
    store.dispose();
  };
}
