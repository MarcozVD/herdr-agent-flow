// scan.cjs against made-up Claude Code transcripts, written in the shape real ones have, in a
// throwaway config folder. Nothing here reads your own ~/.claude.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCAN = fileURLToPath(new URL("../mods/agent-flow/scan.cjs", import.meta.url));
const CWD = "/work/billing";
const SESSION = "11111111-2222-3333-4444-555555555555";
const SECRET = "SECRET-never-shown";
let home;

const at = (s) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString();
const ask = (s, text) => ({ type: "user", timestamp: at(s), message: { role: "user", content: text } });
const call = (s, id, name, input, model = "claude-opus-5-5") => ({
  type: "assistant", timestamp: at(s),
  message: { model, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id, name, input }] },
});
const result = (s, id) => ({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: `${SECRET} output` }] } });

// One turn: a message from another agent, a prompt, then a read, two messages out, a
// delegation that comes back, and a search still running.
const rows = [
  ask(0, `<hc from="t9 review">${SECRET} please look</hc>`),
  ask(1, `${SECRET} migrate the refunds table`),
  call(2, "tu1", "Read", { file_path: "/work/billing/refunds.ts" }),
  result(3, "tu1"),
  call(4, "tu2", "Bash", { command: `hc send t7 "${SECRET}"`, description: "Tell the migrator" }),
  result(5, "tu2"),
  call(6, "tu3", "SendMessage", { to: "reviewer", message: SECRET }),
  result(7, "tu3"),
  call(8, "tu4", "Agent", { subagent_type: "audit", description: "Audit the refund paths", prompt: SECRET }),
  result(9, "tu4"),
  call(10, "tu5", "Grep", { pattern: "issueRefund" }),
];
const lines = (list) => list.map((r) => JSON.stringify(r) + "\n").join("");

function setup(dir, transcript) {
  fs.rmSync(dir, { recursive: true, force: true });
  const slug = CWD.replace(/[^a-zA-Z0-9]/g, "-");
  const project = path.join(dir, "projects", slug);
  fs.mkdirSync(path.join(project, SESSION, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  // This test's own pid, so the session counts as alive.
  fs.writeFileSync(path.join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: CWD, startedAt: 0 }));
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), transcript);
  const sub = path.join(project, SESSION, "subagents", "agent-abc");
  fs.writeFileSync(`${sub}.jsonl`, lines([call(8, "s1", "Read", { file_path: "/work/billing/refunds.ts" }, "claude-haiku-5-5"), result(9, "s1")]));
  fs.writeFileSync(`${sub}.meta.json`, JSON.stringify({ agentType: "audit", description: "Audit the refund paths", finished: true }));
  return path.join(project, `${SESSION}.jsonl`);
}

function scan(dir, cache) {
  const out = execFileSync(process.execPath, ["--no-warnings", SCAN], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, AGENT_FLOW_CACHE: cache },
  }).toString();
  return { raw: out, ...JSON.parse(out) };
}

before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-test-")); });
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("reads a session: model, tools this turn, what runs now, messages, delegation", () => {
  const dir = path.join(home, "basic");
  setup(dir, lines(rows));
  const { sessions, warnings } = scan(dir, path.join(home, "basic.json"));
  assert.deepEqual(warnings, []);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.agent, "claude-code");
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.ctx, 1010);
  assert.equal(s.tools, 5);
  assert.equal(s.more, false);
  assert.deepEqual(s.now, { name: "Grep", hint: "issueRefund" });
  assert.deepEqual(s.sends.map((m) => m.to), ["t7", "reviewer"]);
  assert.deepEqual(s.recvs.map((m) => m.from), ["t9"]);
  assert.deepEqual(s.recent.map((x) => `${x.name} ${x.hint}`), [
    "Read refunds.ts", "Send t7", "Send reviewer", "Agent Audit the refund paths", "back audit", "Grep issueRefund",
  ]);
  assert.equal(s.recent[3].delegate, "audit");
  assert.equal(s.subs.length, 1);
  assert.deepEqual([s.subs[0].type, s.subs[0].status, s.subs[0].model, s.subs[0].tools], ["audit", "done", "claude-haiku-5-5", 1]);
});

