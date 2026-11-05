# Agent Flow, a Herdr mod

A live diagram for the [Herdr](https://herdr.dev) desktop app that shows how the agents in the
current space work together: the orchestrator, each agent or subagent it delegated to with its
model, and what came back. It changes with the space you call it from.

![Agent Flow](preview.png)

Install: copy `mods/agent-flow/` into `~/.config/herdr-app/mods/`, merge `keys.json` into yours,
press `ctrl-shift-g`. Needs Node on PATH, and Node 22 or later for opencode and Codex models.
[RECIPE.md](RECIPE.md) is the brief to build it from scratch.

The picture shows it as a side panel, opened from a Flow button beside Graph, with the demo data
(`props: { "demo": true }`). The key opens it as an overlay out of the box; the button lives in
your own layout and tab bar, and RECIPE.md says how to add it.

## What it shows

- **Agent and model on every box.** Claude Code, opencode and Codex show their model; other
  agents show their name and status.
- **Subagents.** Agents started with `hc run`, and the subagents Claude Code and opencode run
  inside their own process, which have no terminal of their own.
- **Who's working.** The whole line from the orchestrator to a working agent lights up in its
  color. Bars say running or finished: no agent reports real progress, so there are no percentages.
- **Plain terminals apart.** A dev server the lead started sits in a list under the diagram,
  never as an agent.
- **A session log** of tool calls, delegations and status changes.

## What it reads

The mod runs `node mods/agent-flow/scan.cjs` every 3 seconds while it's on screen, and only
reads local files: Claude Code's session transcripts in `~/.claude`, opencode's database in
`~/.local/share/opencode` and Codex's state in `~/.codex`, the last two read-only. It reaches no
network. On screen you get tool names and short hints such as a file name or the start of a
command, never prompts or tool output.

These are private formats, so an agent's update can leave a box at `model unknown`.

## License

[MIT](LICENSE).
