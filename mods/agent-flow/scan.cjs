// Prints what live coding agents are doing, as JSON: Claude Code sessions from their
// transcripts, opencode's and Codex's from their local SQLite files (opened read-only).
// Arguments: `opencode=<folder>` / `codex=<folder>`, one per terminal running that agent.
// A mod can't stat files or read part of one, and transcripts grow to many MB, so this
// reads only their tails. Read-only. Prompts and tool output are never printed: only
// tool names, a short hint (file name, Bash description, pattern) and subagent descriptions.
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const projects = path.join(root, "projects");
const MAIN_TAIL = 6 * 1024 * 1024; // screenshots put ~1 MB in one row
const SUB_TAIL = 2 * 1024 * 1024; // whole, for almost all: counts stay exact
const MAX_SUBS = 12;
const QUIET_MS = 3 * 60 * 1000; // an unfinished subagent silent this long is reported stale
const now = Date.now();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function json(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function tail(file, max) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - max);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(stat.size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // starts mid-line
  const rows = [];
  for (const l of lines) {
    if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return { rows, stat, partial: start > 0 };
}

function hint(name, input = {}) {
  const short = (s, n = 46) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  if (input.file_path) return short(path.basename(String(input.file_path)));
  if (name === "Agent" || name === "Task") return short(input.description);
  if (input.description) return short(input.description);
  if (input.pattern) return short(input.pattern);
  if (input.url) { try { return new URL(input.url).host; } catch { return ""; } }
  if (input.command) return short(input.command);
  return "";
}

// Who a tool call is talking to: `hc send <target>` from a shell, or Claude Code's
// SendMessage. Only the target leaves here, never the message.
function target(name, input = {}) {
  if (name === "SendMessage" && input.to) return String(input.to);
  if (typeof input.command !== "string") return null;
  const hit = /(?:^|[\s;&|/\\"'])hc(?:\.exe)?["']?\s+send\s+(?:--?[a-z-]+\s+)*["']?([\w:./-]+)/i.exec(input.command);
  return hit ? hit[1] : null;
}

// Messages arrive tagged <hc from="t7 review">. Only the address leaves here.
function heard(out, text, at) {
  for (const hit of String(text).matchAll(/<hc from=\\?"([^"\\\s]+)/g)) out.recvs.push({ t: at, from: hit[1] });
}

function note(out, item, name, input, at) {
  const to = target(name, input);
  if (!to) return;
  item.name = "Send";
  item.hint = to;
  item.to = to;
  out.sends.push({ t: at, to });
}

function digest(rows) {
  const out = { model: null, ctx: 0, tools: 0, turnAt: 0, lastAt: 0, now: null, recent: [], sends: [], recvs: [] };
  const open = new Map();
  const agents = new Map();
  for (const r of rows) {
    const c = r.message?.content;
    const at = Date.parse(r.timestamp ?? "") || 0;
    if (at) out.lastAt = Math.max(out.lastAt, at);
    if (r.type === "assistant") {
      const m = r.message;
      if (m?.model && m.model !== "<synthetic>") out.model = m.model;
      const u = m?.usage;
      if (u) out.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type !== "tool_use") continue;
        const item = { t: at, name: b.name, hint: hint(b.name, b.input) };
        note(out, item, b.name, b.input, at);
        out.tools++;
        out.recent.push(item);
        open.set(b.id, item);
        if (b.name === "Agent" || b.name === "Task") {
          agents.set(b.id, b.input?.subagent_type ?? "agent");
          item.delegate = b.input?.subagent_type ?? "agent";
        }
      }
    } else if (r.type === "user") {
      const results = Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
      if (typeof c === "string") heard(out, c, at);
      else for (const b of Array.isArray(c) ? c : []) if (b.type === "text") heard(out, b.text, at);
      for (const b of results) {
        open.delete(b.tool_use_id);
        if (agents.has(b.tool_use_id)) {
          out.recent.push({ t: at, name: "back", hint: agents.get(b.tool_use_id), back: true });
        }
      }
      if (!results.length && !r.isMeta && !r.isSidechain) { out.tools = 0; out.turnAt = at; }
    }
  }
  const pending = [...open.values()].pop();
  out.now = pending ? { name: pending.name, hint: pending.hint } : null;
  out.recent = out.recent.slice(-24);
  out.sends = out.sends.slice(-20);
  out.recvs = out.recvs.slice(-20);
  return out;
}

