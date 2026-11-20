// The pure half of the mod: from what Herdr and scan.cjs report to what the views draw. Nothing
// here calls Herdr or reads the clock itself (the time comes in as an argument), so it runs
// under plain Node too, and the view can keep its result until one of its inputs changes.

export const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
const LINK_MS = 10 * 60000; // how long a message between agents stays drawn
const SUB_MS = 15 * 60000;  // finished subagents stay this long when a turn started none

export function modelName(m) {
  const hit = /claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(m ?? "");
  if (!hit) return m ?? null;
  return `${hit[1][0].toUpperCase()}${hit[1].slice(1)} ${hit[2]}${hit[3] ? `.${hit[3]}` : ""}`;
}

export function tone(model, t, app) {
  if (/opus/.test(model ?? "")) return t.ansi5;
  if (/sonnet/.test(model ?? "")) return t.ansi3;
  if (/haiku/.test(model ?? "")) return t.ansi4;
  if (/fable/.test(model ?? "")) return t.ansi2;
  if (app === "opencode") return t.ansi6;
  if (app === "codex") return t.ansi7; // not ansi2: that's Fable's
  return t.accent;
}

const clean = (s) => (s ?? "").replace(/^OC \| /, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
// Cut from the middle, where model names repeat least: "deepseek-v4…ash:free".
export function middle(s, n) {
  if (s == null || s.length <= n) return s;
  if (n < 4) return s.slice(0, Math.max(0, n));
  const head = Math.ceil((n - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
}

export const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function appOf(k) {
  const app = k.report?.app ?? k.program?.key ?? null;
  return app === "claude" ? "claude-code" : app === "pi" ? "omp" : app;
}

const isAgent = (k) => !!(k.report || k.program?.agent);

// Every live terminal as one shape, split into agents and plain terminals. `raw` is
// `terminals()`, `listed` is `agents()`, which knows a fresher status and the space.
export function normalize(raw, listed) {
  const live = raw.filter((k) => k.state === "live");
  const byAgent = new Map(listed.map((a) => [a.address, a]));
  const all = live.map((k) => {
    const seen = byAgent.get(k.address);
    const word = seen?.status ?? k.status;
    return {
      address: k.address, parent: k.parent ?? null, cwd: k.cwd ?? null, app: appOf(k), program: k.program,
      status: word === "error" ? "blocked" : word, label: k.name ?? null, seq: seen?.seq ?? 0,
      space: seen?.space ?? k.labels?.["herdr.space"] ?? null,
      name: k.program?.name ?? k.report?.app ?? k.address,
      title: clean(k.report?.title) || clean(seen?.title) || clean(k.title),
    };
  });
  // A sub-agent without a pane may carry no space: it lives in its parent's.
  const byAddress = new Map(all.map((k) => [k.address, k]));
  for (const k of all) k.space ??= byAddress.get(k.parent)?.space ?? null;
  const flags = new Map(live.map((k) => [k.address, isAgent(k)]));
  return { agents: all.filter((k) => flags.get(k.address)), plain: all.filter((k) => !flags.get(k.address)) };
}

// Sessions don't name their terminal, so they pair up by agent and folder; with several of
// one agent in a folder, the busiest terminal takes the most recently active session. That
// is a guess whenever a folder has more than one terminal or more than one session of an
// agent (one may run outside Herdr), and `guessed` names those terminals so the view can
// say so instead of passing someone else's model off as theirs.
export function pair(list, sessions) {
  const free = [...sessions];
  const found = new Map();
  const where = (agent, cwd) => `${agent}|${norm(cwd)}`;
  const count = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  const terms = count(list.map((a) => where(a.app, a.cwd)));
  const held = count(sessions.map((s) => where(s.agent, s.cwd)));
  const guessed = new Set();
  for (const a of [...list].sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9))) {
    const i = free.findIndex((s) => s.agent === a.app && norm(s.cwd) === norm(a.cwd));
    if (i < 0) continue;
    found.set(a.address, free.splice(i, 1)[0]);
    const k = where(a.app, a.cwd);
    if (terms.get(k) > 1 || held.get(k) > 1) guessed.add(a.address);
  }
  return { found, guessed };
}

// A turn's subagents, or else the last ones that finished in the past quarter hour.
export function visibleSubs(s, wall) {
  if (!s?.subs) return [];
  const turn = s.subs.filter((k) => k.status === "working" || k.lastAt >= s.turnAt);
  return turn.length ? turn : s.subs.filter((k) => wall - k.lastAt < SUB_MS);
}

// Every agent in the space and subagent in a session, and what passed between them. `to`
// in a send is an address, a terminal name, a subagent id or type, so it resolves here; a
// target that isn't one (another space, a finished terminal) stays in the log only. Agents
// with no transcript show through the tags on what they sent to agents that have one.
export function graph(list, sessions, t, wall, guessed = new Set()) {
  const nodes = [];
  for (const a of list) {
    const s = sessions.get(a.address);
    nodes.push({ key: a.address, name: a.name, role: a.label, title: a.title || null, guessed: guessed.has(a.address), model: s?.model ?? null, status: a.status, color: tone(s?.model, t, a.app), program: a.program, parent: a.parent, session: s, terminal: a.address, names: [a.address, a.label] });
    for (const k of visibleSubs(s, wall)) {
      nodes.push({ key: k.id, name: k.type, role: k.type, title: k.description || null, guessed: guessed.has(a.address), model: k.model, status: k.status, color: tone(k.model, t, a.app), program: a.program, parent: a.address, session: k, names: [k.id, k.type] });
    }
  }
  // The first node that answers to a name, as a search in order would find it.
  const byName = new Map();
  for (const n of nodes) for (const name of n.names) if (name != null && !byName.has(name)) byName.set(name, n);
  const find = (to) => byName.get(to);
  const events = [];
  for (const n of nodes) {
    const s = n.session;
    for (const m of s?.sends ?? []) {
      const to = find(m.to);
      if (to && to !== n) events.push({ t: m.t, from: n.key, to: to.key, kind: "message" });
    }
    for (const m of s?.recvs ?? []) {
      const from = find(m.from);
      if (from && from !== n && !from.session) events.push({ t: m.t, from: from.key, to: n.key, kind: "message" });
    }
    for (const x of s?.recent ?? []) {
      const sub = find(x.delegate ?? x.hint);
      if (x.delegate && sub) events.push({ t: x.t, from: n.key, to: sub.key, kind: "delegates", label: x.hint });
      if (x.back && sub) events.push({ t: x.t, from: sub.key, to: n.key, kind: "came back" });
    }
  }
  return { nodes, byKey: new Map(nodes.map((n) => [n.key, n])), events: events.filter((e) => e.t).sort((x, y) => x.t - y.t) };
}

// Messages lately, one per direction between two agents, newest first.
export function links(g, now) {
  const found = new Map();
  const name = (key) => g.byKey.get(key)?.name ?? key;
  const role = (key) => g.byKey.get(key)?.role ?? name(key);
  for (const e of g.events) {
    if (e.kind !== "message" || now - e.t > LINK_MS) continue;
    const id = `${e.from}>${e.to}`;
    const l = found.get(id) ?? { from: e.from, to: e.to, fromName: name(e.from), toName: name(e.to), fromRole: role(e.from), toRole: role(e.to), n: 0, last: 0 };
    l.n++;
    l.last = Math.max(l.last, e.t);
    found.set(id, l);
  }
  return [...found.values()].sort((x, y) => y.last - x.last);
}

// Agents the lead started and subagents inside its process, as one list of boxes.
export function kids(lead, list, sessions, t, wall, guessed = new Set()) {
  const inner = visibleSubs(sessions.get(lead.address), wall).map((k) => ({
    id: k.id, title: k.type, agent: lead.name, sub: k.description, status: k.status, model: k.model,
    tools: k.tools, more: k.more, ctx: k.ctx, now: k.now, recent: k.recent, color: tone(k.model, t, lead.app),
    startedAt: k.startedAt, lastAt: k.lastAt, program: lead.program, nested: [], guessed: guessed.has(lead.address),
  }));
  const started = list.filter((k) => k.parent === lead.address).map((k) => {
    const s = sessions.get(k.address);
    // A second tier: what this agent delegated in turn.
    const nested = [
      ...list.filter((g) => g.parent === k.address).map((g) => {
        const gs = sessions.get(g.address);
        return { id: g.address, address: g.address, name: g.label ?? g.name, model: gs?.model ?? null, status: g.status, color: tone(gs?.model, t, g.app) };
      }),
      ...visibleSubs(s, wall).map((g) => ({ id: g.id, name: g.type, model: g.model, status: g.status, color: tone(g.model, t, k.app) })),
    ];
    return {
      id: k.address, address: k.address, title: k.label ?? k.name, label: k.label, agent: k.name, sub: k.title, status: k.status,
      model: s?.model ?? null, tools: s?.tools ?? null, ctx: s?.ctx ?? 0, now: s?.now, recent: s?.recent ?? [],
      color: tone(s?.model, t, k.app), lastAt: s?.lastAt, program: k.program, nested, guessed: guessed.has(k.address),
    };
  });
  return [...started, ...inner].sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
