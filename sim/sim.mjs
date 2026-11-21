// Approximate local simulator for testing the bot. NOT the real game: ground movement only, guessed house bots.
import fs from "node:fs";
import path from "node:path";
import { GameMap, inPoly } from "../map.mjs";

const TAU = Math.PI * 2, hyp = Math.hypot;
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class World {
  constructor(dir, map) {
    this.map = map;
    const world = JSON.parse(fs.readFileSync(path.join(dir, "v2/world.json"), "utf8"));
    const T = world.terrain; this.T = T; this.nx = T.nx - 1; this.ny = T.ny - 1;
    this.top = new Float32Array(this.nx * this.ny); this.solid = new Uint8Array(this.nx * this.ny); this.gnd = new Float32Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) { const g = map.terrainAt(T.minX + i + 0.5, T.minY + j + 0.5); this.gnd[j * this.nx + i] = g; this.top[j * this.nx + i] = g; }
    for (const p of world.prisms) {
      const r = p.ring; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let k = 0; k < r.length; k += 2) { x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]); y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1]); }
      for (let j = Math.max(0, Math.floor(y0 - T.minY)); j <= Math.min(this.ny - 1, Math.ceil(y1 - T.minY)); j++)
        for (let i = Math.max(0, Math.floor(x0 - T.minX)); i <= Math.min(this.nx - 1, Math.ceil(x1 - T.minX)); i++) {
          const x = T.minX + i + 0.5, y = T.minY + j + 0.5;
          if (!inPoly(r, x, y)) continue; let h = false; for (const hl of p.holes || []) if (inPoly(hl, x, y)) h = true; if (h) continue;
          const c = j * this.nx + i, g = map.terrainAt(x, y);
          if (p.base > g + 4) { if (p.base - g < 9) this.solid[c] = 1; continue; }
          if (p.top <= g + 1.2) { this.gnd[c] = Math.max(this.gnd[c], p.top); this.top[c] = Math.max(this.top[c], p.top); }
          else { this.solid[c] = 1; this.top[c] = Math.max(this.top[c], p.top); }
        }
    }
    this.bounds = world.bounds;
  }
  cell(x, y) { const i = clamp(Math.floor(x - this.T.minX), 0, this.nx - 1), j = clamp(Math.floor(y - this.T.minY), 0, this.ny - 1); return j * this.nx + i; }
  free(x, y, r) {
    const b = this.bounds; if (x < b.minX + r || x > b.maxX - r || y < b.minY + r || y > b.maxY - r) return false;
    if (this.solid[this.cell(x, y)]) return false;
    for (let k = 0; k < 8; k++) { const a = (k * TAU) / 8; if (this.solid[this.cell(x + Math.cos(a) * r, y + Math.sin(a) * r)]) return false; }
    return true;
  }
  ground(x, y) { return this.gnd[this.cell(x, y)]; }
  los(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, n = Math.ceil(hyp(dx, dy) / 0.9);
    for (let k = 1; k < n; k++) { const f = k / n; if (this.top[this.cell(x0 + dx * f, y0 + dy * f)] > z0 + dz * f + 0.05) return false; }
    return true;
  }
}

const baseCfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));

