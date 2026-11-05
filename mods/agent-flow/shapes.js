// Where each agent sits on the Map. Pure geometry: nodes come in as { key, parent }, routes as
// { from, to } messages that aren't parent and child, and each shape returns key -> { x, y },
// the node's top left, and the height it needs. Same input, same picture: nothing is random.
// The arrangement changes, the hierarchy doesn't: in every shape a tier stays apart from the
// next, an orchestrator comes before its team and a parent before its children.

const PASSES = 90; // Herdr interrupts a render that runs long, and this one runs in render

const kidsOf = (nodes, key) => nodes.filter((n) => n.parent === key);

function forest(nodes, lead) {
  const known = new Set(nodes.map((n) => n.key));
  return nodes.filter((n) => !n.parent || !known.has(n.parent)).sort((a, b) => (b.key === lead) - (a.key === lead));
}

// A growing tree: a column per tier, a row per leaf, a parent centered on its children.
export function tree(nodes, routes, { lead, room, W, H }) {
  const pos = new Map();
  const ROW = H + 8;
  let leaf = 0;
  let depth = 0;
  const seen = new Set();
  const depths = new Map();
  const place = (n, d) => {
    if (seen.has(n.key)) return null;
    seen.add(n.key);
    depth = Math.max(depth, d);
    const ys = kidsOf(nodes, n.key).map((k) => place(k, d + 1)).filter((y) => y != null);
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : leaf++;
    depths.set(n.key, d);
    pos.set(n.key, { x: 0, y: Math.round(y * ROW) });
    return y;
  };
  for (const r of forest(nodes, lead)) { place(r, 0); leaf += 0.3; }
  const col = depth ? (room - W) / depth : 0;
  const step = Math.min(col, W + 70);
  for (const [key, p] of pos) p.x = Math.round(depths.get(key) * step);
  return { pos, height: Math.ceil(leaf) * ROW };
}

// A route to or from an orchestrator isn't a step in the work.
function steps(nodes, routes) {
  const known = new Set(nodes.map((n) => n.key));
  const top = new Set(nodes.filter((n) => !n.parent || !known.has(n.parent)).map((n) => n.key));
  return routes.filter((r) => !top.has(r.from) && !top.has(r.to));
}

// Ranks from the routes: how many hands the work passed through. A message back to an
// earlier agent is a loop and doesn't move anyone.
function ranks(nodes, routes) {
  const next = new Map();
  for (const r of routes) next.set(r.from, [...(next.get(r.from) ?? []), r.to]);
  const state = new Map();
  const rank = new Map();
  let loops = 0;
  const visit = (key) => {
    state.set(key, 1);
    let best = 0;
    for (const to of next.get(key) ?? []) {
      if (state.get(to) === 1) { loops++; continue; }
      if (!state.has(to)) visit(to);
      best = Math.max(best, (rank.get(to) ?? 0) + 1);
    }
    state.set(key, 2);
    rank.set(key, best);
  };
  for (const n of nodes) if (next.has(n.key) && !state.has(n.key)) visit(n.key);
  const top = Math.max(0, ...rank.values());
  const stage = new Map();
  for (const n of nodes) if (rank.has(n.key)) stage.set(n.key, top - rank.get(n.key));
  for (const r of routes) if (!stage.has(r.to)) stage.set(r.to, top);
  return { stage, loops, top };
}

// Tier by tier from the top: 0 for an orchestrator.
function tiers(nodes) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const tier = new Map();
  const of = (n, seen = new Set()) => {
    if (tier.has(n.key)) return tier.get(n.key);
    const parent = byKey.get(n.parent);
    const d = parent && !seen.has(n.key) ? of(parent, seen.add(n.key)) + 1 : 0;
    tier.set(n.key, d);
    return d;
  };
  nodes.forEach((n) => of(n));
  return tier;
}

