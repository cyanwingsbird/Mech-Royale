// 1v1 duels: node sim/duel.mjs tier n [paramsJSON]  -> win rate and hp margin
import { GameMap } from "../map.mjs";
import { Bot } from "../bot.mjs";
import { World, Match, HouseBot } from "./sim.mjs";
const ARENA = process.env.ARENA || "/tmp/kit/mechfight-kit/arena";
const map = new GameMap(ARENA), world = new World(ARENA, map);
const tiersArg = (process.argv[2] || "easy,medium,hard,expert").split(","), N = +(process.argv[3] || 20), params = process.argv[4] ? JSON.parse(process.argv[4]) : {};
for (const tier of tiersArg) {
  let fa = 0, ha = 0, fb = 0, hb = 0; let wins = 0, hpl = 0, tsum = 0, dts = 0, draws = 0;
  for (let k = 0; k < N; k++) {
    let player;
    const fac = []; for (let i = 0; i < 16; i++) fac.push(i === 0 ? (h) => (player = new Bot(h, map, params)) : (h, m) => (tier === "self" ? new Bot(h, map, {}) : new HouseBot(h, m, tier, null)));
    const match = new Match(world, 100 + k, fac, { only: [0, 1], dist: +(process.env.DIST || 150) });
    match.cfg.match.duration_s = 120;
    while (match.alive > 1 && match.t < 120) match.step();
    const a = match.mechs[0], b = match.mechs[1];
    if (a.alive && !b.alive) { wins++; hpl += a.hp / match.maxHp(a); tsum += match.t; } else if (a.alive && b.alive) draws++;
    fa += a.fired || 0; ha += a.gunHits || 0; fb += b.fired || 0; hb += b.gunHits || 0;
    dts += (b.dmgFrom?.[0] || 0) - (a.dmgFrom?.[1] || 0);
  }
  console.log(`${tier}: wins ${wins}/${N} draws ${draws} avgHpLeftOnWin ${(hpl / Math.max(1, wins)).toFixed(2)} avgWinTime ${(tsum / Math.max(1, wins)).toFixed(0)}s netDmg ${(dts / N).toFixed(0)} myAcc ${(ha / fa).toFixed(2)} (${(fa/N).toFixed(0)} shots) foeAcc ${(hb / fb).toFixed(2)} (${(fb/N).toFixed(0)})`);
}
