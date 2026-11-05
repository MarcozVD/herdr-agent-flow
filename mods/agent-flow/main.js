// A live diagram of how agents work together: one lead, what it delegated, what came back.
// Herdr gives the agents, their `hc run` children and plain terminals; scan.cjs adds each
// agent's model and tools, and the subagents Claude Code and opencode run inside their own
// process. Agents draw as boxes in the flow, plain terminals only as a list under it: they
// run things, they don't take part. There's no real percentage for an agent's work, so bars
// show running or finished, and numbers are counted, never guessed.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, theme, props, run, exec, appHome, closeOverlay, layout } from "herdr";
import * as demo from "./demo.js";

const MOD = "agent-flow";
const FONT = "JetBrains Mono";
const SCAN_MS = 3000;
const LOG_ROWS = 40;
const KID_MAX = 250;
const SHORT = 620;      // below this height the log gives its rows to the diagram
const NARROW = 500;     // below this the flow becomes a list: a side panel is 368 wide
const LINK_MS = 10 * 60000; // how long a message between agents stays drawn
const LINK_LIVE_MS = 90000; // and how long it counts as happening now
const MAX_LANES = 3;
const SPIN = ["◐", "◓", "◑", "◒"];
const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
const SCANNED = ["opencode", "codex"]; // agents whose folder scan.cjs must be told

function modelName(m) {
  const hit = /claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(m ?? "");
  if (!hit) return m ?? null;
  return `${hit[1][0].toUpperCase()}${hit[1].slice(1)} ${hit[2]}${hit[3] ? `.${hit[3]}` : ""}`;
}

function tone(model, t, app) {
  if (/opus/.test(model ?? "")) return t.ansi5;
  if (/sonnet/.test(model ?? "")) return t.ansi3;
  if (/haiku/.test(model ?? "")) return t.ansi4;
  if (/fable/.test(model ?? "")) return t.ansi2;
  if (app === "opencode") return t.ansi6;
  if (app === "codex") return t.ansi2;
  return t.accent;
}

const stateColor = (s, t) => ({ working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, stale: t.unknown })[s] ?? t.dim;
const stateWord = (s) => ({ working: "running", blocked: "needs you", done: "done", idle: "idle", stale: "no activity" })[s] ?? s ?? "";