function transcript(cwd, id) {
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function subagents(file) {
  const dir = path.join(file.slice(0, -".jsonl".length), "subagents");
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return { subs: [], total: 0 }; }
  const list = names.map((name) => {
    const f = path.join(dir, name);
    const stat = fs.statSync(f);
    return { f, name, born: stat.birthtimeMs, seen: stat.mtimeMs };
  }).sort((a, b) => b.born - a.born);
  const subs = list.slice(0, MAX_SUBS).map(({ f, name, born, seen }) => {
    const meta = json(f.replace(/\.jsonl$/, ".meta.json")) ?? {};
    const { rows, partial } = tail(f, SUB_TAIL);
    const d = digest(rows);
    const status = meta.finished === true ? "done" : now - seen > QUIET_MS ? "stale" : "working";
    return {
      id: name.replace(/^agent-|\.jsonl$/g, ""), type: meta.agentType ?? "agent",
      description: meta.description ?? "", status, model: d.model ?? meta.pickedEffortModel ?? null,
      tools: d.tools, more: partial, ctx: d.ctx, now: d.now, recent: d.recent.slice(-8), sends: d.sends,
      startedAt: Math.round(born), lastAt: Math.round(seen),
    };
  });
  return { subs, total: list.length };
}

const sameDir = (a, b) => norm(a) === norm(b);
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const wanted = (agent) => process.argv.slice(2).filter((a) => a.startsWith(`${agent}=`)).map((a) => a.slice(agent.length + 1));

