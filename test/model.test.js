// model.js against the example data, checked for what RECIPE.md's "Done when" says the views
// show. The view itself needs Herdr; everything it draws is built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../mods/agent-flow/model.js";
import { choose, SHAPES } from "../mods/agent-flow/shapes.js";
import * as team from "../mods/agent-flow/examples/team.js";
import * as platform from "../mods/agent-flow/examples/platform.js";

// A theme whose colors are their own names, so a color says which key it came from.
const t = new Proxy({}, { get: (_, key) => String(key) });

function build(data) {
  const world = M.normalize(data.terminals, []);
  const live = new Set(world.agents.map((a) => a.address));
  const leads = world.agents.filter((a) => !a.parent || !live.has(a.parent));
  const { found, guessed } = M.pair(world.agents, data.scan.sessions);
  const g = M.graph(world.agents, found, t, data.now, guessed);
  const flows = M.links(g, data.now);
  const kids = M.kids(leads[0], world.agents, found, t, data.now, guessed);
  const routes = flows.filter((l) => g.byKey.get(l.to)?.parent !== l.from && g.byKey.get(l.from)?.parent !== l.to);
  const n = (from, to) => flows.find((l) => l.from === from && l.to === to)?.n ?? 0;
  return { world, leads, found, guessed, g, flows, kids, routes, n };
}

test("team: four leads, four terminals, nobody guessed", () => {
  const { leads, world, guessed } = build(team);
  assert.deepEqual(leads.map((a) => a.address), ["t1", "t4", "t6", "t8"]);
  assert.equal(world.plain.length, 4);
  assert.equal(guessed.size, 0);
});

test("team: the lead's boxes, most urgent first", () => {
  const { kids } = build(team);
  assert.deepEqual(kids.map((k) => [k.agent, k.status, M.modelName(k.model)]), [
    ["OpenCode", "blocked", "deepseek-v4.1-flash:free"],
    ["Claude Code", "working", "Sonnet 5.5"],
    ["Codex", "working", "gpt-5.5-codex"],
    ["Claude Code", "done", "Haiku 5.5"],
  ]);
  assert.deepEqual(kids[0].nested.map((k) => k.name), ["explore"]);
  assert.deepEqual(kids[2].nested.map((k) => k.name), ["rollback"]);
});

test("team: messages with the lead and between siblings", () => {
  const { kids, n, leads, routes } = build(team);
  const lead = leads[0].address;
  const [open, , codex] = kids;
  assert.deepEqual([n(open.id, lead), n(lead, open.id)], [1, 1]); // ↑1 ↓1
  assert.equal(n(lead, codex.id), 2); // ↓2
  const lanes = routes.map((l) => `${l.fromName} → ${l.toName}${l.n > 1 ? ` ×${l.n}` : ""}`);
  assert.ok(lanes.includes("audit → OpenCode"));
  assert.ok(lanes.includes("OpenCode → Codex ×2"));
});

test("team: the second lead's message reaches the first", () => {
  const { g } = build(team);
  assert.ok(g.events.some((e) => e.from === "t4" && e.to === "t1" && e.kind === "message"));
});

test("platform: 19 agents arranged in stages up to step 5", () => {
  const { g, routes, leads } = build(platform);
  assert.equal(g.nodes.length, 19);
  const shape = choose(g.nodes, routes);
  assert.equal(shape, "stages");
  const placed = SHAPES[shape](g.nodes, routes, { lead: leads[0].address, room: 900, W: 168, H: 44, height: 500 });
  assert.equal(placed.marks.at(-1).text, "step 5");
});

test("every shape places every agent", () => {
  const { g, routes, leads } = build(platform);
  for (const [name, shape] of Object.entries(SHAPES)) {
    const { pos } = shape(g.nodes, routes, { lead: leads[0].address, room: 900, W: 168, H: 44, height: 600 });
    for (const n of g.nodes) assert.ok(pos.has(n.key), `${name} places ${n.key}`);
  }
});

test("a folder with two of one agent is a guess, and says so", () => {
  const list = [
    { address: "a", app: "claude-code", cwd: "C:\\repo", status: "working" },
    { address: "b", app: "claude-code", cwd: "c:/repo/", status: "idle" },
    { address: "c", app: "claude-code", cwd: "/other", status: "idle" },
  ];
  const sessions = [
    { id: "s1", agent: "claude-code", cwd: "C:/Repo", model: "claude-opus-5-5" },
    { id: "s2", agent: "claude-code", cwd: "C:/Repo", model: "claude-haiku-5-5" },
    { id: "s3", agent: "claude-code", cwd: "/other", model: "claude-sonnet-5-5" },
  ];
  const { found, guessed } = M.pair(list, sessions);
  assert.equal(found.get("a").id, "s1"); // the busiest terminal takes the most recent session
  assert.equal(found.get("b").id, "s2");
  assert.deepEqual([...guessed].sort(), ["a", "b"]);
});

test("one terminal but two sessions in its folder is a guess too", () => {
  const { guessed } = M.pair(
    [{ address: "a", app: "claude-code", cwd: "/x", status: "working" }],
    [{ agent: "claude-code", cwd: "/x" }, { agent: "claude-code", cwd: "/x" }],
  );
  assert.ok(guessed.has("a"));
});

test("model names cut in the middle", () => {
  assert.equal(M.middle("deepseek-v4.1-flash:free", 14), "deepsee…h:free");
  assert.equal(M.middle("deepseek-v4.1-flash:free", 14).length, 14);
  assert.equal(M.middle("Opus 5.5", 14), "Opus 5.5");
  assert.equal(M.middle(null, 5), null);
});

test("model names and colors", () => {
  assert.equal(M.modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(M.modelName("claude-sonnet-5-5-20260101"), "Sonnet 5.5");
  assert.equal(M.modelName("gpt-5.5-codex"), "gpt-5.5-codex");
  assert.notEqual(M.tone(null, t, "codex"), M.tone("claude-fable-5-2", t, "claude-code"));
});

test("a terminal reporting pi is Oh My Pi", () => {
  const { agents } = M.normalize([{ address: "t1", state: "live", report: { app: "pi" } }], []);
  assert.equal(agents[0].app, "omp");
});

test("sessions traced to their terminal pair exactly, and aren't guesses", () => {
  const list = [
    { address: "a", app: "claude-code", cwd: "/repo", status: "working" },
    { address: "b", app: "claude-code", cwd: "/repo", status: "idle" },
    { address: "c", app: "claude-code", cwd: "/repo", status: "idle" },
  ];
  const sessions = [
    { id: "s1", agent: "claude-code", cwd: "/repo", terminal: "b" }, // most recent, but b's
    { id: "s2", agent: "claude-code", cwd: "/repo", terminal: "a" },
    { id: "s3", agent: "claude-code", cwd: "/repo", terminal: "elsewhere" }, // nobody else's
    { id: "s4", agent: "claude-code", cwd: "/repo" },
  ];
  const { found, guessed } = M.pair(list, sessions);
  assert.deepEqual([found.get("a").id, found.get("b").id, found.get("c").id], ["s2", "s1", "s4"]);
  assert.deepEqual([...guessed], []); // c was the only terminal left, with the only session left
});

test("normalize keeps each terminal's pid", () => {
  const { agents } = M.normalize([{ address: "t1", state: "live", pid: 24572, report: { app: "claude" } }], []);
  assert.equal(agents[0].pid, 24572);
});
