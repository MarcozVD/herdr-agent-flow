// Prints what live coding agents are doing, as JSON: Claude Code sessions from their
// transcripts, opencode's and Codex's from their local SQLite files (opened read-only).
// Arguments: `opencode=<folder>` / `codex=<folder>`, one per terminal running that agent.
// A mod can't stat files or read part of one, and transcripts grow to many MB, so this
// reads only their tails. Read-only. Prompts and tool output are never printed: only
// tool names, a short hint (file name, Bash description, pattern) and subagent descriptions.
// Transcripts only grow, so each scan reads only what was appended since the last one: the
// folded state and the byte offset of every transcript are kept in a cache file between runs.
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const projects = path.join(root, "projects");
const MAIN_TAIL = 6 * 1024 * 1024; // screenshots put ~1 MB in one row
const SUB_TAIL = 2 * 1024 * 1024; // whole, for almost all: counts stay exact
const MAX_SUBS = 12;
const MAX_OPEN = 64; // tool calls still waiting for a result; interrupted ones never get one
const QUIET_MS = 3 * 60 * 1000; // an unfinished subagent silent this long is reported stale
const CACHE_VERSION = 2;
const MAX_OUT = 6 * 1024 * 1024; // Herdr's exec keeps 8 MiB of output and drops the rest
const warnings = new Set(); // a private format that changed, named by what's missing
const CACHE = process.env.AGENT_FLOW_CACHE || path.join(os.tmpdir(), "herdr-agent-flow", "scan-cache.json");
const now = Date.now();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function json(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// What earlier scans folded, per transcript, and where each session's transcript lives.
// A cache from another version, or one that won't parse, is dropped: it only costs a full read.
function loadCache() {
  const c = json(CACHE);
  return c?.version === CACHE_VERSION && c.files && c.paths ? c : { version: CACHE_VERSION, files: {}, paths: {} };
}
const cache = loadCache();
const used = new Set(); // transcripts this scan touched; the rest leave the cache

// Written whole to a temporary file and renamed, so a scan running beside another one never
// reads half a cache. Losing the race only means the next scan reads a little more.
function saveCache() {
  for (const f of Object.keys(cache.files)) if (!used.has(f)) delete cache.files[f];
  for (const [id, f] of Object.entries(cache.paths)) if (!used.has(f)) delete cache.paths[id];
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    const tmp = `${CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE);
  } catch { /* a read-only temp folder: every scan reads the tails again */ }
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(end - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  return buf;
}

// Folds what was appended to a transcript since the last scan into its saved state. Only
// whole lines are read: the offset stops after the last newline, so a line still being
// written is read next time. A file that shrank or was replaced, or that grew by more than
// `max` since, starts over from its tail like a first read.
function follow(file, max) {
  const stat = fs.statSync(file);
  const born = Math.round(stat.birthtimeMs);
  used.add(file);
  let c = cache.files[file];
  if (!c || c.born !== born || stat.size < c.offset || stat.size - c.offset > max) {
    const start = Math.max(0, stat.size - max);
    c = cache.files[file] = { born, offset: start, skip: start > 0, partial: start > 0, state: blank() };
  }
  if (stat.size > c.offset) {
    const buf = readRange(file, c.offset, stat.size);
    let from = 0;
    if (c.skip) { // a tail starts mid-line: drop up to the first newline
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) { from = nl + 1; c.skip = false; }
    }
    const end = c.skip ? 0 : buf.lastIndexOf(0x0a) + 1;
    if (end > from) {
      const rows = [];
      for (const l of buf.toString("utf8", from, end).split("\n")) {
        if (!l) continue;
        try { rows.push(JSON.parse(l)); } catch { c.state.seen.bad++; }
      }
      digest(c.state, rows);
    }
    c.offset += end;
  }
  drift(c.state.seen);
  return { d: view(c.state), stat, partial: c.partial };
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

// A transcript folded so far. `open` holds tool calls waiting for their result and `agents`
// the delegations among them, both by tool-use id; keys keep the order they were added in.
function blank() {
  return {
    model: null, ctx: 0, tools: 0, turnAt: 0, lastAt: 0, recent: [], sends: [], recvs: [], open: {}, agents: {},
    seen: { rows: 0, bad: 0, typed: 0, stamped: 0, assistant: 0, model: 0 },
  };
}

// What a transcript's rows should carry, checked once enough of them were read: when an
// update renames a field, this says which one, rather than leaving `model unknown` to guess at.
function drift(n) {
  if (n.bad > 20 && n.bad > n.rows) warnings.add("Claude Code transcript lines no longer parse as JSON");
  if (n.rows < 10) return;
  if (!n.typed) warnings.add("Claude Code transcript rows have no `type` of \"assistant\" or \"user\"");
  if (!n.stamped) warnings.add("Claude Code transcript rows have no `timestamp`");
  if (n.assistant >= 5 && !n.model) warnings.add("Claude Code assistant rows have no `message.model`");
}

// What a session looks like from its state: the call still running, if any.
function view(s) {
  const pending = Object.values(s.open).pop();
  return {
    model: s.model, ctx: s.ctx, tools: s.tools, turnAt: s.turnAt, lastAt: s.lastAt,
    now: pending ? { name: pending.name, hint: pending.hint } : null,
    recent: s.recent, sends: s.sends, recvs: s.recvs,
  };
}

// Folds transcript rows, oldest first, into `out`. Called again with only the rows appended
// since, it ends where reading everything at once would have.
function digest(out, rows) {
  const open = out.open;
  const agents = out.agents;
  for (const r of rows) {
    const c = r.message?.content;
    const at = Date.parse(r.timestamp ?? "") || 0;
    if (at) out.lastAt = Math.max(out.lastAt, at);
    out.seen.rows++;
    if (at) out.seen.stamped++;
    if (r.type === "assistant" || r.type === "user") out.seen.typed++;
    if (r.type === "assistant") {
      const m = r.message;
      out.seen.assistant++;
      if (m?.model) out.seen.model++;
      if (m?.model && m.model !== "<synthetic>") out.model = m.model;
      const u = m?.usage;
      if (u) out.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type !== "tool_use") continue;
        const item = { t: at, name: b.name, hint: hint(b.name, b.input) };
        note(out, item, b.name, b.input, at);
        out.tools++;
        out.recent.push(item);
        open[b.id] = item;
        if (b.name === "Agent" || b.name === "Task") {
          agents[b.id] = b.input?.subagent_type ?? "agent";
          item.delegate = b.input?.subagent_type ?? "agent";
        }
      }
    } else if (r.type === "user") {
      const results = Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
      if (typeof c === "string") heard(out, c, at);
      else for (const b of Array.isArray(c) ? c : []) if (b.type === "text") heard(out, b.text, at);
      for (const b of results) {
        delete open[b.tool_use_id];
        if (b.tool_use_id in agents) {
          out.recent.push({ t: at, name: "back", hint: agents[b.tool_use_id], back: true });
          delete agents[b.tool_use_id];
        }
      }
      if (!results.length && !r.isMeta && !r.isSidechain) { out.tools = 0; out.turnAt = at; }
    }
  }
  // Kept short, since the state is saved between scans.
  const ids = Object.keys(open);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_OPEN))) { delete open[id]; delete agents[id]; }
  out.recent = out.recent.slice(-24);
  out.sends = out.sends.slice(-20);
  out.recvs = out.recvs.slice(-20);
  return out;
}

// Where a session's transcript is: under its folder's slug, or else wherever an earlier scan
// found it, or else anywhere under projects (a folder renamed since, a slug rule that changed).
function transcript(cwd, id) {
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  const known = cache.paths[id];
  if (known && fs.existsSync(known)) return known;
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return (cache.paths[id] = file);
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
    const { d, partial } = follow(f, SUB_TAIL);
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
  } catch (e) { warnings.add(`opencode.db: ${e.message}`); return []; } finally { db.close(); }
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
    try { rows = db.prepare("select id, cwd, model, updated_at_ms from threads where archived = 0 order by updated_at_ms desc limit 60").all(); } catch (e) { warnings.add(`Codex state: ${e.message}`); } finally { db.close(); }
  }
  const found = perFolder(rows, folders, (r) => r.cwd).map((r) => ({ ...blank, id: r.id, agent: "codex", cwd: r.cwd, model: r.model, lastAt: r.updated_at_ms }));
  if (found.length) return found;
  // No thread yet: what it will run with.
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return []; }
  const model = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  return model ? folders.map((cwd, i) => ({ ...blank, id: `codex-${i}`, agent: "codex", cwd, model, lastAt: 0 })) : [];
}

const sessions = [];
let dir = [];
try { dir = fs.readdirSync(path.join(root, "sessions")); } catch { /* no live sessions */ }
for (const name of dir) {
  if (!name.endsWith(".json")) continue;
  const s = json(path.join(root, "sessions", name));
  if (s && alive(s.pid) && (!s.sessionId || !s.cwd)) warnings.add("Claude Code sessions/<pid>.json has no `sessionId` or `cwd`");
  if (!s?.sessionId || !s.cwd || !alive(s.pid)) continue;
  try {
    const file = transcript(s.cwd, s.sessionId);
    if (!file) continue;
    const { d, stat, partial } = follow(file, MAIN_TAIL);
    sessions.push({ id: s.sessionId, pid: s.pid, cwd: s.cwd, startedAt: s.startedAt, ...d, more: partial && !d.turnAt, lastAt: Math.round(stat.mtimeMs), ...subagents(file) });
  } catch { /* a transcript vanished mid-read; the next scan sees the truth */ }
}
saveCache();
for (const s of sessions) s.agent = "claude-code";
sessions.push(...opencode(wanted("opencode")), ...codex(wanted("codex")));
sessions.sort((a, b) => b.lastAt - a.lastAt);
// Past Herdr's output limit the view would get cut JSON and show nothing: keep less history.
let out = JSON.stringify({ sessions, warnings: [...warnings] });
for (const keep of [8, 3, 0]) {
  if (out.length <= MAX_OUT) break;
  for (const s of sessions) {
    s.recent = s.recent.slice(-keep);
    for (const k of s.subs) k.recent = k.recent.slice(-keep);
    if (!keep) s.subs = s.subs.filter((k) => k.status === "working");
  }
  out = JSON.stringify({ sessions, warnings: [...warnings, "output trimmed: too many sessions to show every tool"] });
}
process.stdout.write(out);