test("never prints prompts, messages or tool output", () => {
  const dir = path.join(home, "secret");
  setup(dir, lines(rows));
  assert.ok(!scan(dir, path.join(home, "secret.json")).raw.includes(SECRET));
});

test("reading what was appended gives what one full read gives", () => {
  const dir = path.join(home, "grow");
  const all = Buffer.from(lines(rows));
  const file = setup(dir, all.subarray(0, Math.floor(all.length * 0.55))); // cut mid-line
  const cache = path.join(home, "grow.json");
  scan(dir, cache);
  fs.appendFileSync(file, all.subarray(Math.floor(all.length * 0.55), Math.floor(all.length * 0.8)));
  scan(dir, cache);
  fs.appendFileSync(file, all.subarray(Math.floor(all.length * 0.8)));
  const grown = scan(dir, cache).raw;
  assert.equal(grown, scan(dir, path.join(home, "grow-cold.json")).raw);
  assert.equal(scan(dir, cache).raw, grown); // and again with nothing new
});

test("a replaced transcript starts over instead of mixing two files", () => {
  const dir = path.join(home, "replace");
  const file = setup(dir, lines(rows));
  const cache = path.join(home, "replace.json");
  scan(dir, cache);
  fs.writeFileSync(file, lines([ask(20, "new"), call(21, "x1", "Edit", { file_path: "/work/a.ts" }, "claude-sonnet-5-5")]));
  const s = scan(dir, cache).sessions[0];
  assert.equal(s.model, "claude-sonnet-5-5");
  assert.equal(s.tools, 1);
  assert.deepEqual(s.sends, []);
});

test("a format change is named, not left as `model unknown`", () => {
  const dir = path.join(home, "drift");
  const renamed = rows.map((r) => (r.type === "assistant" ? { ...r, message: { ...r.message, model: undefined, modelId: "claude-opus-5-5" } } : r));
  setup(dir, lines([...renamed, ...renamed]));
  const { sessions, warnings } = scan(dir, path.join(home, "drift.json"));
  assert.equal(sessions[0].model, null);
  assert.ok(warnings.some((w) => w.includes("message.model")), JSON.stringify(warnings));
});

test("a broken cache file only costs a full read", () => {
  const dir = path.join(home, "badcache");
  setup(dir, lines(rows));
  const cache = path.join(home, "badcache.json");
  fs.writeFileSync(cache, "{ not json");
  assert.equal(scan(dir, cache).sessions[0].tools, 5);
});

test("Oh My Pi: the newest session in the cwd's folder gives the model", () => {
  const dir = path.join(home, "omp-claude");
  setup(dir, "");
  const agent = path.join(home, "omp");
  const folder = path.join(agent, "sessions", "--private-tmp--"); // a cwd outside home
  fs.mkdirSync(folder, { recursive: true });
  const old = path.join(folder, "old.jsonl");
  fs.writeFileSync(old, lines([{ type: "message", message: { role: "assistant", model: "claude-haiku-5-5" } }]));
  fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
  fs.writeFileSync(path.join(folder, "new.jsonl"), lines([
    { type: "model_change", model: "anthropic/claude-sonnet-5-5" },
    { type: "message", message: { role: "user", content: SECRET } },
    { type: "message", message: { role: "assistant", model: "claude-opus-5-5", content: SECRET } },
  ]));
  const out = execFileSync(process.execPath, ["--no-warnings", SCAN, "omp=/private/tmp"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, AGENT_FLOW_CACHE: path.join(home, "omp.json"), PI_CODING_AGENT_DIR: agent },
  }).toString();
  const s = JSON.parse(out).sessions.find((x) => x.agent === "omp");
  assert.deepEqual([s.id, s.model, s.cwd], ["new", "claude-opus-5-5", "/private/tmp"]);
  assert.ok(!out.includes(SECRET));
});

