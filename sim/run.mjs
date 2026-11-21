// usage: node sim/run.mjs practice|ffa [matches] [seed0] [paramsJSON]
import { GameMap } from "../map.mjs";
import { Bot } from "../bot.mjs";
import { World, Match, HouseBot, mulberry } from "./sim.mjs";
const ARENA = process.env.ARENA || "/tmp/kit/mechfight-kit/arena";
const mode = process.argv[2] || "practice", N = +(process.argv[3] || 8), seed0 = +(process.argv[4] || 1);
const params = process.argv[5] ? JSON.parse(process.argv[5]) : {};
const verbose = !!process.env.V;
const map = new GameMap(ARENA), world = new World(ARENA, map);
let tot = 0, totK = 0, maxMs = 0; const agg = { cubes: 0, cubes90: 0, mech: 0, npc: 0, zone: 0, unstick: 0, rear: 0, dmgEv: 0 }; const places = [];
for (let k = 0; k < N; k++) {
  const seed = seed0 + k; const r = mulberry(seed * 31 + 7); const slot = (r() * 16) | 0;
  let match, player;
  const tiers = ["easy", "easy", "easy", "easy", "medium", "medium", "medium", "medium", "hard", "hard", "hard", "hard", "expert", "expert", "expert"];
  const fac = [];
  if (mode === "practice") {
    const squad = { player: slot, lastSeen: null, tierOf: {} };
    squad.hunters = (t) => { const al = match.mechs.filter((m) => m.alive && m.id !== slot).sort((a, b) => squad.tierOf[a.id] - squad.tierOf[b.id]); const dead = 15 - al.length; const n = process.env.DUEL ? 1 : t > 300 ? 15 : 1 + Math.floor(dead * 0.75) + (t > 200 ? 2 : 0); if (process.env.DUEL) { const want = al.filter((m) => tiers[squad.tierOf[m.id]] === process.env.DUEL); return want.slice(0, 1).map((m) => m.id); } return al.slice(0, n).map((m) => m.id); };
    squad.truePos = () => match.mechs[slot].pos;
    let ti = 0;
    for (let i = 0; i < 16; i++) { if (i === slot) fac.push((h) => (player = new Bot(h, map, params))); else { const tier = tiers[ti]; squad.tierOf[i] = ti++; fac.push((h, m) => new HouseBot(h, m, tier, squad)); } }
  } else {
    // ffa: slot = our bot; half the field are copies with default params, rest are house bots fighting everyone
    let ti = 0;
    for (let i = 0; i < 16; i++) { if (i === slot) fac.push((h) => (player = new Bot(h, map, params))); else if (i % 2 === 0) fac.push((h) => new Bot(h, map, {})); else { const tier = tiers[4 + (ti++ % 11)]; fac.push((h, m) => new HouseBot(h, m, tier, null)); } }
  }
  match = new Match(world, seed, fac);
  if (verbose) {
    const orig = player.act.bind(player); let lastLab = "", lastT = -9;
    player.act = (o) => { const t0 = performance.now(); const a = orig(o); const ms = performance.now() - t0; if (ms > maxMs) maxMs = ms; if (player.label !== lastLab && o.t - lastT > 1.5) { console.log(`  t=${o.t.toFixed(1)} hp=${o.self.hp.toFixed(0)}/${o.self.max_hp.toFixed(0)} cubes=${o.self.cubes} alive=${o.alive} ${player.label} kills=${player.myKills} w=${o.self.weapons[1]?.kind}`); lastLab = player.label; lastT = o.t; } return a; };
  } else { const orig = player.act.bind(player); player.act = (o) => { const t0 = performance.now(); const a = orig(o); const ms = performance.now() - t0; if (ms > maxMs) maxMs = ms; return a; }; }
  { const o2 = player.act.bind(player); player.act = (o) => { for (const e of o.events) if (e.type === 'damaged') { agg.dmgEv++; if (e.rear) agg.rear++; } const a = o2(o); if (player.label === 'unstick') agg.unstick++; if (o.t <= 90 && o.t > 89.85) agg.cubes90 += o.self.cubes; if (o.t <= 60 && o.t > 59.85) { const k = o.self.weapons[1]?.kind || 'none'; agg['w60_' + k] = (agg['w60_' + k] || 0) + 1; } agg.lastCubes = o.self.cubes; return a; }; }
  const t0 = Date.now(); if (process.env.DUEL) { match.cfg.match.duration_s = 150; for (const m of match.mechs) m.duel0 = m.hp; } const res = match.run(); if (process.env.DUEL) { const hs = match.mechs.filter((m) => m.id !== slot && (m.dmgDealt > 0 || !m.alive || m.hp < 1300)); console.log('   duel: me hp', Math.round(match.mechs[slot].hp), 'alive', match.mechs[slot].alive, 'foes', hs.map((m) => `${m.id}:${Math.round(m.hp)}:${m.alive ? 'A' : 'D'}@${m.dead ? m.dead / 20 : ''}`).join(' ')); } const me = res[slot];
  for (const [k, v] of Object.entries(match.mechs[slot].dmgFrom || {})) { if (k === 'zone') agg.zone += v; else if (+k >= 100) agg.npc += v; else agg.mech += v; }
  agg.cubes += agg.lastCubes; agg.lastCubes = 0;
  tot += 16 - me.place; totK += me.kills; places.push(16 - me.place);
  if (verbose) console.log('  dmgFrom', JSON.stringify(Object.fromEntries(Object.entries(match.mechs[slot].dmgFrom||{}).map(([k,v])=>[k+':'+(tiers[Object.keys(match.mechs).filter(i=>+i!==slot).indexOf(k)]||k), Math.round(v)]))), 'enemy hp', match.mechs.filter(m=>m.id!==slot).map(m=>Math.round(m.hp)).join(','));
  console.log(`seed ${seed} slot ${slot}: place ${me.place} pts ${16 - me.place} kills ${me.kills} dmg ${me.dmg.toFixed(0)} died t=${me.t.toFixed(0)} shots=${player.shots.toFixed(0)} hits=${player.hits} ffa=${player.ffa} (${Date.now() - t0} ms)`);
}
console.log('dmg taken/match', Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, k.startsWith('w60') ? v : Math.round(v / N)])));
console.log(`MEAN ${(tot / N).toFixed(2)} kills ${(totK / N).toFixed(2)} maxActMs ${maxMs.toFixed(1)}  [${places.join(",")}]`);
