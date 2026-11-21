// stdin/stdout loop for mechfight/1. Answers only the newest queued observation.
import { GameMap } from "./map.mjs";
import { Bot } from "./bot.mjs";

let bot = null, buf = "", lastAct = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "hello") {
    let map = null;
    try { map = new GameMap(msg.map.dir); } catch (e) { console.error("map load failed", e); }
    try { // warm the JIT so the first real path search is not slow
      const b = map.bounds;
      for (let k = 0; k < 40; k++) { const f = k / 40; map.path(b.minX + 60 + f * 300, b.minY + 60, b.maxX - 60 - f * 300, b.maxY - 60); map.los(0, 0, 8, 150 - k, 80 + k, 5); }
    } catch (e) { console.error("warmup failed", e); }
    try { warmBot(msg, map); } catch (e) { console.error("bot warmup failed", e && e.stack); }
    try { bot = new Bot(msg, map); } catch (e) { console.error("bot init failed", e); }
    try { if (bot && bot.P.roof) bot.computeRoofs(); } catch (e) { console.error("roof init failed", e); }
    out({ type: "ready", name: "kestrel" });
  } else if (msg.type === "obs") {
    let act = null;
    try { if (bot && bot.map) act = bot.act(msg); } catch (e) { console.error("act error", e && e.stack); }
    if (!act) { // fail safe: walk to the zone centre
      const s = msg.self, c = msg.zone.next_center, a = Math.atan2(c[1] - s.pos[1], c[0] - s.pos[0]);
      act = { tick: msg.tick, move: [Math.cos(a), Math.sin(a)], aim: [a, 0], fire: [false, false] };
      if (msg.offer) act.pick = 0;
    }
    out(act);
  } else if (msg.type === "end") { process.exit(0); }
}
// run a throwaway bot on synthetic observations so the real first decisions are already compiled
function warmBot(hello, map) {
  const cfg = hello.config, W = cfg.weapons, t0 = Date.now();
  const b = new Bot(hello, map);
  const open = [];
  for (let k = 0; open.length < 8 && k < 4000; k++) { const c = (k * 7919) % map.N; if (map.comp[c] && map.nearWall[c] > 3) open.push([map.cx(c), map.cy(c), map.ground[c]]); }
  const z = cfg.zone, ph = z.phases[0];
  for (let k = 0; k < 120 && Date.now() - t0 < 4000; k++) {
    const p = open[k % open.length], e = open[(k + 3) % open.length];
    const ex = p[0] + 90 * Math.cos(k), ey = p[1] + 90 * Math.sin(k);
    const toMe = Math.atan2(p[1] - ey, p[0] - ex);
    const obs = {
      type: "obs", tick: k * 2, t: k * 0.1 + (k > 60 ? 200 : 0), alive: 16 - (k >> 4),
      self: { id: hello.slot, pos: [p[0] + (k % 5), p[1], p[2]], vel: [5, -3, 0], aim: [k * 0.1, 0], hp: 1400 - k * 9, max_hp: 1400, energy: 100 - (k % 50), max_energy: 100, grounded: k % 9 !== 0, cubes: k >> 5, upgrades: [], in_zone: k % 7 !== 0,
        weapons: [{ kind: "gun", cooldown: 0, ammo: 12 - (k % 13), reload: k % 13 === 12 ? 1 : 0, stats: { ...W.gun } },
          k % 3 === 0 ? { kind: "laser", cooldown: 0, charge: (k % 8) * 0.1, stats: { ...W.laser } } : k % 3 === 1 ? { kind: "lightning", cooldown: 0, stats: { ...W.lightning } } : { kind: "mortar", cooldown: 0, stats: { ...W.mortar } }],
        stats: { ...cfg.mech, muzzle_height: cfg.mech.muzzle_height, eye_height: cfg.mech.eye_height } },
      mechs: [{ id: (hello.slot + 1) % 16, kind: "mech", pos: [ex, ey, e[2]], vel: [4, 6, 0], aim: [toMe, 0], hp: 900, max_hp: 1400, cubes: 1, weapons: ["gun", "laser"], charging: k % 4 === 0 },
        { id: 100, kind: "npc", pos: [p[0] - 40, p[1] + 20, p[2]], vel: [1, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 }],
      projectiles: [{ id: 1, kind: "gun", pos: [ex, ey, e[2] + 7], vel: [Math.cos(toMe) * 252, Math.sin(toMe) * 252, 0] }, { id: 2, kind: "mortar", pos: [p[0] + 30, p[1], p[2] + 30], vel: [-20, 0, 5] }],
      crates: [{ id: 1000, pos: [p[0] + 30, p[1] + 10, p[2]], hp: 300 }], cubes: [{ id: 5000, pos: [p[0] + 12, p[1] - 6, p[2]] }],
      pickups: [{ id: 8000, kind: "laser", pos: [p[0] + 20, p[1] + 5, p[2]] }],
      sounds: [{ kind: "gun", bearing: 1, dist: "near", age: 0.1 }], beams: [],
      events: k % 5 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: toMe + Math.PI, by: (hello.slot + 1) % 16 }] : [],
      drops: [], zone: { center: z.start_center, radius: k > 60 ? 140 : z.start_radius, next_center: z.start_center, next_radius: k > 60 ? 70 : ph.radius, shrink_start: ph.hold_s, shrink_end: ph.hold_s + ph.shrink_s, dps: ph.dps },
      offer: k === 30 ? { id: 0, expires: 9, choices: [{ id: "armor" }, { id: "plating" }, { id: "servos" }] } : null,
    };
    if (k % 2) obs.mechs = obs.mechs.slice(1);
    b.act(obs);
  }
  console.error("bot warmup ms", Date.now() - t0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n"); buf = lines.pop();
  // find the newest obs in this batch; older obs are skipped
  let newest = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('{"type":"obs"') || lines[i].includes('"type":"obs"')) newest = i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue;
    if (l.includes('"type":"obs"') && i !== newest) continue;
    handle(l);
  }
});
process.stdin.on("end", () => process.exit(0));