// Runs scan.cjs with Oh My Pi's folder at `agent` and a made-up home folder.
function scanOmp(name, agent, fakeHome, ...folders) {
  const dir = path.join(home, `${name}-claude`);
  setup(dir, "");
  const out = execFileSync(process.execPath, ["--no-warnings", SCAN, ...folders.map((f) => `omp=${f}`)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, AGENT_FLOW_CACHE: path.join(home, `${name}.json`), PI_CODING_AGENT_DIR: agent, HOME: fakeHome, USERPROFILE: fakeHome },
  }).toString();
  return JSON.parse(out).sessions.filter((x) => x.agent === "omp");
}

// A Windows path, built from parts so no backslash is ever read as an escape.
const win = (...parts) => parts.join(String.fromCharCode(92));

function ompSession(folder, file, cwd, model, when) {
  fs.mkdirSync(folder, { recursive: true });
  const f = path.join(folder, `${file}.jsonl`);
  const head = cwd ? [{ type: "title", v: 1, title: "", pad: "" }, { type: "session", version: 3, id: file, cwd }] : [];
  fs.writeFileSync(f, lines([...head, { type: "model_change", model: `openai-codex/${model}` }]));
  fs.utimesSync(f, when, when);
}

test("Oh My Pi on Windows: matched by the cwd the session recorded, whatever its folder's name", () => {
  const agent = path.join(home, "omp-win");
  // Oh My Pi files the Windows temp folder under "-tmp", which no rule on the path gives.
  ompSession(path.join(agent, "sessions", "-tmp"), "a", win("C:", "Users", "me", "AppData", "Local", "Temp"), "gpt-6-luna", new Date(2026, 10, 20));
  ompSession(path.join(agent, "sessions", "-Documents-basics"), "b", win("C:", "Users", "me", "Documents", "basics"), "gpt-5.5", new Date(2026, 10, 19));
  const found = scanOmp("omp-win", agent, path.join(home, "nohome"), "c:/users/me/appdata/local/temp/", win("C:", "Users", "me", "Documents", "basics"), win("C:", "Users", "me", "Documents", "none"));
  assert.deepEqual(found.map((s) => [s.id, s.model]), [["a", "gpt-6-luna"], ["b", "gpt-5.5"]]);
});

test("Oh My Pi without a session row goes by the folder name, either separator", () => {
  const agent = path.join(home, "omp-old");
  const fakeHome = path.join(home, "fakehome");
  ompSession(path.join(agent, "sessions", "-Code-x"), "old", null, "gpt-5.5", new Date(2026, 10, 19));
  const found = scanOmp("omp-old", agent, fakeHome, path.join(fakeHome, "Code", "x"));
  assert.deepEqual(found.map((s) => [s.id, s.model]), [["old", "gpt-5.5"]]);
});

test("Oh My Pi: two terminals in one folder take its two newest sessions", () => {
  const agent = path.join(home, "omp-two");
  const folder = path.join(agent, "sessions", "-repo");
  ompSession(folder, "older", win("D:", "repo"), "gpt-5.5", new Date(2026, 10, 18));
  ompSession(folder, "newer", win("D:", "repo"), "gpt-6-luna", new Date(2026, 10, 20));
  const found = scanOmp("omp-two", agent, path.join(home, "nohome"), win("D:", "repo"), "d:/repo");
  assert.deepEqual(found.map((s) => s.id), ["newer", "older"]);
});

test("a session is traced to the terminal whose pid is its process's ancestor", () => {
  const dir = path.join(home, "owner");
  setup(dir, lines(rows));
  const cache = path.join(home, "owner.json");
  const run = (args, procs) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", SCAN, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, AGENT_FLOW_CACHE: cache, AGENT_FLOW_PROCS: procs },
  }).toString()).sessions[0];
  // This test's process <- a shell (999) <- Herdr (1), as claude.exe <- pwsh.exe <- herdr-core.
  assert.equal(run(["term=999@t7", "term=555@t8"], `${process.pid} 999,999 1`).terminal, "t7");
  // The chain is cached: no process table is needed again for the same session.
  assert.equal(run(["term=999@t7"], "").terminal, "t7");
  // A terminal pid that isn't an ancestor pairs nothing; nor do no pids at all.
  assert.equal(run(["term=555@t8"], "").terminal, undefined);
  assert.equal(run([], "").terminal, undefined);
});