export class Match {
  // controllers: array of 16 factories (hello) => { act(obs), name }
  constructor(world, seed, factories, opts = {}) {
    this.w = world; this.map = world.map; this.cfg = JSON.parse(JSON.stringify(baseCfg)); this.rnd = mulberry(seed); this.opts = opts;
    const cfg = this.cfg, rnd = this.rnd;
    this.tick = 0; this.t = 0; this.nextId = { cube: 5000, pick: 8000, proj: 1 };
    this.projs = []; this.cubes = []; this.pickups = []; this.crates = []; this.npcs = []; this.drops = []; this.beams = [];
    // zone phases
    this.phases = []; let c = cfg.zone.start_center.slice(), r = cfg.zone.start_radius, tt = 0;
    for (const ph of cfg.zone.phases) {
      const a = rnd() * TAU, d = Math.sqrt(rnd()) * (r - ph.radius) * 0.9; const nc = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d];
      this.phases.push({ c0: c, r0: r, c1: nc, r1: ph.radius, start: tt + ph.hold_s, end: tt + ph.hold_s + ph.shrink_s, dps: ph.dps, t0: tt });
      tt += ph.hold_s + ph.shrink_s; c = nc; r = ph.radius;
    }
    const openPt = (cx, cy, rad) => { for (let k = 0; k < 4000; k++) { const a = rnd() * TAU, d = Math.sqrt(rnd()) * rad; const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d; const cc = this.map.cellOf(x, y); if (this.map.comp[cc] && this.map.nearWall[cc] > 2 && world.free(x, y, 3)) return [x, y, world.ground(x, y)]; } return [cx, cy, 0]; };
    this.openPt = openPt;
    const zc = cfg.zone.start_center, zr = cfg.zone.start_radius;
    this.mechs = [];
    const spawns = [];
    for (let i = 0; i < 16; i++) { let p; for (let k = 0; k < 200; k++) { p = openPt(zc[0], zc[1], zr * cfg.match.spawn_zone_fraction); if (spawns.every((s) => hyp(s[0] - p[0], s[1] - p[1]) > cfg.match.spawn_min_separation)) break; } spawns.push(p); }
    for (let i = 0; i < 16; i++) {
      const mstats = { ...cfg.mech, radius: 2.5, height: 9 };
      const m = { id: i, kind: "mech", pos: spawns[i].slice(), vel: [0, 0, 0], aim: [rnd() * TAU - Math.PI, 0], cmd: {}, hp: cfg.mech.hp, energy: cfg.mech.energy, cubes: 0, upgrades: [], alive: true,
        base: mstats, stats: { ...mstats }, wst: JSON.parse(JSON.stringify(cfg.weapons)), weapons: [{ kind: "gun", cooldown: 0, ammo: cfg.weapons.gun.mag, reload: 0 }, null], lastCombat: -99, lastSpend: -99, events: [], seen: new Map(), offers: [], offer: null, thrIdx: 0, kills: 0, place: 0, dmgDealt: 0 };
      this.mechs.push(m);
    }
    for (let i = 0; i < cfg.crates.count; i++) { const p = openPt(zc[0], zc[1], zr * 0.9); this.crates.push({ id: 1000 + i, pos: p, hp: cfg.crates.hp }); }
    const kinds = ["mortar", "laser", "lightning"];
    for (let i = 0; i < cfg.loot.floor_count; i++) { const p = openPt(zc[0], zc[1], zr * 0.9); this.pickups.push({ id: this.nextId.pick++, kind: kinds[(rnd() * 3) | 0], pos: p }); }
    for (let i = 0; i < cfg.npc.count; i++) { const p = openPt(zc[0], zc[1], zr * 0.9); this.npcs.push({ id: 100 + i, kind: "npc", pos: p, home: p.slice(), vel: [0, 0, 0], aim: [0, 0], hp: cfg.npc.hp, max_hp: cfg.npc.hp, cd: 0, tgt: null, cubes: 0 }); }
    this.ctl = factories.map((f, i) => f({ type: "hello", protocol: "mechfight/1", slot: i, seed: (seed * 7919 + i * 104729) >>> 0, map: { dir: "" }, config: cfg }, this));
    this.alive = 16; this.order = [];
    if (opts.only) { for (const m of this.mechs) if (!opts.only.includes(m.id)) { m.alive = false; m.place = 16; this.alive--; } if (opts.dist) { const a = this.mechs[opts.only[0]], b = this.mechs[opts.only[1]]; for (let k = 0; k < 500; k++) { const p = this.openPt(a.pos[0], a.pos[1], opts.dist * 1.3); const d = hyp(p[0] - a.pos[0], p[1] - a.pos[1]); if (d > opts.dist * 0.8 && d < opts.dist * 1.2) { b.pos = p; break; } } } this.npcs = []; }
  }
  maxHp(m) { return m.stats.hp * (1 + this.cfg.cubes.hp_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap)); }
  scale(m) { return 1 + 0.05 * m.cubes; }
  zone() {
    const t = this.t; let ph = this.phases[this.phases.length - 1];
    for (const p of this.phases) if (t < p.end) { ph = p; break; }
    const f = clamp((t - ph.start) / (ph.end - ph.start), 0, 1);
    return { center: [ph.c0[0] + (ph.c1[0] - ph.c0[0]) * f, ph.c0[1] + (ph.c1[1] - ph.c0[1]) * f], radius: ph.r0 + (ph.r1 - ph.r0) * f, next_center: ph.c1, next_radius: ph.r1, shrink_start: ph.start, shrink_end: ph.end, dps: ph.dps };
  }
  wstats(m, w) { return m.wst[w.kind]; }
  damage(tgt, amount, by, weapon, from) {
    if (!tgt.alive && tgt.kind === "mech") return;
    if (tgt.kind === "mech") {
      let rear = false;
      if (from) { const b = Math.atan2(from[1] - tgt.pos[1], from[0] - tgt.pos[0]); rear = Math.abs(wrap(b - tgt.aim[0])) > (this.cfg.mech.front_arc_deg * Math.PI) / 360; }
      if (weapon !== "zone") amount *= (rear ? this.cfg.mech.rear_mult : 1) * (1 - tgt.stats.armor);
      tgt.hp -= amount; tgt.lastCombat = this.t; (tgt.dmgFrom ??= {})[by ? by.id : weapon] = ((tgt.dmgFrom[by ? by.id : weapon]) || 0) + amount;
      tgt.events.push({ type: "damaged", amount, weapon, bearing: from ? Math.atan2(from[1] - tgt.pos[1], from[0] - tgt.pos[0]) : null, by: by ? by.id : null, ...(rear ? { rear: true } : {}) });
      if (by && by.kind === "mech") { by.lastCombat = this.t; by.dmgDealt += amount; if (weapon === 'gun') by.gunHits = (by.gunHits || 0) + 1; by.events.push({ type: "hit", target: tgt.id, amount, weapon }); }
      if (tgt.hp <= 0) this.kill(tgt, by);
    } else {
      tgt.hp -= amount;
      if (by && by.kind === "mech") { by.lastCombat = this.t; by.events.push({ type: "hit", target: tgt.id, amount, weapon }); if (tgt.kind === "npc") tgt.tgt = by; }
    }
  }
  dropCubes(pos, n) { for (let k = 0; k < n; k++) { const a = this.rnd() * TAU, d = 1 + this.rnd() * 3; this.cubes.push({ id: this.nextId.cube++, pos: [pos[0] + Math.cos(a) * d, pos[1] + Math.sin(a) * d, pos[2]] }); } }
  kill(m, by) {
    m.alive = false; m.dead = this.tick; this.deadThisTick.push(m);
    if (by && by.kind === "mech" && by !== m) { by.kills++; by.events.push({ type: "kill", target: m.id }); }
    this.dropCubes(m.pos, m.cubes + this.cfg.cubes.death_drop_extra);
    if (m.weapons[1]) this.pickups.push({ id: this.nextId.pick++, kind: m.weapons[1].kind, pos: m.pos.slice() });
  }
  applyUpgrade(m, id) {
    const u = this.cfg.upgrades.find((x) => x.id === id); m.upgrades.push(id); const hpBefore = this.maxHp(m);
    for (const e of u.effects) { const [a, b, c] = e.path.split("."); const o = a === "mech" ? m.stats : m.wst[b]; const k = a === "mech" ? b : c; if (e.mul != null) o[k] *= e.mul; if (e.add != null) o[k] += e.add; }
    m.hp += Math.max(0, this.maxHp(m) - hpBefore); m.events.push({ type: "upgrade", id });
  }
  drawOffer(m) {
    const have = (k) => m.weapons.some((w) => w && w.kind === k);
    const ok = this.cfg.upgrades.filter((u) => m.upgrades.filter((x) => x === u.id).length < u.max && (!u.requires || have(u.requires)));
    const ch = []; while (ch.length < 3 && ok.length) ch.push(ok.splice((this.rnd() * ok.length) | 0, 1)[0]);
    return { id: m.thrIdx, expires: this.t + 5, choices: ch.map((u) => ({ id: u.id, name: u.name, desc: u.desc })) };
  }
  addCube(m) {
    const before = this.maxHp(m); m.cubes++; m.hp += this.maxHp(m) - before; m.events.push({ type: "pickup", cubes: m.cubes });
    const th = this.cfg.cubes.upgrade_thresholds; while (m.thrIdx < th.length && m.cubes >= th[m.thrIdx]) { m.thrIdx++; m.offers.push(1); }
  }
  visible(m, o, cz) {
    const d = hyp(o.pos[0] - m.pos[0], o.pos[1] - m.pos[1]); const v = this.cfg.vision;
    if (d > v.range) return false;
    if (d > v.near_range && Math.abs(wrap(Math.atan2(o.pos[1] - m.pos[1], o.pos[0] - m.pos[0]) - m.aim[0])) > (v.fov_deg * Math.PI) / 360) return false;
    return this.w.los(m.pos[0], m.pos[1], m.pos[2] + 8 * this.scale(m), o.pos[0], o.pos[1], cz);
  }
  obsFor(m) {
    const cfg = this.cfg, mechs = [];
    for (const o of this.mechs) { if (o === m || !o.alive) continue; if (this.visible(m, o, o.pos[2] + 4.5 * this.scale(o))) m.seen.set(o.id, this.t); const s = m.seen.get(o.id); if (s != null && this.t - s <= cfg.vision.memory_s) mechs.push({ id: o.id, kind: "mech", pos: o.pos.slice(), vel: o.vel.slice(), aim: o.aim.slice(), hp: o.hp, max_hp: this.maxHp(o), cubes: o.cubes, weapons: o.weapons.filter(Boolean).map((w) => w.kind), charging: !!(o.weapons[1] && o.weapons[1].charge > 0) }); }
    for (const o of this.npcs) if (this.visible(m, o, o.pos[2] + 1.75)) mechs.push({ id: o.id, kind: "npc", pos: o.pos.slice(), vel: [0, 0, 0], aim: [0, 0], hp: o.hp, max_hp: o.max_hp });
    const vis = (l, h) => l.filter((o) => this.visible(m, o, o.pos[2] + h));
    const ws = m.weapons.map((w) => (w ? { kind: w.kind, cooldown: w.cooldown, ...(w.kind === "gun" ? { ammo: w.ammo, reload: w.reload } : {}), ...(w.kind === "laser" ? { charge: w.charge || 0 } : {}), stats: { ...m.wst[w.kind] } } : null));
    const z = this.zone();
    const ob = { type: "obs", tick: this.tick, t: this.t, alive: this.alive,
      self: { id: m.id, pos: m.pos.slice(), vel: m.vel.slice(), aim: m.aim.slice(), hp: m.hp, max_hp: this.maxHp(m), energy: m.energy, max_energy: m.stats.energy, grounded: true, cubes: m.cubes, upgrades: m.upgrades.slice(), in_zone: hyp(m.pos[0] - z.center[0], m.pos[1] - z.center[1]) <= z.radius, weapons: ws, stats: { ...m.stats, muzzle_height: 7 * this.scale(m), eye_height: 8 * this.scale(m) } },
      mechs, projectiles: this.projs.filter((p) => p.owner !== m && hyp(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) < 200).map((p) => ({ id: p.id, kind: p.kind, pos: p.pos.slice(), vel: p.vel.slice() })),
      crates: vis(this.crates, 1.2).map((c) => ({ id: c.id, pos: c.pos.slice(), hp: c.hp })), cubes: vis(this.cubes, 0.5).map((c) => ({ id: c.id, pos: c.pos.slice() })), pickups: vis(this.pickups, 0.5).map((c) => ({ id: c.id, kind: c.kind, pos: c.pos.slice() })),
      sounds: [], beams: [], events: m.events, drops: this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: d.pos, radius: 8, lands_in: Math.max(0, d.land - this.t), capture_s: 4, progress: d.progress, holder: d.holder })), zone: z, offer: m.offer };
    m.events = [];
    return ob;
  }
  rayHit(shooter, ox, oy, oz, dx, dy, dz, range) { // first mech/npc/crate along a ray; returns {o, d}
    let best = null, bd = range;
    const test = (o, rad, h) => {
      const px = o.pos[0] - ox, py = o.pos[1] - oy; const dh = hyp(dx, dy) || 1e-9; const along = (px * dx + py * dy) / dh; if (along < 0) return;
      const perp = Math.abs(px * dy - py * dx) / dh; if (perp > rad) return; const d3 = along / dh; if (d3 > bd) return;
      const zz = oz + dz * d3; if (zz < o.pos[2] - 0.3 || zz > o.pos[2] + h + 0.3) return; bd = d3; best = o;
    };
    for (const o of this.mechs) if (o.alive && o !== shooter) test(o, 2.5 * this.scale(o), 9 * this.scale(o));
    for (const o of this.npcs) if (o !== shooter) test(o, 1.8, 3.5);
    for (const o of this.crates) test(o, 1.4, 2.4);
    // walls
    const n = Math.ceil(bd / 1.0);
    for (let k = 1; k <= n; k++) { const d = (k / n) * bd; if (this.w.top[this.w.cell(ox + dx * d, oy + dy * d)] > oz + dz * d) return { o: null, d }; }
    return { o: best, d: bd };
  }
  step() {
    const cfg = this.cfg, dt = 1 / cfg.match.tick_hz; this.deadThisTick = [];
    if (this.tick % cfg.match.decide_every === 0) {
      for (const m of this.mechs) {
        if (!m.alive) continue;
        if (!m.offer && m.offers.length) { m.offers.pop(); m.offer = this.drawOffer(m); if (!m.offer.choices.length) m.offer = null; }
        const ob = this.obsFor(m);
        let a; try { a = this.ctl[m.id].act(ob) || {}; } catch (e) { if (!this.errShown) { console.error("BOT ERROR slot", m.id, e.stack); this.errShown = true; } a = {}; }
        m.cmd = { move: a.move || [0, 0], boost: !!a.boost, aim: a.aim || m.cmd.aim || m.aim, fire: a.fire || [false, false], reload: !!a.reload };
        if (m.offer && (a.pick != null || this.t > m.offer.expires)) { const ch = m.offer.choices[a.pick ?? 0] || m.offer.choices[0]; m.offer = null; this.applyUpgrade(m, ch.id); }
        if (a.take != null) { const pi = this.pickups.findIndex((p) => p.id === a.take); const p = this.pickups[pi]; if (p && hyp(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) <= 4 && !m.weapons.some((w) => w && w.kind === p.kind)) { if (m.weapons[1]) this.pickups.push({ id: this.nextId.pick++, kind: m.weapons[1].kind, pos: m.pos.slice() }); this.pickups.splice(this.pickups.indexOf(p), 1); m.weapons[1] = { kind: p.kind, cooldown: Math.max(1, m.wst[p.kind].cooldown), charge: 0 }; m.events.push({ type: "took", id: p.id, kind: p.kind, slot: 1 }); } }
      }
    }
    const z = this.zone();
    for (const m of this.mechs) {
      if (!m.alive) continue; const c = m.cmd, st = m.stats;
      // aim slew
      const ca = c.aim || m.aim; const dy = wrap(ca[0] - m.aim[0]); m.aim[0] = wrap(m.aim[0] + clamp(dy, -st.turn_rate * dt, st.turn_rate * dt)); m.aim[1] += clamp(clamp(ca[1], st.min_pitch, st.max_pitch) - m.aim[1], -st.pitch_rate * dt, st.pitch_rate * dt);
      // move
      let mx = c.move ? c.move[0] : 0, my = c.move ? c.move[1] : 0; const ml = hyp(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
      const charging = m.weapons[1] && m.weapons[1].kind === "laser" && m.weapons[1].charge > 0;
      const boosting = c.boost && ml > 0.05 && m.energy > 0;
      let sp = (boosting ? st.boost_speed : st.walk_speed) * (charging ? st.charge_move_mult : 1);
      if (boosting) { m.energy = Math.max(0, m.energy - st.boost_drain * dt); m.lastSpend = this.t; }
      const tvx = mx * sp, tvy = my * sp; let ax = tvx - m.vel[0], ay = tvy - m.vel[1]; const al = hyp(ax, ay), mxa = st.ground_accel * dt; if (al > mxa) { ax *= mxa / al; ay *= mxa / al; }
      m.vel[0] += ax; m.vel[1] += ay;
      const R = 2.5 * this.scale(m); let nx = m.pos[0] + m.vel[0] * dt, ny = m.pos[1] + m.vel[1] * dt;
      const can = (x, y) => this.w.free(x, y, R) && this.w.ground(x, y) - m.pos[2] <= Math.max(1.2, hyp(x - m.pos[0], y - m.pos[1]) * 1.19 + 0.5);
      if (can(nx, ny)) { m.pos[0] = nx; m.pos[1] = ny; } else { let done = false; const sp2 = hyp(m.vel[0], m.vel[1]), a0 = Math.atan2(m.vel[1], m.vel[0]);
        for (const da of [0.5, -0.5, 1.0, -1.0, 1.4, -1.4]) { const f = Math.cos(da) * sp2 * dt, x = m.pos[0] + Math.cos(a0 + da) * f, y = m.pos[1] + Math.sin(a0 + da) * f; if (can(x, y)) { m.pos[0] = x; m.pos[1] = y; m.vel[0] = Math.cos(a0 + da) * Math.cos(da) * sp2; m.vel[1] = Math.sin(a0 + da) * Math.cos(da) * sp2; done = true; break; } }
        if (!done) { m.vel[0] = 0; m.vel[1] = 0; } }
      m.pos[2] = this.w.ground(m.pos[0], m.pos[1]);
      if (this.t - m.lastSpend > st.energy_regen_delay) m.energy = Math.min(st.energy, m.energy + st.energy_regen * dt);
      // weapons
      const dmul = 1 + cfg.cubes.damage_per_cube * Math.min(m.cubes, cfg.cubes.stat_cap);
      const dir = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])];
      const mz = m.pos[2] + 7 * this.scale(m);
      const g = m.weapons[0];
      if (g) {
        g.cooldown = Math.max(0, g.cooldown - dt);
        const gs = m.wst.gun;
        if (g.reload > 0) { g.reload -= dt; if (g.reload <= 0) { g.reload = 0; g.ammo = gs.mag; } }
        else if ((c.reload && g.ammo < gs.mag) || g.ammo <= 0) { g.reload = gs.reload; c.reload = false; }
        else if (c.fire[0] && g.cooldown <= 0 && g.ammo > 0) {
          g.ammo--; m.fired = (m.fired || 0) + 1; g.cooldown = gs.cooldown; const sd = (gs.spread_deg * Math.PI) / 180; const gauss = () => (this.rnd() + this.rnd() + this.rnd() + this.rnd() - 2) * 1.73;
          const yaw = m.aim[0] + gauss() * sd, pit = m.aim[1] + gauss() * sd; const d = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)];
          this.projs.push({ id: this.nextId.proj++, kind: "gun", owner: m, pos: [m.pos[0] + d[0] * 3, m.pos[1] + d[1] * 3, mz + d[2] * 3], vel: d.map((v) => v * gs.speed), left: gs.range, dmg: gs.damage * dmul });
        }
      }
      const w = m.weapons[1];
      if (w) {
        w.cooldown = Math.max(0, w.cooldown - dt); const ws = m.wst[w.kind];
        if (w.kind === "laser") {
          const fireNow = () => { const frac = ws.min_frac + (1 - ws.min_frac) * clamp(w.charge / ws.charge, 0, 1); const h = this.rayHit(m, m.pos[0], m.pos[1], mz, dir[0], dir[1], dir[2], ws.range); if (h.o) this.damage(h.o, ws.damage * frac * dmul, m, "laser", m.pos); w.charge = 0; w.cooldown = ws.cooldown; w.held = 0; };
          if (w.charge > 0) { if (c.fire[1]) { w.charge = Math.min(ws.charge, w.charge + dt); if (w.charge >= ws.charge) { w.held = (w.held || 0) + dt; if (w.held > ws.hold_s) fireNow(); } } else if (w.charge >= ws.min_charge) fireNow(); else w.charge += dt; }
          else if (c.fire[1] && w.cooldown <= 0) w.charge = dt;
        } else if (w.kind === "lightning") {
          if (c.fire[1] && w.cooldown <= 0 && m.energy >= ws.energy) {
            w.cooldown = ws.cooldown; m.energy -= ws.energy; m.lastSpend = this.t;
            let best = null, bd = ws.range; for (const o of [...this.mechs, ...this.npcs, ...this.crates]) { if (o === m || o.alive === false) continue; const d = hyp(o.pos[0] - m.pos[0], o.pos[1] - m.pos[1]); if (d < bd && Math.abs(wrap(Math.atan2(o.pos[1] - m.pos[1], o.pos[0] - m.pos[0]) - m.aim[0])) < (ws.cone_deg * Math.PI) / 180 && this.w.los(m.pos[0], m.pos[1], mz, o.pos[0], o.pos[1], o.pos[2] + 2)) { bd = d; best = o; } }
            if (best) this.damage(best, ws.damage * dmul, m, "lightning", m.pos);
          }
        } else if (w.kind === "mortar") { if (c.fire[1] && w.cooldown <= 0) w.cooldown = ws.cooldown; }
      }
      // zone + regen
      if (hyp(m.pos[0] - z.center[0], m.pos[1] - z.center[1]) > z.radius) { m.hp -= z.dps * dt; m.lastCombat = this.t; if (m.hp <= 0 && m.alive) this.kill(m, null); }
      else if (this.t - m.lastCombat > st.regen_delay) m.hp = Math.min(this.maxHp(m), m.hp + st.regen_per_s * dt);
    }
    // projectiles
    for (const p of this.projs) {
      const sp = hyp(p.vel[0], p.vel[1], p.vel[2]), d = [p.vel[0] / sp, p.vel[1] / sp, p.vel[2] / sp], len = Math.min(sp * dt, p.left);
      const h = this.rayHit(p.owner, p.pos[0], p.pos[1], p.pos[2], d[0], d[1], d[2], len);
      if (h.o || h.d < len - 1e-6) { p.dead = true; if (h.o) this.damage(h.o, p.dmg, p.owner, p.kind, [p.pos[0] - d[0] * 50, p.pos[1] - d[1] * 50]); }
      else { p.pos[0] += d[0] * len; p.pos[1] += d[1] * len; p.pos[2] += d[2] * len; p.left -= len; if (p.left <= 0) p.dead = true; }
    }
    this.projs = this.projs.filter((p) => !p.dead);
    // crates / npcs
    for (const c of this.crates) if (c.hp <= 0) { this.dropCubes(c.pos, 1); if (this.rnd() < cfg.loot.crate_weapon_chance) this.pickups.push({ id: this.nextId.pick++, kind: ["mortar", "laser", "lightning"][(this.rnd() * 3) | 0], pos: c.pos.slice() }); }
    this.crates = this.crates.filter((c) => c.hp > 0);
    for (const n of this.npcs) {
      if (n.hp <= 0) { this.dropCubes(n.pos, cfg.npc.cubes); continue; }
      n.cd -= dt; let tg = n.tgt && n.tgt.alive && hyp(n.tgt.pos[0] - n.pos[0], n.tgt.pos[1] - n.pos[1]) < 90 ? n.tgt : null;
      if (!tg) for (const m of this.mechs) if (m.alive && hyp(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1]) < cfg.npc.aggro_range) { tg = m; break; }
      if (tg && n.cd <= 0 && this.w.los(n.pos[0], n.pos[1], n.pos[2] + 2, tg.pos[0], tg.pos[1], tg.pos[2] + 4.5)) {
        n.cd = cfg.npc.cooldown; const dx = tg.pos[0] - n.pos[0], dy2 = tg.pos[1] - n.pos[1], dz = tg.pos[2] + 4.5 - n.pos[2] - 2, d = hyp(dx, dy2, dz); const yaw = Math.atan2(dy2, dx) + (this.rnd() - 0.5) * 0.09;
        const dh = hyp(dx, dy2); this.projs.push({ id: this.nextId.proj++, kind: "npc", owner: n, pos: [n.pos[0], n.pos[1], n.pos[2] + 2], vel: [Math.cos(yaw) * dh / d * 90, Math.sin(yaw) * dh / d * 90, dz / d * 90], left: 120, dmg: cfg.npc.damage });
      }
    }
    this.npcs = this.npcs.filter((n) => n.hp > 0);
    // cubes
    for (const c of this.cubes) { let best = null, bd = cfg.cubes.pickup_radius; for (const m of this.mechs) if (m.alive) { const d = hyp(m.pos[0] - c.pos[0], m.pos[1] - c.pos[1]); if (d < bd) { bd = d; best = m; } } if (best) { c.dead = true; this.addCube(best); } }
    this.cubes = this.cubes.filter((c) => !c.dead);
    // supply drops
    cfg.drops.times.forEach((tm, i) => { if (!this.drops[i] && this.t >= tm) { const zz = this.zone(); const p = this.openPt(zz.next_center[0], zz.next_center[1], zz.next_radius * 0.7); this.drops[i] = { id: 20000 + i, pos: p, land: tm + cfg.drops.fall_s, progress: 0, holder: null }; } });
    for (const d of this.drops) { if (!d || d.taken || this.t < d.land) continue; const inr = this.mechs.filter((m) => m.alive && hyp(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) < 8); if (inr.length === 1) { if (d.holder !== inr[0].id) { d.holder = inr[0].id; d.progress = 0; } d.progress += dt; if (d.progress >= 4) { d.taken = true; for (let k = 0; k < 3; k++) this.addCube(inr[0]); inr[0].hp = this.maxHp(inr[0]); inr[0].energy = inr[0].stats.energy; } } else if (inr.length === 0) { d.holder = null; d.progress = 0; } }
    this.drops = this.drops.filter(Boolean).concat([]);
    // placements
    if (this.deadThisTick.length) { const place = this.alive; for (const m of this.deadThisTick) { m.place = place - this.deadThisTick.length + 1; this.order.push(m.id); } this.alive -= this.deadThisTick.length; }
    this.tick++; this.t = this.tick * dt;
  }
  run() {
    while (this.alive > 1 && this.t < this.cfg.match.duration_s) this.step();
    const left = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp); left.forEach((m, i) => (m.place = i + 1));
    return this.mechs.map((m) => ({ id: m.id, place: m.place, kills: m.kills, dmg: m.dmgDealt, t: m.alive ? this.t : m.dead / 20 }));
  }
}

