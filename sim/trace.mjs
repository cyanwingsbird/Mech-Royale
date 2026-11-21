import { GameMap } from "../map.mjs";
import { Bot } from "../bot.mjs";
import { World, Match, HouseBot } from "./sim.mjs";
const ARENA = "/tmp/kit/mechfight-kit/arena";
const map = new GameMap(ARENA), world = new World(ARENA, map);
const tier = process.argv[2], seed = +process.argv[3], params = process.argv[4] ? JSON.parse(process.argv[4]) : {};
let player; const fac = []; for (let i = 0; i < 16; i++) fac.push(i === 0 ? (h) => (player = new Bot(h, map, params)) : (h, m) => (tier === "self" ? new Bot(h, map, {}) : new HouseBot(h, m, tier, null)));
const match = new Match(world, seed, fac, { only: [0, 1], dist: +(process.env.DIST || 150) });
let last = "", lt = -9;
while (match.alive > 1 && match.t < 120) { match.step(); const a = match.mechs[0], b = match.mechs[1];
  if (match.tick % 2 === 0 && (player.label !== last && match.t - lt > 0.6 || match.tick % 100 === 0)) { last = player.label; lt = match.t; console.log(`t=${match.t.toFixed(1)} me hp=${a.hp.toFixed(0)} pos=${a.pos.map((v) => v.toFixed(0))} ammo=${a.weapons[0].ammo} w=${a.weapons[1]?.kind} | foe hp=${b.hp.toFixed(0)} pos=${b.pos.map((v) => v.toFixed(0))} d=${Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]).toFixed(0)} los=${world.los(a.pos[0], a.pos[1], a.pos[2] + 7, b.pos[0], b.pos[1], b.pos[2] + 4.5)} botlos=${player.en.get(1)?.los} | ${player.label} shots=${player.shots.toFixed(0)} hits=${player.hits}`); } }
