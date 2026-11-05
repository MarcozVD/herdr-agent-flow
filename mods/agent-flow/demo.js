// Made-up data for `props: { demo: true }`: shows every state and makes a safe screenshot.
const at = Date.now() - 60000;
const step = (s, name, hint, extra) => ({ t: at + s * 1000, name, hint, ...extra });
const program = (key, name, agent = true) => ({ key, name, agent, icon: null, tint: false });

export const terminals = [
  { address: "t1", state: "live", parent: null, status: "working", report: { app: "claude-code" }, program: program("claude", "Claude Code"), title: "Fix the login flow", cwd: "~/projects/app" },
  { address: "t7", state: "live", parent: "t1", status: "working", report: { app: "opencode", title: "Write the migration" }, program: program("opencode", "OpenCode"), title: "OC | Write the migration", cwd: "~/projects/api" },
  { address: "t30", state: "live", parent: "t1", status: null, report: null, name: "api-server", program: program("node", "Node.js", false), title: "", cwd: "~/projects/api" },
  { address: "t31", state: "live", parent: "t1", status: null, report: null, name: "web-dev", program: program("vite", "Vite", false), title: "", cwd: "~/projects/web" },
  { address: "t4", state: "live", parent: null, status: "blocked", report: { app: "claude-code" }, program: program("claude", "Claude Code"), title: "Upgrade dependencies", cwd: "~/projects/deps" },
  { address: "t6", state: "live", parent: null, status: "done", report: { app: "codex" }, program: program("codex", "Codex"), title: "Write release notes", cwd: "~/projects/docs" },
];

export const scan = {
  sessions: [{
    id: "demo", agent: "claude-code", cwd: "~/projects/app", model: "claude-sonnet-5-5", ctx: 122000, tools: 14,
    turnAt: at, lastAt: at + 58000, now: { name: "Agent", hint: "Audit the auth module" }, total: 2,
    recent: [
      step(4, "Read", "login.ts"),
      step(11, "Grep", "verifySession"),
      step(20, "Agent", "Map the repo", { delegate: "search" }),
      step(21, "Agent", "Audit the auth module", { delegate: "audit" }),
      step(41, "back", "search", { back: true }),
    ],
    subs: [
      { id: "a1", type: "search", description: "Map the repo", status: "done", model: "claude-haiku-5-5", tools: 9, ctx: 18000, now: null, startedAt: at + 20000, lastAt: at + 41000,
        recent: [step(38, "Glob", "src/**/*.ts")] },
      { id: "a3", type: "audit", description: "Audit the auth module", status: "working", model: "claude-opus-5-5", tools: 3, ctx: 41000, now: { name: "Read", hint: "session.ts" }, startedAt: at + 22000, lastAt: at + 58000,
        recent: [step(56, "Read", "session.ts")] },
    ],
  }, {
    id: "demo-oc", agent: "opencode", cwd: "~/projects/api", model: "deepseek-v4.1-flash:free", ctx: 0, tools: 7,
    turnAt: at, lastAt: at + 55000, now: { name: "Edit", hint: "0042_sessions.sql" }, total: 0, subs: [],
    recent: [step(30, "Read", "schema.sql"), step(54, "Edit", "0042_sessions.sql")],
  }, {
    id: "demo-cx", agent: "codex", cwd: "~/projects/docs", model: "gpt-5.5-codex", ctx: 0, tools: null,
    turnAt: 0, lastAt: at, now: null, total: 0, subs: [], recent: [],
  }],
};