// ---------- guessed house bots ----------
const TIERS = {
  easy: { lead: 0, noise: 0.05, strafe: 0, react: 0.5, range: 120, loot: 0 },
  medium: { lead: 1, noise: 0.03, strafe: 2.0, react: 0.3, range: 110, loot: 0.5 },
  hard: { lead: 1, noise: 0.015, strafe: 1.1, react: 0.15, range: 100, loot: 1 },
  expert: { lead: 1, noise: 0.007, strafe: 0.7, react: 0.05, range: 100, loot: 1, cover: 1 },
};
export class HouseBot {
  constructor(hello, match, tier, squad) { this.T = TIERS[tier]; this.tier = tier; this.match = match; this.map = match.map; this.id = hello.slot; this.squad = squad; this.rnd = mulberry(hello.seed); this.sT = 0; this.s = 1; this.pathT = -9; this.n = [0, 0]; this.wander = null; }
  nav(me, gx, gy, t) {
    if (t - this.pathT > 1) { this.path = this.map.path(me.pos[0], me.pos[1], gx, gy, 20000); this.pathT = t + this.rnd() * 0.3; this.pi = 0; }
    const p = this.path; if (!p || p.length < 2) return [0, 0];
    let bi = this.pi, bd = 1e9; for (let i = this.pi; i < Math.min(p.length, this.pi + 10); i++) { const d = hyp(this.map.cx(p[i]) - me.pos[0], this.map.cy(p[i]) - me.pos[1]); if (d < bd) { bd = d; bi = i; } } this.pi = bi;
    const c = p[Math.min(p.length - 1, bi + 3)]; const dx = this.map.cx(c) - me.pos[0], dy = this.map.cy(c) - me.pos[1], d = hyp(dx, dy) || 1; return [dx / d, dy / d];
  }
  act(obs) {
    const me = obs.self, t = obs.t, T = this.T, z = obs.zone, a = { tick: obs.tick, fire: [false, false] };
    if (obs.offer) a.pick = (this.rnd() * 3) | 0;
    const sq = this.squad;
    // who can I fight?
    let tgt = null;
    if (sq) { // squad mode: only the player is an enemy; shared vision
      const pl = obs.mechs.find((m) => m.id === sq.player); if (pl) { sq.lastSeen = { pos: pl.pos, vel: pl.vel, t }; }
      const hunting = sq.hunters(t).includes(this.id);
      if (pl && hyp(pl.pos[0] - me.pos[0], pl.pos[1] - me.pos[1]) < (hunting ? 230 : (+process.env.NH || 60))) tgt = pl;
      this.goal = hunting && sq.lastSeen ? sq.lastSeen.pos : sq.truePos && hunting ? sq.truePos() : null;
    } else { let bd = 220; for (const m of obs.mechs) if (m.kind === "mech") { const d = hyp(m.pos[0] - me.pos[0], m.pos[1] - me.pos[1]); if (d < bd) { bd = d; tgt = m; } } this.goal = null; }
    const out = hyp(me.pos[0] - z.next_center[0], me.pos[1] - z.next_center[1]) > z.next_radius * 0.8 && t > z.shrink_start - 25 || !me.in_zone;
    let mv = [0, 0];
    const los = tgt && this.match.w.los(me.pos[0], me.pos[1], me.pos[2] + 7, tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5);
    if (tgt && los) {
      const dx = tgt.pos[0] - me.pos[0], dy = tgt.pos[1] - me.pos[1], d = hyp(dx, dy);
      let tt = T.lead ? d / 252 : 0; const ax = tgt.pos[0] + tgt.vel[0] * tt - me.pos[0], ay = tgt.pos[1] + tgt.vel[1] * tt - me.pos[1];
      if (t > (this.nT || 0)) { this.nT = t + 0.3; this.n = [(this.rnd() - 0.5) * 2 * T.noise, (this.rnd() - 0.5) * T.noise]; }
      a.aim = [Math.atan2(ay, ax) + this.n[0], Math.atan2(tgt.pos[2] + 4.5 - me.pos[2] - 7, hyp(ax, ay)) + this.n[1]];
      this.sawT = this.sawT ?? t; if (t - this.sawT >= T.react) { a.fire = [Math.abs(wrap(me.aim[0] - a.aim[0])) < 0.06, true]; if (me.weapons[1] && me.weapons[1].kind === "laser" && me.weapons[1].charge >= me.weapons[1].stats.charge) a.fire[1] = false; }
      const ux = dx / d, uy = dy / d, rad = clamp((d - T.range) / 30, -1, 1);
      if (T.strafe) { if (t > this.sT) { this.s = -this.s; this.sT = t + T.strafe * (0.6 + this.rnd() * 0.8); } mv = [-uy * this.s + ux * rad, ux * this.s + uy * rad]; if (!this.map.walkable(me.pos[0] + mv[0] * 5, me.pos[1] + mv[1] * 5)) { this.s = -this.s; mv = [ux * rad, uy * rad]; } }
      else mv = [ux * rad, uy * rad];
      if (out) mv = this.nav(me, z.next_center[0], z.next_center[1], t);
    } else {
      this.sawT = null;
      let g = this.goal;
      if (out || !g) {
        if (!out && T.loot) { let bd = 150; for (const c of obs.cubes) { const d = hyp(c.pos[0] - me.pos[0], c.pos[1] - me.pos[1]); if (d < bd) { bd = d; g = c.pos; } } if (!g) for (const c of obs.crates) { const d = hyp(c.pos[0] - me.pos[0], c.pos[1] - me.pos[1]); if (d < bd) { bd = d; g = c.pos; if (d < 60) { a.aim = [Math.atan2(c.pos[1] - me.pos[1], c.pos[0] - me.pos[0]), Math.atan2(c.pos[2] + 1.2 - me.pos[2] - 7, d)]; a.fire = [true, false]; } } } for (const p of obs.pickups) if (!me.weapons[1] && hyp(p.pos[0] - me.pos[0], p.pos[1] - me.pos[1]) < 3.5) a.take = p.id; else if (!me.weapons[1] && hyp(p.pos[0] - me.pos[0], p.pos[1] - me.pos[1]) < 60) g = p.pos; }
        if (!g) { if (!this.wander || t > this.wT || hyp(this.wander[0] - z.next_center[0], this.wander[1] - z.next_center[1]) > z.next_radius * 0.8) { const an = this.rnd() * TAU, r = this.rnd() * z.next_radius * 0.7; this.wander = [z.next_center[0] + Math.cos(an) * r, z.next_center[1] + Math.sin(an) * r]; this.wT = t + 25; } g = this.wander; }
        if (out) g = z.next_center;
      }
      if (hyp(g[0] - me.pos[0], g[1] - me.pos[1]) > 6) mv = this.nav(me, g[0], g[1], t);
      if (!a.aim) a.aim = [Math.atan2(mv[1], mv[0]) + Math.sin(t) * 0.8, 0];
    }
    a.move = mv; a.boost = !me.in_zone;
    return a;
  }
}