// node:sqlite needs Node 22; without it these agents still show, only without a model.
function database(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

// The latest rows for each asked folder: two terminals in one folder take two sessions.
function perFolder(rows, folders, dirOf) {
  const left = [...folders];
  return rows.filter((r) => {
    const i = left.findIndex((f) => sameDir(f, dirOf(r)));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

function digestOpencode(rows) {
  const out = { model: null, ctx: 0, tools: 0, turnAt: 0, lastAt: 0, now: null, recent: [], sends: [], recvs: [] };
  for (const r of rows) {
    out.lastAt = Math.max(out.lastAt, r.time_created);
    if (r.type === "user") { out.tools = 0; out.turnAt = r.time_created; out.now = null; heard(out, r.data, r.time_created); }
    if (r.type !== "assistant") continue;
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    if (d.model?.id) out.model = d.model.id;
    for (const b of d.content ?? []) {
      if (b.type !== "tool") continue;
      const given = typeof b.state?.input === "object" ? b.state.input ?? {} : {};
      const name = String(b.name)[0].toUpperCase() + String(b.name).slice(1);
      const item = { t: b.time?.created ?? r.time_created, name, hint: hint(name, { ...given, file_path: given.filePath ?? given.file_path ?? (/^(read|edit|write)/i.test(name) ? given.path : undefined) }) };
      note(out, item, name, given, item.t);
      out.tools++;
      out.recent.push(item);
      out.now = /run|stream|pend/.test(b.state?.status ?? "") ? item : null;
    }
  }
  out.now = out.now ? { name: out.now.name, hint: out.now.hint } : null;
  out.recent = out.recent.slice(-24);
  out.sends = out.sends.slice(-20);
  out.recvs = out.recvs.slice(-20);
  return out;
}

function opencode(folders) {
  if (!folders.length) return [];
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const file = path.join(data, "opencode", "opencode.db");
  const db = fs.existsSync(file) ? database(file) : null;
  if (!db) return [];
  try {
    const messages = db.prepare("select type, data, time_created from session_message where session_id = ? order by seq desc limit 200");
    const load = (id) => digestOpencode(messages.all(id).reverse());
    const roots = db.prepare("select id, directory, time_updated from session_v2 where parent_id is null and time_archived is null order by time_updated desc limit 60").all();
    const children = db.prepare("select id, agent, title, time_created, time_updated, time_idle from session_v2 where parent_id = ? order by time_created desc limit ?");
    return perFolder(roots, folders, (r) => r.directory).map((r) => {
      const subs = children.all(r.id, MAX_SUBS).map((k) => {
        const d = load(k.id);
        const status = k.time_idle != null ? "done" : now - k.time_updated > QUIET_MS ? "stale" : "working";
        return { id: k.id, type: k.agent ?? "subagent", description: k.title ?? "", status, model: d.model, tools: d.tools, more: false, ctx: 0, now: d.now, recent: d.recent.slice(-8), sends: d.sends, startedAt: k.time_created, lastAt: k.time_updated };
      });
      return { id: r.id, agent: "opencode", cwd: r.directory, ...load(r.id), lastAt: r.time_updated, more: false, subs, total: subs.length };
    });
  } catch { return []; } finally { db.close(); }
}

function codex(folders) {
  if (!folders.length) return [];
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const blank = { tools: null, ctx: 0, turnAt: 0, now: null, recent: [], sends: [], recvs: [], more: false, subs: [], total: 0 };
  let files = [];
  try { files = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n)).sort(); } catch { return []; }
  let rows = [];
  const db = files.length ? database(path.join(home, files[files.length - 1])) : null;
  if (db) {
    try { rows = db.prepare("select id, cwd, model, updated_at_ms from threads where archived = 0 order by updated_at_ms desc limit 60").all(); } catch { /* another version's schema */ } finally { db.close(); }
  }
  const found = perFolder(rows, folders, (r) => r.cwd).map((r) => ({ ...blank, id: r.id, agent: "codex", cwd: r.cwd, model: r.model, lastAt: r.updated_at_ms }));
  if (found.length) return found;
  // No thread yet: what it will run with.
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return []; }
  const model = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  return model ? folders.map((cwd, i) => ({ ...blank, id: `codex-${i}`, agent: "codex", cwd, model, lastAt: 0 })) : [];
}

// Oh My Pi: one JSONL per session in ~/.omp/agent/sessions/<folder>/, the folder named
// after the cwd ("-Code-x" under home, "--private-tmp--" outside it). The model is the
// last assistant message's, or the last model_change before any reply.
function omp(folders) {
  if (!folders.length) return [];
  const home = os.homedir();
  const base = path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, ".omp", "agent"), "sessions");
  const blank = { tools: null, ctx: 0, turnAt: 0, now: null, recent: [], sends: [], recvs: [], more: false, subs: [], total: 0 };
  const used = new Set();
  const out = [];
  for (const cwd of folders) {
    const name = cwd === home ? "-"
      : cwd.startsWith(`${home}/`) ? `-${cwd.slice(home.length + 1).replace(/\//g, "-")}`
      : `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, name)).filter((n) => n.endsWith(".jsonl"))
        .map((n) => path.join(base, name, n)).filter((f) => !used.has(f))
        .map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
    } catch { continue; }
    const pick = files[0];
    if (!pick) continue;
    used.add(pick.f);
    let model = null;
    try {
      for (const r of tail(pick.f, SUB_TAIL).rows) {
        if (r.type === "message" && r.message?.role === "assistant" && r.message.model) model = r.message.model;
        else if (r.type === "model_change" && r.model) model = r.model.split("/").pop();
      }
    } catch { /* the file vanished mid-read */ }
    out.push({ ...blank, id: path.basename(pick.f, ".jsonl"), agent: "omp", cwd, model, lastAt: Math.round(pick.m) });
  }
  return out;
}

const sessions = [];
let dir = [];
try { dir = fs.readdirSync(path.join(root, "sessions")); } catch { /* no live sessions */ }
for (const name of dir) {
  if (!name.endsWith(".json")) continue;
  const s = json(path.join(root, "sessions", name));
  if (!s?.sessionId || !s.cwd || !alive(s.pid)) continue;
  try {
    const file = transcript(s.cwd, s.sessionId);
    if (!file) continue;
    const { rows, stat, partial } = tail(file, MAIN_TAIL);
    const d = digest(rows);
    sessions.push({ id: s.sessionId, pid: s.pid, cwd: s.cwd, startedAt: s.startedAt, ...d, more: partial && !d.turnAt, lastAt: Math.round(stat.mtimeMs), ...subagents(file) });
  } catch { /* a transcript vanished mid-read; the next scan sees the truth */ }
}
for (const s of sessions) s.agent = "claude-code";
sessions.push(...opencode(wanted("opencode")), ...codex(wanted("codex")), ...omp(wanted("omp")));
sessions.sort((a, b) => b.lastAt - a.lastAt);
process.stdout.write(JSON.stringify({ sessions }));