// A lane per team: the orchestrator, then the team's lead, then its members in columns by the
// order work moves through them. A child is always right of its parent, whatever the steps say.
export function stages(nodes, routes, { lead, room, W, H }) {
  const { stage, top } = ranks(nodes, steps(nodes, routes));
  const tier = tiers(nodes);
  const pos = new Map();
  const ROW = H + 8;
  const col = new Map();
  const place = (n) => {
    for (const k of kidsOf(nodes, n.key)) {
      col.set(k.key, tier.get(k.key) < 2 ? tier.get(k.key) : Math.max(2 + (stage.get(k.key) ?? 0), col.get(n.key) + 1));
      place(k);
    }
  };
  const roots = forest(nodes, lead);
  roots.forEach((r) => { col.set(r.key, 0); place(r); });
  const cols = Math.max(...col.values()) + 1;
  const fit = Math.min(W, Math.floor((room - (cols - 1) * 14) / cols));
  const step = cols > 1 ? Math.min((room - fit) / (cols - 1), fit + 60) : 0;
  const start = 20;
  let row = 0;
  const members = (n) => kidsOf(nodes, n.key).flatMap((k) => [k, ...members(k)]);
  for (const r of roots) {
    const first = row;
    for (const team of kidsOf(nodes, r.key)) {
      const lane = row;
      const used = new Map();
      for (const m of members(team)) {
        const c = col.get(m.key);
        used.set(c, (used.get(c) ?? 0) + 1);
        pos.set(m.key, { x: Math.round(c * step), y: start + (lane + used.get(c) - 1) * ROW });
      }
      const size = Math.max(1, ...used.values());
      pos.set(team.key, { x: Math.round(step), y: start + Math.round((lane + (size - 1) / 2) * ROW) });
      row += size;
    }
    if (row === first) row++;
    pos.set(r.key, { x: 0, y: start + Math.round(((first + row - 1) / 2) * ROW) });
    row += 0.3;
  }
  const marks = [{ x: 0, text: "lead" }, { x: Math.round(step), text: "team" },
    ...Array.from({ length: Math.max(0, cols - 2) }, (_, i) => ({ x: Math.round((i + 2) * step), text: `step ${i + 1}` }))].slice(0, cols);
  return { pos, height: start + Math.ceil(row) * ROW, marks, W: fit };
}

// Pushes overlapping nodes apart, each kept inside its own vertical band.
function separate(pos, W, H, room, height, rounds = 60, band = () => [0, height - H]) {
  const list = [...pos.entries()].map(([key, p]) => ({ p, band: band(key) }));
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].p;
        const b = list[j].p;
        const ox = W + 8 - Math.abs(a.x - b.x);
        const oy = H + 8 - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (oy < ox) { const s = (a.y <= b.y ? -1 : 1) * oy / 2; a.y += s; b.y -= s; }
        else { const s = (a.x <= b.x ? -1 : 1) * ox / 2; a.x += s; b.x -= s; }
      }
    }
    for (const { p, band: [lo, hi] } of list) {
      p.x = Math.max(0, Math.min(room - W, p.x));
      p.y = Math.max(lo, Math.min(hi, p.y));
    }
    if (!moved) break;
  }
}

