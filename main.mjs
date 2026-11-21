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
    try { bot = new Bot(msg, map); } catch (e) { console.error("bot init failed", e); }
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