const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n ?? 0}`);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const count = (n, more) => `${more ? "≥" : ""}${n} tool${n === 1 ? "" : "s"}`;
const toolLine = (x) => (x ? `${x.name}${x.hint ? ` ${x.hint}` : ""}` : "");
const clean = (s) => (s ?? "").replace(/^OC \| /, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function appOf(k) {
  const app = k.report?.app ?? k.program?.key ?? null;
  return app === "claude" ? "claude-code" : app;
}

const isAgent = (k) => !!(k.report || k.program?.agent);

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Whether a copy in the layout is on screen: copies stay alive hidden, and scanning for a
// closed panel would run node every few seconds for nothing. Not in the layout (an overlay,
// a pane) means it's up.
function has(node) {
  return node?.content?.mod === MOD || (node?.children ?? []).some(has);
}
function showing(node) {
  if (node?.content?.mod === MOD) return true;
  return (node?.children ?? []).some((c) => !c.hidden && (node.type !== "stack" || node.active === c.id) && showing(c));
}
const visible = () => props()?.overlay || panes().some((p) => p.mod === MOD) || !has(layout()) || showing(layout());

// Sessions don't name their terminal, so they pair up by agent and folder; with several of
// one agent in a folder, the busiest terminal takes the most recently active session.
function pair(list, sessions) {
  const free = [...sessions];
  const found = new Map();
  for (const a of [...list].sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9))) {
    const i = free.findIndex((s) => s.agent === a.app && norm(s.cwd) === norm(a.cwd));
    if (i >= 0) found.set(a.address, free.splice(i, 1)[0]);
  }
  return found;
}

// A turn's subagents, or else the last ones that finished in the past quarter hour.
function visibleSubs(s) {
  if (!s?.subs) return [];
  const turn = s.subs.filter((k) => k.status === "working" || k.lastAt >= s.turnAt);
  return turn.length ? turn : s.subs.filter((k) => Date.now() - k.lastAt < 15 * 60000);
}

// Every agent in the space and subagent in a session, and what passed between them. `to`
// in a send is an address, a terminal name, a subagent id or type, so it resolves here; a
// target that isn't one (another space, a finished terminal) stays in the log only. Agents
// with no transcript show through the tags on what they sent to agents that have one.
function graph(list, sessions, t) {
  const nodes = [];
  for (const a of list) {
    const s = sessions.get(a.address);
    nodes.push({ key: a.address, name: a.name, model: s?.model ?? null, color: tone(s?.model, t, a.app), program: a.program, parent: a.parent, session: s, names: [a.address, a.label] });
    for (const k of visibleSubs(s)) {
      nodes.push({ key: k.id, name: k.type, model: k.model, color: tone(k.model, t, a.app), program: a.program, parent: a.address, session: k, names: [k.id, k.type] });
    }
  }
  const find = (to) => nodes.find((n) => n.names.includes(to));
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
  return { nodes, events: events.filter((e) => e.t).sort((x, y) => x.t - y.t) };
}

// Messages lately, one per direction between two agents.
function links(g, now) {
  const found = new Map();
  const name = (key) => g.nodes.find((n) => n.key === key)?.name ?? key;
  for (const e of g.events) {
    if (e.kind !== "message" || now - e.t > LINK_MS) continue;
    const id = `${e.from}>${e.to}`;
    const l = found.get(id) ?? { from: e.from, to: e.to, fromName: name(e.from), toName: name(e.to), n: 0, last: 0 };
    l.n++;
    l.last = Math.max(l.last, e.t);
    found.set(id, l);
  }
  return [...found.values()].sort((x, y) => y.last - x.last);
}

export default class AgentFlow extends View {
  init(_props, cx) {
    this.demo = !!props()?.demo;
    this.pick = this.demo ? "t1" : null; // the chosen lead; null follows focus
    this.space = null;      // the space shown; changing it starts over
    this.lastLead = null;
    this.kid = null;        // the box shown in the side panel; null is the lead
    this.scan = this.demo ? demo.scan : { sessions: [] };
    this.raw = "";
    this.busy = false;
    this.error = null;
    this.status = {};       // address -> last status, to log changes
    this.events = [];
    this.view = props()?.view === "timeline" ? "timeline" : "diagram";
    this.expanded = false;  // "+N more" asked for every box, as a list
    this.width = 900;
    this.height = 800;
    if (this.demo) return;
    this.refresh(cx);
    cx.timer.every(SCAN_MS, (cx) => this.refresh(cx));
  }

  now() {
    return this.demo ? demo.now : Date.now();
  }

  refresh(cx) {
    if (this.busy || !visible()) return;
    const list = this.world().agents;
    const asks = list.filter((a) => SCANNED.includes(a.app)).map((a) => `${a.app}=${a.cwd}`);
    if (!asks.length && !list.some((a) => a.app === "claude-code")) {
      if (this.scan.sessions.length) { this.scan = { sessions: [] }; this.raw = ""; cx.notify(); }
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", ["--no-warnings", `${appHome()}/mods/${MOD}/scan.cjs`, ...asks]);
        const error = r.code ? r.stderr.trim().split("\n").pop() : null;
        if (!r.code && r.stdout !== this.raw) {
          this.raw = r.stdout;
          this.scan = JSON.parse(r.stdout);
          cx.notify();
        }
        if (error !== this.error) { this.error = error; cx.notify(); }
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
      this.busy = false;
    });
  }

  // Every live terminal as one shape, split into agents and plain terminals.
  world() {
    const raw = (this.demo ? demo.terminals : terminals()).filter((k) => k.state === "live");
    const listed = new Map((this.demo ? [] : agents()).map((a) => [a.address, a]));
    const all = raw.map((k) => {
      const seen = listed.get(k.address);
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
    const flags = new Map(raw.map((k) => [k.address, isAgent(k)]));
    return { agents: all.filter((k) => flags.get(k.address)), plain: all.filter((k) => !flags.get(k.address)) };
  }

  chosen(leads, list) {
    const f = this.demo ? null : focused()?.terminal;
    const asked = list.find((a) => a.address === (this.pick ?? f));
    const top = asked?.parent && leads.find((a) => a.address === asked.parent);
    const lead = top ?? leads.find((a) => a.address === asked?.address) ?? leads.find((a) => a.address === this.lastLead) ?? leads[0] ?? null;
    this.lastLead = lead?.address ?? null;
    return lead;
  }

  // Agents it started and subagents inside its process, as one list of boxes.
  kids(lead, list, sessions, t) {
    const inner = visibleSubs(sessions.get(lead.address)).map((k) => ({
      id: k.id, title: k.type, agent: lead.name, sub: k.description, status: k.status, model: k.model,
      tools: k.tools, more: k.more, ctx: k.ctx, now: k.now, recent: k.recent, color: tone(k.model, t, lead.app),
      startedAt: k.startedAt, lastAt: k.lastAt, program: lead.program, nested: [],
    }));
    const started = list.filter((k) => k.parent === lead.address).map((k) => {
      const s = sessions.get(k.address);
      // A second tier: what this agent delegated in turn.
      const nested = [
        ...list.filter((g) => g.parent === k.address).map((g) => {
          const gs = sessions.get(g.address);
          return { id: g.address, address: g.address, name: g.label ?? g.name, model: gs?.model ?? null, status: g.status, color: tone(gs?.model, t, g.app) };
        }),
        ...visibleSubs(s).map((g) => ({ id: g.id, name: g.type, model: g.model, status: g.status, color: tone(g.model, t, k.app) })),
      ];
      return {
        id: k.address, address: k.address, title: k.label ?? k.name, label: k.label, agent: k.name, sub: k.title, status: k.status,
        model: s?.model ?? null, tools: s?.tools ?? null, ctx: s?.ctx ?? 0, now: s?.now, recent: s?.recent ?? [],
        color: tone(s?.model, t, k.app), lastAt: s?.lastAt, program: k.program, nested,
      };
    });
    return [...started, ...inner].sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  track(list) {
    for (const a of list) {
      const was = this.status[a.address];
      if (was && was !== a.status) {
        this.events.push({ t: Date.now(), address: a.address, who: a.name, text: `${a.address} ${was} → ${a.status}`, status: a.status });
        this.events = this.events.slice(-LOG_ROWS);
      }
      this.status[a.address] = a.status;
    }
  }

  logRows(lead, session, kids, list, t) {
    const who = modelName(session?.model) ?? lead.name;
    const color = tone(session?.model, t, lead.app);
    const named = (to) => (to === lead.address ? lead.name : kids.find((k) => [k.address, k.label, k.id, k.title].includes(to))?.agent) ?? to;
    const said = (x) => (x.to ? `messages ${named(x.to)}` : toolLine(x));
    const here = new Set(list.map((a) => a.address));
    const rows = this.events.filter((e) => here.has(e.address)).map((e) => ({ t: e.t, who: e.who, text: e.text, color: stateColor(e.status, t) }));
    for (const x of session?.recent ?? []) {
      rows.push({ t: x.t, who, color, text: x.delegate ? `delegates to ${x.delegate} · ${x.hint}` : x.back ? `${x.hint} came back` : said(x) });
    }
    for (const k of session?.subs ?? []) {
      for (const x of k.recent ?? []) rows.push({ t: x.t, who: k.type, color: tone(k.model, t, lead.app), text: said(x) });
    }
    for (const k of kids) {
      if (k.address) for (const x of k.recent ?? []) rows.push({ t: x.t, who: k.agent, color: k.color, text: said(x) });
    }
    return rows.filter((r) => r.t).sort((a, b) => a.t - b.t).slice(-LOG_ROWS);
  }

  /* ------- pieces ------- */

  button(id, label, t, fn) {
    return div().id(id).px(6).rounded(3).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }

  dot(color, live) {
    return div().w(7).h(7).rounded(4).flex_none().bg(color).when(live, (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  }

  mark(status, t) {
    const el = div().text_color(stateColor(status, t)).flex_none();
    return status === "working" ? el.frames(SPIN, 160) : el.child(status === "done" ? "●" : status === "blocked" ? "◆" : "○");
  }

  // Running slides, because nothing knows how far along it is; finished is full.
  bar(status, color, t, width) {
    const track = div().w_full().h(6).flex_none().rounded(2).bg(t.raised).overflow_hidden().relative();
    if (status === "working") return track.child(div().absolute().top(0).w(56).h(6).rounded(2).bg(color).loop("left", { from: -56, to: width, period: 1800 }));
    if (status === "done") return track.child(div().size_full().bg(color));
    if (status === "blocked") return track.child(div().size_full().bg(color).loop("opacity", { from: 0.4, to: 1, period: 900 }));
    return track;
  }

  // Lines joining one point to n boxes (or, with `up`, n boxes back to one point). Dots run
  // along the lines of what's live.
  fan(kids, t, up) {
    const clear = "#00000000";
    const mid = (kids.length - 1) / 2;
    // A live box's path runs along the bar from the middle to it: the color of the first
    // one whose path covers this piece, in cell positions.
    const along = (from, to) => kids.find((k, i) => k.status === "working" && Math.min(i, mid) <= from && to <= Math.max(i, mid))?.color ?? t.border;
    return h_flex().w_full().h(20).flex_none().children(kids.map((k, i) => {
      const half = (show, from, to) => div().flex_1().h_full().flex().flex_col().when(up, (e) => e.justify_end())
        .child(div().w_full().h(1).bg(show ? along(from, to) : clear));
      const live = k.status === "working";
      const stem = div().w(1).h_full().bg(live ? k.color : t.border).relative()
        .when(live, (e) => e.child(div().absolute().left(-2).w(5).h(5).rounded(3).bg(k.color)
          .loop("top", { from: 0, to: 14, period: 1500 + i * 170, easing: "linear" })));
      return h_flex().flex_1().h_full().child(half(i > 0, i - 0.5, i)).child(stem).child(half(i < kids.length - 1, i, i + 0.5));
    }));
  }

  // Messages between siblings: a line of its own under the boxes, an arrow at the receiver,
  // a dot running while it's happening.
  lanes(shown, list, t, room, bg) {
    const cell = room / shown.length;
    const x = (id) => (shown.findIndex((k) => k.id === id) + 0.5) * cell;
    const now = this.now();
    return v_flex().w_full().flex_none().children(list.slice(0, MAX_LANES).map((l, i) => {
      const a = Math.round(x(l.from));
      const b = Math.round(x(l.to));
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const live = now - l.last < LINK_LIVE_MS;
      const color = live ? shown.find((k) => k.id === l.from).color : t.dim;
      const tick = (at) => div().absolute().top(0).left(at).w(1).h(8).bg(color);
      return div().id(`lane-${i}`).relative().w_full().h(18).flex_none()
        .child(tick(left)).child(tick(right))
        .child(div().absolute().top(8).left(left).w(right - left).h(1).bg(color))
        .when(live, (e) => e.child(div().absolute().top(6).w(5).h(5).rounded(3).bg(color).loop("left", { from: left, to: right, period: 1600, easing: "linear" })))
        .child(div().absolute().top(2).left(b - 4).text_size(9).text_color(color).child(b > a ? "▶" : "◀"))
        .child(h_flex().absolute().top(0).left(left).w(right - left).h(16).justify_center().items_center()
          .child(div().px(5).bg(bg).max_w(right - left - 20).truncate().text_size(11).text_color(live ? t.foreground : t.muted)
            .child(`${l.fromName} → ${l.toName}${l.n > 1 ? ` ×${l.n}` : ""}`)));
    }));
  }

  // What a box delegated in turn, as rows inside it.
  nested(k, t) {
    return (k.nested ?? []).slice(0, 3).map((n) => h_flex().id(`nested-${n.id}`).w_full().gap(5).items_center()
      .when(!!n.address, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.peek(n.address); }))
      .child(div().flex_none().text_color(t.dim).child("└"))
      .child(this.mark(n.status, t))
      .child(div().flex_1().min_w(0).truncate().text_color(n.color).child(`${n.name}${n.model ? ` · ${modelName(n.model)}` : ""}`)));
  }

  // Messages with the lead, on the box: sent up and received.
  talk(k, flows, lead) {
    const up = flows.find((l) => l.from === k.id && l.to === lead)?.n ?? 0;
    const down = flows.find((l) => l.from === lead && l.to === k.id)?.n ?? 0;
    return [up ? `↑${up}` : "", down ? `↓${down}` : ""].filter(Boolean).join(" ");
  }

  stem(color, h = 14) {
    return div().w(1).h(h).bg(color).flex_none();
  }

  // The two lines every agent gets: which agent, and which model.
  who(name, model, program, color, t) {
    return v_flex().items_center().gap(1).w_full()
      .child(h_flex().gap(6).items_center().max_w_full()
        .child(icon(program, 14, color) ?? div())
        .child(div().truncate().font_semibold().text_color(t.foreground).child(name)))
      .child(div().w_full().text_center().truncate().text_color(model ? color : t.dim).child(modelName(model) ?? "model unknown"));
  }

  leadBox(lead, session, t, full) {
    const color = tone(session?.model, t, lead.app);
    const tools = session?.tools;
    return v_flex().id("lead").when(full, (e) => e.w_full()).when(!full, (e) => e.w(300).max_w_full()).p(9).gap(3).items_center().flex_none().bg(t.background)
      .border(this.kid === null ? 2 : 1).border_color(color).cursor_pointer()
      .on_click((_e, cx) => { this.kid = null; cx.notify(); })
      .child(this.who(lead.name, session?.model, lead.program, color, t))
      .child(div().w_full().text_center().truncate().text_color(t.foreground).child(lead.title || lead.address))
      .child(h_flex().gap(6).max_w_full().items_center().text_color(t.muted)
        .child(this.mark(lead.status, t))
        .child(div().truncate().child(session?.now ? toolLine(session.now) : stateWord(lead.status))))
      .when(tools != null, (e) => e.child(h_flex().gap(10).text_color(t.dim)
        .child(`${count(tools, session.more)} this turn`)
        .when(session.ctx > 0, (x) => x.child(`ctx ${tokens(session.ctx)}`))));
  }

  kidBox(k, t, width, flows) {
    const quiet = k.status === "stale";
    const color = quiet ? t.border : k.color;
    const tight = width < 170; // four boxes side by side: drop what the detail panel repeats
    const name = k.address || tight ? (k.address ? k.agent : k.title) : `${k.agent} · ${k.title}`;
    return v_flex().id(`kid-${k.id}`).w_full().max_w(KID_MAX).p(8).gap(4).items_center().bg(t.background)
      .border(this.kid === k.id ? 2 : 1).border_color(color).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.kid = this.kid === k.id ? null : k.id; cx.notify(); })
      .child(this.who(name, k.model, k.program, k.color, t))
      .child(this.bar(k.status, k.color, t, width))
      .child(div().w_full().text_center().truncate().text_color(t.muted).child(k.now ? toolLine(k.now) : k.sub || " "))
      .child(h_flex().gap(6).items_center().text_color(t.dim)
        .child(this.mark(k.status, t)).child(stateWord(k.status))
        .when(k.tools != null && !tight, (e) => e.child(`· ${count(k.tools, k.more)}`))
        .when(!!this.talk(k, flows, this.lastLead), (e) => e.child(div().text_color(t.foreground).child(this.talk(k, flows, this.lastLead)))))
      .children(this.nested(k, t));
  }

  backBox(lead, session, kids, t, full) {
    const open = kids.filter((k) => k.status === "working").length;
    const color = tone(session?.model, t, lead.app);
    return v_flex().when(full, (e) => e.w_full()).when(!full, (e) => e.w(300).max_w_full()).p(7).items_center().flex_none().bg(t.background)
      .border(1).border_color(open ? t.border : color)
      .child(div().text_color(open ? t.muted : color).font_semibold().child(`back to ${lead.name}`))
      .child(div().text_color(t.dim).child(open ? `waiting on ${open} of ${kids.length}` : `${kids.length} of ${kids.length} back`));
  }

  // Tools of the box that's open, in narrow views, where there's no side panel to show them.
  details(k, t) {
    return v_flex().gap(1).pt(2).children([
      ...(k.sub ? [div().text_color(t.muted).child(k.sub)] : []),
      ...(k.recent ?? []).slice(-5).map((x) => div().truncate().text_color(t.foreground).child(`» ${toolLine(x)}`)),
      ...(k.address ? [this.button(`peek-${k.id}`, "peek terminal", t, () => this.peek(k.address))] : []),
    ]);
  }

  // The rail down the left edge carries a live box's color from the lead to that box.
  listRow(k, t, rail, flows) {
    const open = this.kid === k.id;
    const name = k.address ? k.agent : `${k.agent} · ${k.title}`;
    return h_flex().w_full().items_stretch().child(div().w(1).flex_none().bg(rail))
      .child(div().w(13).h(1).mt(16).flex_none().bg(k.status === "working" ? k.color : t.border))
      .child(v_flex().id(`kid-${k.id}`).flex_1().min_w(0).mb(6).p(7).gap(3).bg(t.background)
        .border(open ? 2 : 1).border_color(k.status === "stale" ? t.border : k.color).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.kid = open ? null : k.id; cx.notify(); })
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(this.mark(k.status, t))
          .child(icon(k.program, 13, k.color) ?? div())
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
          .when(k.tools != null, (e) => e.child(div().flex_none().text_color(t.dim).child(count(k.tools, k.more)))))
        .child(div().truncate().text_color(k.model ? k.color : t.dim).child(modelName(k.model) ?? "model unknown"))
        .child(this.bar(k.status, k.color, t, this.width))
        .child(div().truncate().text_color(t.muted).child(k.now ? toolLine(k.now) : k.sub || stateWord(k.status)))
        .when(!!this.talk(k, flows, this.lastLead), (e) => e.child(div().text_color(t.foreground).child(this.talk(k, flows, this.lastLead))))
        .children(this.nested(k, t))
        .when(open, (e) => e.child(this.details(k, t))));
  }

  // Not agents: what the lead started to run. Flat chips under the flow, never part of it.
  plainList(list, t) {
    return h_flex().w_full().flex_none().flex_wrap().gap(6).items_center()
      .child(div().flex_none().text_color(t.dim).child("terminals"))
      .children(list.map((k) => h_flex().id(`term-${k.address}`).gap(5).px(5).items_center().rounded(3).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => this.peek(k.address))
        .child(div().flex_none().text_color(t.dim).child("›_"))
        .child(div().max_w(150).truncate().text_color(t.muted).child(k.label ?? k.name))));
  }

  // A sequence diagram of the whole space: a column per agent, a row per thing that passed
  // between two of them, oldest on top. Flows that never touch the chosen lead show too.
  timeline(lead, g, t, room, bg) {
    const gutter = room >= 560 ? 64 : 0;
    const active = new Set(g.events.flatMap((e) => [e.from, e.to]));
    const cols = [...g.nodes].sort((a, b) => (b.key === lead.address) - (a.key === lead.address) || active.has(b.key) - active.has(a.key))
      .slice(0, Math.max(2, Math.floor((room - gutter) / 92)));
    const cell = (room - gutter) / cols.length;
    const x = (key) => Math.round(gutter + (cols.findIndex((c) => c.key === key) + 0.5) * cell);
    const shown = new Set(cols.map((c) => c.key));
    const rows = g.events.filter((e) => shown.has(e.from) && shown.has(e.to)).slice(-Math.max(4, Math.floor((this.height - 330) / 24)));
    const now = this.now();
    const lifelines = () => cols.map((c) => div().absolute().top(0).left(x(c.key)).w(1).h_full().bg(t.border));
    const header = div().relative().w_full().h(40).flex_none().children(cols.map((c, i) =>
      v_flex().absolute().top(0).left(Math.round(gutter + i * cell)).w(Math.floor(cell)).px(3).items_center()
        .child(h_flex().gap(4).max_w_full().items_center().child(icon(c.program, 12, c.color) ?? div())
          .child(div().truncate().font_semibold().child(c.name)))
        .child(div().max_w_full().truncate().text_color(c.model ? c.color : t.dim).child(modelName(c.model) ?? "model unknown"))));
    const line = (e, i) => {
      const a = x(e.from);
      const b = x(e.to);
      const left = Math.min(a, b);
      const width = Math.max(a, b) - left;
      const color = e.kind === "came back" ? t.dim : g.nodes.find((n) => n.key === e.from).color;
      const live = now - e.t < LINK_LIVE_MS;
      return div().id(`row-${i}`).relative().w_full().h(24).flex_none().children(lifelines())
        .when(gutter > 0, (r) => r.child(div().absolute().top(4).left(0).text_color(t.dim).child(clock(e.t))))
        .child(div().absolute().top(12).left(left).w(width).h(1).bg(color))
        .when(live, (r) => r.child(div().absolute().top(10).w(5).h(5).rounded(3).bg(color).loop("left", { from: left, to: left + width, period: 1600, easing: "linear" })))
        .child(div().absolute().top(6).left(b - 4).text_size(9).text_color(color).child(b > a ? "▶" : "◀"))
        .child(h_flex().absolute().top(3).left(left).w(width).justify_center()
          .child(div().px(5).bg(bg).max_w(Math.max(30, width - 20)).truncate().text_size(11).text_color(t.muted).child(e.label ?? e.kind)));
    };
    const flow = v_flex().id("flow").flex_1().min_w(0).h_full().overflow_y_scroll().child(header);
    if (!rows.length) return flow.child(v_flex().w_full().pt(20).items_center().text_color(t.dim).child("Nothing has passed between agents yet"));
    return flow.child(div().relative().w_full().h(8).flex_none().children(lifelines())).children(rows.map(line));
  }

  flow(lead, session, kids, g, t, room, bg) {
    const narrow = room < NARROW || this.expanded;
    const flow = v_flex().id("flow").flex_1().min_w(0).h_full().items_center().overflow_y_scroll().child(this.leadBox(lead, session, t, narrow));
    if (!kids.length) return flow.child(this.stem(t.border, 16)).child(div().text_color(t.dim).pb(4).child("no agents delegated"));
    const models = [...new Set(kids.map((k) => modelName(k.model)).filter(Boolean))];
    const flows = links(g, this.now());
    if (narrow) {
      const railAt = (i) => kids.slice(i).find((k) => k.status === "working")?.color ?? t.border;
      return flow.child(h_flex().w_full().child(this.stem(railAt(0), 10)))
        .child(v_flex().w_full().children(kids.map((k, i) => this.listRow(k, t, railAt(i), flows))))
        .when(this.expanded, (e) => e.child(h_flex().w_full().pl(14).child(this.button("collapse", "back to the diagram", t, () => { this.expanded = false; }))))
        .child(v_flex().w_full().flex_none().children(flows.filter((l) => l.from !== lead.address && l.to !== lead.address && kids.some((k) => k.id === l.from || k.id === l.to)).slice(0, MAX_LANES).map((l) =>
          div().pl(14).truncate().text_color(t.muted).child(`⇄ ${l.fromName} → ${l.toName}${l.n > 1 ? ` ×${l.n}` : ""}`))))
        .child(h_flex().w_full().child(this.stem(t.border, 4)))
        .child(this.backBox(lead, session, kids, t, true));
    }
    const shown = kids.slice(0, Math.max(1, Math.min(4, Math.floor(room / 150))));
    const low = this.height < SHORT;
    const ids = new Set(shown.map((k) => k.id));
    const peers = flows.filter((l) => ids.has(l.from) && ids.has(l.to));
    const trunk = shown.find((k) => k.status === "working")?.color ?? t.border;
    return flow.child(this.stem(trunk, low ? 4 : 14))
      .when(!low, (e) => e.child(h_flex().gap(6).max_w_full().text_color(t.muted).child(div().flex_none().child("delegates to"))
        .when(models.length > 0, (x) => x.child(div().truncate().text_color(t.dim).child(models.join(", "))))).child(this.stem(trunk, 8)))
      .child(this.fan(shown, t, false))
      .child(h_flex().w_full().items_stretch().children(shown.map((k) => h_flex().flex_1().min_w(0).px(5).justify_center().items_stretch()
        .child(this.kidBox(k, t, Math.min(KID_MAX, room / shown.length) - 28, flows)))))
      .when(peers.length > 0, (e) => e.child(this.lanes(shown, peers, t, room, bg)))
      .child(this.fan(shown, t, true))
      .when(kids.length > shown.length, (e) => e.child(this.button("more", `+${kids.length - shown.length} more`, t, () => { this.expanded = true; })))
      .child(this.stem(trunk, low ? 2 : 8))
      .child(this.backBox(lead, session, kids, t));
  }

  row(key, value, t, color) {
    return h_flex().justify_between().gap(8).child(div().text_color(t.dim).flex_none().child(key))
      .child(div().truncate().text_color(color ?? t.foreground).child(String(value)));
  }

  side(lead, session, kids, t) {
    const k = kids.find((x) => x.id === this.kid) ?? null;
    const model = k ? k.model : session?.model;
    const color = k ? k.color : tone(model, t, lead.app);
    const list = (k ? k.recent : session?.recent) ?? [];
    const tools = k ? k.tools : session?.tools;
    const panel = v_flex().w(226).h_full().flex_none().p(10).gap(5).bg(t.background).border(1).border_color(color).overflow_hidden()
      .child(this.who(k ? k.agent : lead.name, model, k ? k.program : lead.program, color, t))
      .child(div().truncate().text_center().text_color(t.muted).child(k ? (k.address ? `${k.title} · ${k.address}` : `${k.title} · subagent`) : `${lead.address} · lead`))
      .child(div().h(1).bg(t.border).flex_none())
      .child(this.row("state", stateWord(k ? k.status : lead.status), t, stateColor(k ? k.status : lead.status, t)));
    if (tools != null) panel.child(this.row("tools", `${(k ?? session).more ? "≥" : ""}${tools}${k ? "" : " this turn"}`, t));
    if ((k ?? session)?.ctx) panel.child(this.row("context", tokens((k ?? session).ctx), t));
    if (k?.startedAt) panel.child(this.row("ran for", elapsed((k.status === "working" ? Date.now() : k.lastAt) - k.startedAt), t));
    if (!k && session?.total) panel.child(this.row("subagents", session.total, t));
    if (k?.sub) panel.child(div().mt(4).text_color(t.muted).child(k.sub));
    panel.child(div().mt(4).text_color(t.dim).child("last tools"));
    panel.child(v_flex().flex_1().min_h(0).gap(1).overflow_hidden().children(
      (list.length ? list.filter((x) => !x.back).slice(-8) : [{ name: "none seen", hint: "" }]).map((x, i) =>
        div().id(`tool-${i}`).truncate().text_color(t.foreground).child(`» ${toolLine(x)}`))));
    if (!k || k.address) {
      panel.child(this.button("go", k ? "peek terminal" : "go to terminal", t, () => {
        if (this.demo) return;
        if (k) this.peek(k.address);
        else { run("agent.focus", { terminal: lead.address }); this.close(); }
      }));
    }
    return panel;
  }

  peek(address) {
    if (!this.demo) run("terminal.peek", { terminal: address });
  }

  switcher(t) {
    const tab = (id, label) => div().id(`view-${id}`).px(6).rounded(3).cursor_pointer()
      .bg(this.view === id ? t.selected : "#00000000").text_color(this.view === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.view = id; cx.notify(); }).child(label);
    return h_flex().gap(2).flex_none().child(tab("diagram", "Diagram")).child(tab("timeline", "Timeline"));
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  chips(leads, lead, t) {
    return h_flex().gap(6).flex_wrap().flex_none().children(leads.map((a) => {
      const on = a.address === lead.address;
      return h_flex().id(`lead-${a.address}`).gap(5).px(7).py(2).items_center().rounded(3).cursor_pointer()
        .bg(on ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick = a.address; this.kid = null; cx.notify(); })
        .child(this.dot(stateColor(a.status, t), a.status === "working"))
        .child(icon(a.program, 12, t.muted) ?? div())
        .child(div().text_color(on ? t.foreground : t.muted).max_w(170).truncate().child(`${a.name} · ${a.title || a.address}`));
    }));
  }

  logBox(rows, t, narrow) {
    const short = this.height < SHORT;
    return v_flex().id("log").h(short ? 96 : 132).flex_none().p(8).gap(1).bg(t.background).border(1).border_color(t.border).overflow_hidden()
      .child(div().text_color(t.dim).child("session log"))
      .child(v_flex().flex_1().min_h(0).justify_end().overflow_hidden().children(rows.slice(short ? -3 : -6).map((r) =>
        h_flex().gap(narrow ? 6 : 10).when(!narrow, (e) => e.child(div().flex_none().text_color(t.dim).child(clock(r.t))))
          .child(div().w(narrow ? 76 : 92).flex_none().truncate().text_color(r.color).child(r.who))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.text)))));
  }

  render() {
    const t = theme();
    const { agents: all, plain } = this.world();
    // The space it's called from: props().space pins a copy to one space.
    const spaceId = this.demo ? null : props()?.space ?? focused()?.space ?? null;
    if (spaceId !== this.space) { this.space = spaceId; this.pick = this.demo ? "t1" : null; this.lastLead = null; this.kid = null; this.expanded = false; }
    const list = this.demo ? all : all.filter((a) => a.space === spaceId);
    const spaceName = this.demo ? "demo" : spaces().find((p) => p.id === spaceId)?.name ?? "this space";
    const live = new Set(list.map((a) => a.address));
    const leads = list.filter((a) => !a.parent || !live.has(a.parent))
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.seq - a.seq);
    const overlay = !!props()?.overlay;
    const root = v_flex().id("root").size_full().p(12).gap(9).bg(overlay ? t.canvas : t.chrome).font_family(FONT).text_size(12).text_color(t.foreground)
      .on_size_change((size, cx) => { this.width = size.width; this.height = size.height; cx.notify(); });
    const closer = overlay ? this.button("close", "✕", t, () => this.close()) : div();
    const lead = this.chosen(leads, list);
    if (!lead) {
      return root.child(h_flex().justify_between().child(div().font_semibold().child(spaceName)).child(closer))
        .child(v_flex().flex_1().items_center().justify_center().gap(4)
          .child(div().text_color(t.muted).child(`No agents in ${spaceName}`))
          .child(div().text_color(t.dim).child("Start one from the + menu and its work shows here")));
    }
    if (!this.demo) this.track(all);
    const sessions = pair(all, this.scan.sessions);
    const session = sessions.get(lead.address) ?? null;
    const kids = this.kids(lead, list, sessions, t);
    const g = graph(list, sessions, t);
    const mine = plain.filter((k) => k.parent === lead.address);
    const working = kids.filter((k) => k.status === "working").length;
    const wide = this.width >= 640;
    const narrow = this.width < NARROW;
    const room = this.width - 24 - (wide ? 236 : 0);
    const color = tone(session?.model, t, lead.app);

    return root
      .child(h_flex().items_center().justify_between().gap(10).flex_none()
        .child(h_flex().gap(8).flex_1().min_w(0).text_size(13).font_semibold()
          .child(div().max_w(180).truncate().flex_none().child(spaceName))
          .when(this.width >= 340, (e) => e.child(div().flex_none().text_color(t.dim).child("·"))
            .child(div().flex_1().min_w(0).truncate().text_color(color).child(modelName(session?.model) ?? lead.name)))
          .child(div().flex_none().text_color(working ? t.working : t.muted).child(`${working} RUNNING`)))
        .child(h_flex().gap(8).items_center().flex_none()
          .when(!!this.error, (e) => e.child(div().max_w(320).truncate().text_color(t.blocked).child(`no scan: ${this.error}`)))
          .when(this.demo && !narrow, (e) => e.child(div().text_color(t.dim).child("demo data")))
          .child(this.switcher(t))
          .child(closer)))
      .child(this.chips(leads, lead, t))
      .child(h_flex().flex_1().min_h(0).gap(10).items_start()
        .when(wide, (e) => e.child(this.side(lead, session, kids, t)))
        .child(this.view === "timeline" ? this.timeline(lead, g, t, room, overlay ? t.canvas : t.chrome) : this.flow(lead, session, kids, g, t, room, overlay ? t.canvas : t.chrome)))
      .when(mine.length > 0, (e) => e.child(this.plainList(mine, t)))
      .child(this.logBox(this.logRows(lead, session, kids, list, t), t, narrow));
  }
}