// The chosen lead in the middle, each tier a ring, a team's agents around the same arc.
export function radial(nodes, routes, { lead, room, W, H, height }) {
  const roots = forest(nodes, lead);
  const center = roots[0];
  const kids = (n) => [...kidsOf(nodes, n.key), ...(n === center ? roots.slice(1) : [])];
  const seen = new Set();
  const leaves = new Map();
  const count = (n) => {
    if (seen.has(n.key)) return 0;
    seen.add(n.key);
    const c = kids(n).reduce((s, k) => s + count(k), 0) || 1;
    leaves.set(n.key, c);
    return c;
  };
  count(center);
  const depthOf = new Map();
  let depth = 1;
  const walk = (n, d) => { depthOf.set(n.key, d); depth = Math.max(depth, d); for (const k of kids(n)) if (leaves.has(k.key) && !depthOf.has(k.key)) walk(k, d + 1); };
  walk(center, 0);
  const rx = (room - W) / 2 / depth;
  const ry = (height - H) / 2 / depth;
  const pos = new Map();
  const put = (n, a0, a1) => {
    const d = depthOf.get(n.key);
    const mid = (a0 + a1) / 2;
    pos.set(n.key, { x: room / 2 - W / 2 + rx * d * Math.cos(mid), y: height / 2 - H / 2 + ry * d * Math.sin(mid) });
    let at = a0;
    const list = kids(n).filter((k) => depthOf.get(k.key) === d + 1);
    const total = list.reduce((s, k) => s + leaves.get(k.key), 0) || 1;
    for (const k of list) {
      const span = (a1 - a0) * leaves.get(k.key) / total;
      put(k, at, at + span);
      at += span;
    }
  };
  put(center, -Math.PI / 2, Math.PI * 1.5);
  separate(pos, W, H, room, height, 16);
  return { pos, height };
}

// Agents that talk are pulled together and the rest pushed apart, sideways and within a band
// per tier: free inside a level, never out of it.
export function organic(nodes, routes, opts) {
  const { room, W, H, height } = opts;
  const { pos } = radial(nodes, routes, opts);
  const tier = tiers(nodes);
  const levels = Math.max(...tier.values()) + 1;
  const bandH = height / levels;
  const band = (key) => {
    const lo = tier.get(key) * bandH;
    return [lo, Math.max(lo, lo + bandH - H - 8)];
  };
  const list = [...pos.entries()].map(([key, p]) => {
    const [lo, hi] = band(key);
    return { key, x: p.x + W / 2, y: (lo + hi) / 2 + (p.y - height / 2) / levels / 2 + H / 2, lo: lo + H / 2, hi: hi + H / 2 };
  });
  const byKey = new Map(list.map((p) => [p.key, p]));
  const links = [
    ...nodes.filter((n) => byKey.has(n.parent)).map((n) => ({ a: n.key, b: n.parent, len: 120, k: 0.05 })),
    ...routes.map((r) => ({ a: r.from, b: r.to, len: 130, k: 0.04 })),
  ];
  const cx = room / 2;
  for (let i = 0; i < PASSES; i++) {
    const heat = 1 - i / PASSES;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const p = list[a];
        const q = list[b];
        const dx = (p.x - q.x) / 1.7 || 0.5;
        const dy = p.y - q.y || 0.5;
        const f = 2600 / (dx * dx + dy * dy);
        p.x += dx * f * heat * 0.1; p.y += dy * f * heat * 0.1;
        q.x -= dx * f * heat * 0.1; q.y -= dy * f * heat * 0.1;
      }
    }
    for (const l of links) {
      const p = byKey.get(l.a);
      const q = byKey.get(l.b);
      if (!p || !q) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - l.len) * l.k * heat;
      p.x += dx / d * f; p.y += dy / d * f;
      q.x -= dx / d * f; q.y -= dy / d * f;
    }
    for (const p of list) {
      p.x += (cx - p.x) * 0.004;
      p.x = Math.max(W / 2, Math.min(room - W / 2, p.x));
      p.y = Math.max(p.lo, Math.min(p.hi, p.y));
    }
  }
  const out = new Map(list.map((p) => [p.key, { x: p.x - W / 2, y: p.y - H / 2 }]));
  separate(out, W, H, room, height, 24, band);
  return { pos: out, height };
}

// What suits the shape of the work: work passing along a line reads best in stages, agents
// passing it around in a mesh by who's near whom, and a plain team as a tree or rings.
export function choose(nodes, routes) {
  const work = steps(nodes, routes);
  if (work.length >= 3) return ranks(nodes, work).loops * 3 <= work.length ? "stages" : "organic";
  return nodes.length > 9 ? "radial" : "tree";
}

export const SHAPES = { tree, stages, radial, organic };
