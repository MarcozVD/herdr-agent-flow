// Example data for `props: { example: "platform" }`: many agents in teams, three tiers deep, whose
// work passes along a pipeline between them and rarely reaches the orchestrator.
export const now = Date.now();
const at = now - 480000;
const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", codex: "gpt-5.5-codex", deepseek: "deepseek-v4.1-flash:free" };
const KINDS = {
  claude: { app: "claude-code", program: { key: "claude", name: "Claude Code", agent: true, icon: "icons/claude.svg", tint: false } },
  codex: { app: "codex", program: { key: "codex", name: "Codex", agent: true, icon: "icons/codex.svg", tint: false } },
  opencode: { app: "opencode", program: { key: "opencode", name: "OpenCode", agent: true, icon: "icons/opencode.svg", tint: true } },
};

export const terminals = [];
const sessions = new Map();

function agent(address, parent, label, kind, model, status, title, tools, subs = []) {
  const k = KINDS[kind];
  const cwd = `~/platform/${address}`;
  terminals.push({ address, state: "live", parent, status, report: { app: k.app, title }, name: label, program: k.program, title, cwd });
  const s = { id: address, agent: k.app, cwd, model: MODELS[model], ctx: 0, tools: kind === "codex" ? null : tools, turnAt: at, lastAt: at + 400000, now: null, total: subs.length, subs, recent: [], sends: [], recvs: [] };
  sessions.set(address, s);
  sessions.set(label, s);
  return s;
}

const sub = (id, type, description, model, status, tools) => ({ id, type, description, status, model: MODELS[model], tools, ctx: 0, now: null, startedAt: at + 30000, lastAt: at + 300000, recent: [], sends: [] });

agent("t1", null, null, "claude", "opus", "working", "Rewrite the payments platform", 64, [sub("s1", "planner", "Split the rewrite into teams", "haiku", "done", 12)]);
agent("t2", "t1", "backend", "codex", "codex", "working", "Lead the backend team", 0);
agent("t5", "t2", "schema", "claude", "haiku", "done", "Design the ledger schema", 21);
agent("t6", "t2", "api", "opencode", "deepseek", "working", "Build the payments API", 48, [sub("s2", "explore", "Find the old endpoints", "deepseek", "working", 9)]);
agent("t14", "t6", "webhooks", "claude", "haiku", "working", "Port the webhooks", 17);
agent("t7", "t2", "workers", "codex", "codex", "working", "Move the billing jobs", 0);
agent("t3", "t1", "frontend", "claude", "sonnet", "working", "Lead the frontend team", 33, [sub("s3", "design", "Audit the checkout screens", "haiku", "done", 15)]);
agent("t8", "t3", "client-sdk", "opencode", "deepseek", "working", "Generate the client SDK", 26);
agent("t9", "t3", "checkout-ui", "claude", "haiku", "blocked", "Rebuild the checkout", 31);
agent("t4", "t1", "qa", "opencode", "deepseek", "working", "Lead the test team", 19);
agent("t10", "t4", "e2e", "claude", "haiku", "working", "Run the checkout flows", 28);
agent("t11", "t4", "load", "codex", "codex", "idle", "Load test the API", 0);
agent("t12", "t4", "fixtures", "claude", "haiku", "done", "Seed the test ledgers", 11);
agent("t40", null, null, "claude", "sonnet", "working", "Security review", 22);
agent("t41", "t40", "audit", "claude", "opus", "working", "Audit the card flows", 16);
agent("t42", "t40", "secrets", "opencode", "deepseek", "done", "Scan for leaked keys", 8);

// A message as each side would record it: a sender with a transcript logs the send, and
// Codex, which has none here, only shows as a tag on what its receiver got.
function message(from, to, seconds) {
  const t = at + seconds * 1000;
  const sender = terminals.find((k) => k.address === from);
  const target = terminals.find((k) => k.address === to);
  if (sender.report.app === "codex") sessions.get(to).recvs.push({ t, from });
  else {
    sessions.get(from).sends.push({ t, to: target.name ?? to });
    sessions.get(from).recent.push({ t, name: "Send", hint: target.name ?? to, to: target.name ?? to });
  }
}

message("t1", "t2", 20);
message("t1", "t3", 24);
message("t1", "t4", 28);
message("t5", "t6", 150);
message("t5", "t6", 196);
message("t6", "t8", 230);
message("t6", "t8", 300);
message("t6", "t14", 310);
message("t8", "t9", 340);
message("t12", "t10", 350);
message("t11", "t7", 360);
message("t9", "t10", 410);
message("t14", "t10", 425);
message("t10", "t6", 440);
message("t41", "t14", 450);
message("t2", "t1", 380);
message("t4", "t1", 395);
message("t40", "t1", 300);

export const scan = { sessions: [...new Set(sessions.values())] };
