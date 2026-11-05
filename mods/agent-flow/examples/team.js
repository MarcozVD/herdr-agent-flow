// Example data for `props: { example: "team" }`: an orchestrator with mixed agents in every
// state. Shows the mod with no agents running, and makes a screenshot with nothing private in it.
export const now = Date.now();
const at = now - 240000;
const step = (s, name, hint, extra) => ({ t: at + s * 1000, name, hint, ...extra });
const program = (key, name, icon, agent = true, tint = false) => ({ key, name, agent, icon, tint });
const CLAUDE = program("claude", "Claude Code", "icons/claude.svg");
const CODEX = program("codex", "Codex", "icons/codex.svg");
const OPENCODE = program("opencode", "OpenCode", "icons/opencode.svg", true, true);
const plain = (address, name, key) => ({ address, state: "live", parent: "t1", status: null, report: null, name, program: program(key, key, null, false), title: "", cwd: "~/projects/billing" });

export const terminals = [
  { address: "t1", state: "live", parent: null, status: "working", report: { app: "claude-code" }, program: CLAUDE, title: "Ship the billing migration", cwd: "~/projects/billing" },
  { address: "t7", state: "live", parent: "t1", status: "working", report: { app: "codex", title: "Write the invoice migration" }, name: "db-migration", program: CODEX, title: "Write the invoice migration", cwd: "~/projects/billing/db" },
  { address: "t9", state: "live", parent: "t1", status: "blocked", report: { app: "opencode", title: "Port the webhook handlers" }, name: "webhooks", program: OPENCODE, title: "OC | Port the webhook handlers", cwd: "~/projects/billing/api" },
  { address: "t12", state: "live", parent: "t7", status: "working", report: { app: "claude-code", title: "Check the rollback" }, name: "rollback", program: CLAUDE, title: "Check the rollback", cwd: "~/projects/billing/rollback" },
  plain("t30", "api-server", "node"),
  plain("t31", "web-dev", "vite"),
  plain("t32", "postgres", "docker"),
  plain("t33", "stripe-listen", "stripe"),
  { address: "t4", state: "live", parent: null, status: "blocked", report: { app: "claude-code" }, program: CLAUDE, title: "Upgrade dependencies", cwd: "~/projects/deps" },
  { address: "t11", state: "live", parent: "t4", status: "working", report: { app: "opencode", title: "Bump the lockfile" }, name: "lockfile", program: OPENCODE, title: "Bump the lockfile", cwd: "~/projects/deps/lock" },
  { address: "t6", state: "live", parent: null, status: "done", report: { app: "codex" }, program: CODEX, title: "Write release notes", cwd: "~/projects/docs" },
  { address: "t8", state: "live", parent: null, status: "idle", report: { app: "opencode" }, program: OPENCODE, title: "Fix flaky e2e tests", cwd: "~/projects/e2e" },
];

export const scan = {
  sessions: [{
    id: "s", agent: "claude-code", cwd: "~/projects/billing", model: "claude-opus-5-5", ctx: 184000, tools: 38,
    turnAt: at, lastAt: at + 236000, now: { name: "Agent", hint: "Audit the refund paths" }, total: 2,
    sends: [{ t: at + 60000, to: "t7" }, { t: at + 66000, to: "t9" }, { t: at + 190000, to: "t7" }], recvs: [],
    recent: [
      step(12, "Read", "invoice.ts"),
      step(26, "Grep", "chargeCustomer"),
      step(44, "Agent", "Map the billing module", { delegate: "search" }),
      step(52, "Bash", "Start Codex on the migration"),
      step(58, "Bash", "Start OpenCode on the webhooks"),
      step(96, "Read", "webhooks.md"),
      step(131, "back", "search", { back: true }),
      step(140, "Edit", "refunds.ts"),
      step(182, "Bash", "Run the billing test suite"),
      step(214, "Agent", "Audit the refund paths", { delegate: "audit" }),
    ],
    subs: [
      { id: "a1", type: "search", description: "Map the billing module", status: "done", model: "claude-haiku-5-5", tools: 14, ctx: 31000, now: null, startedAt: at + 44000, lastAt: at + 131000,
        recent: [step(70, "Glob", "src/billing/**/*.ts"), step(118, "Read", "stripe.ts")] },
      { id: "a3", type: "audit", description: "Audit the refund paths", status: "working", model: "claude-sonnet-5-5", tools: 11, ctx: 58000, now: { name: "Read", hint: "refunds.ts" }, startedAt: at + 214000, lastAt: at + 235000,
        sends: [{ t: at + 232000, to: "t9" }],
        recent: [step(226, "Grep", "issueRefund"), step(235, "Read", "refunds.ts")] },
    ],
  }, {
    id: "s-rb", agent: "claude-code", cwd: "~/projects/billing/rollback", model: "claude-haiku-5-5", ctx: 22000, tools: 6,
    turnAt: at, lastAt: at + 225000, now: null, total: 0, subs: [], recent: [step(225, "Read", "0042_rollback.sql")], sends: [], recvs: [],
  }, {
    id: "s-cx", agent: "codex", cwd: "~/projects/billing/db", model: "gpt-5.5-codex", ctx: 0, tools: null,
    turnAt: 0, lastAt: at + 230000, now: null, total: 0, subs: [], recent: [],
  }, {
    id: "s-oc", agent: "opencode", cwd: "~/projects/billing/api", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 27,
    turnAt: at, lastAt: at + 228000, now: { name: "Bash", hint: "Run the webhook replay" }, total: 1,
    sends: [{ t: at + 150000, to: "t7" }, { t: at + 200000, to: "t7" }, { t: at + 218000, to: "t1" }], recvs: [],
    subs: [{ id: "o1", type: "explore", description: "Find the event types", status: "working", model: "deepseek-v4.1-flash:free", tools: 8, ctx: 0, now: { name: "Grep", hint: "invoice.paid" }, startedAt: at + 180000, lastAt: at + 234000, recent: [], sends: [] }],
    recent: [step(110, "Read", "stripe-events.ts"), step(205, "Edit", "webhooks.ts"), step(228, "Bash", "Run the webhook replay")],
  }, {
    id: "s-t4", agent: "claude-code", cwd: "~/projects/deps", model: "claude-sonnet-5-5", ctx: 67000, tools: 9,
    turnAt: at, lastAt: at + 90000, now: null, total: 0, subs: [], recent: [step(90, "Bash", "Run npm audit")],
    sends: [{ t: at + 88000, to: "t11" }, { t: at + 170000, to: "t1" }], recvs: [],
  }, {
    id: "s-lk", agent: "opencode", cwd: "~/projects/deps/lock", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 5,
    turnAt: at, lastAt: at + 200000, now: null, total: 0, subs: [], recent: [step(200, "Bash", "Regenerate the lockfile")], sends: [{ t: at + 205000, to: "t4" }], recvs: [],
  }, {
    id: "s-t6", agent: "codex", cwd: "~/projects/docs", model: "gpt-5.5-codex", ctx: 0, tools: null,
    turnAt: 0, lastAt: at, now: null, total: 0, subs: [], recent: [],
  }, {
    id: "s-t8", agent: "opencode", cwd: "~/projects/e2e", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 12,
    turnAt: 0, lastAt: at, now: null, total: 0, subs: [], recent: [step(30, "Edit", "checkout.spec.ts")],
  }],
};
