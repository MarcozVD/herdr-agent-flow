// Made-up data for `props: { demo: true }`: an orchestrator with mixed agents in every state,
// for trying the mod and for a screenshot with nothing private in it.
const at = Date.now() - 240000;
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
  plain("t30", "api-server", "node"),
  plain("t31", "web-dev", "vite"),
  plain("t32", "postgres", "docker"),
  plain("t33", "stripe-listen", "stripe"),
  { address: "t4", state: "live", parent: null, status: "blocked", report: { app: "claude-code" }, program: CLAUDE, title: "Upgrade dependencies", cwd: "~/projects/deps" },
  { address: "t6", state: "live", parent: null, status: "done", report: { app: "codex" }, program: CODEX, title: "Write release notes", cwd: "~/projects/docs" },
  { address: "t8", state: "live", parent: null, status: "idle", report: { app: "opencode" }, program: OPENCODE, title: "Fix flaky e2e tests", cwd: "~/projects/e2e" },
];

export const scan = {
  sessions: [{
    id: "demo", agent: "claude-code", cwd: "~/projects/billing", model: "claude-opus-5-5", ctx: 184000, tools: 38,
    turnAt: at, lastAt: at + 236000, now: { name: "Agent", hint: "Audit the refund paths" }, total: 2,
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
        recent: [step(226, "Grep", "issueRefund"), step(235, "Read", "refunds.ts")] },
    ],
  }, {
    id: "demo-cx", agent: "codex", cwd: "~/projects/billing/db", model: "gpt-5.5-codex", ctx: 0, tools: null,
    turnAt: 0, lastAt: at + 230000, now: null, total: 0, subs: [], recent: [],
  }, {
    id: "demo-oc", agent: "opencode", cwd: "~/projects/billing/api", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 27,
    turnAt: at, lastAt: at + 228000, now: { name: "Bash", hint: "Run the webhook replay" }, total: 0, subs: [],
    recent: [step(110, "Read", "stripe-events.ts"), step(205, "Edit", "webhooks.ts"), step(228, "Bash", "Run the webhook replay")],
  }, {
    id: "demo-t4", agent: "claude-code", cwd: "~/projects/deps", model: "claude-sonnet-5-5", ctx: 67000, tools: 9,
    turnAt: at, lastAt: at + 90000, now: null, total: 0, subs: [], recent: [step(90, "Bash", "Run npm audit")],
  }, {
    id: "demo-t6", agent: "codex", cwd: "~/projects/docs", model: "gpt-5.5-codex", ctx: 0, tools: null,
    turnAt: 0, lastAt: at, now: null, total: 0, subs: [], recent: [],
  }, {
    id: "demo-t8", agent: "opencode", cwd: "~/projects/e2e", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 12,
    turnAt: 0, lastAt: at, now: null, total: 0, subs: [], recent: [step(30, "Edit", "checkout.spec.ts")],
  }],
};
