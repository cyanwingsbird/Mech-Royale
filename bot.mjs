// Mech Royale bot: ranged duelist that fights from health, heals behind cover, farms cubes when clear.
import { CS } from "./map.mjs";

const TAU = Math.PI * 2;
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hyp = Math.hypot;

export const PARAMS = {
  wantRange: 110, // preferred gun duel distance
  retreatHp: 0.42, // go to cover below this
  returnHp: 0.85, // come back above this
  outnumberStep: 0.14, // extra retreat threshold per additional attacker
  strafeMin: 0.35, strafeMax: 0.95,
  crateRange: 70, npcRange: 85,
  farmHp: 0.5,
  npcFarmHp: 0.6,
  farmBias: 1.0,
  velBlend: 0.5, // lead on blend of instantaneous and smoothed velocity
  ffaEngage: 130,
  dodge: 1,
  laserRange: 150,
};

const UPG = ["plating", "armor", "gun_damage", "nanites", "gun_rate", "laser_damage", "laser_charge", "servos", "gun_mag", "gun_velocity",
  "lightning_efficiency", "reactor", "capacitor", "gyros", "lightning_range", "lightning_chain", "jets", "mortar_reload", "sensors"];
const WRANK = { laser: 3, lightning: 2, mortar: 1, gun: 0 };

export class Bot {
  constructor(hello, map, params = {}) {
    this.name = "kestrel";
    this.cfg = hello.config; this.map = map; this.id = hello.slot;
    this.P = { ...PARAMS, ...params };
    let s = (hello.seed >>> 0) || 12345;
    this.rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    this.en = new Map(); this.npcs = new Map(); this.crates = new Map(); this.pickups = new Map(); this.cubes = new Map();
    this.prevAlive = hello.config.match.mechs; this.myKills = 0; this.otherDeaths = 0; this.ffa = false;
    this.strafe = 1; this.strafeT = 0; this.retreating = false;
    this.path = null; this.pathGoal = null; this.pathT = -9; this.pathI = 0;
    this.cover = null; this.coverT = -9;
    this.hist = []; this.stuckT = -9; this.unstuckDir = 0;
    this.lastDmgT = -99; this.lastDmgBearing = null; this.lastDmgBy = null;
    this.tgtId = null; this.shots = 0; this.hits = 0;
    this.soundYaw = null; this.soundT = -9;
    this.dt = 1 / hello.config.match.tick_hz * hello.config.match.decide_every;
    this.label = "";
  }

  // ---------- helpers ----------
  centerZ(o) { return o.pos[2] + (o.kind === "npc" ? 1.75 : o.kind === "crate" ? 1.2 : 4.5 * (1 + 0.05 * (o.cubes || 0))); }
  zoneNow() { return this.z; }
  okPos(x, y) {
    const z = this.z;
    const m = Math.min(10, 0.35 * z.radius);
    if (hyp(x - z.center[0], y - z.center[1]) > z.radius - m) return false;
    if (this.zonePull) { const m2 = Math.min(12, 0.4 * z.next_radius); if (hyp(x - z.next_center[0], y - z.next_center[1]) > Math.max(1.5, z.next_radius - m2)) return false; }
    return true;
  }
  seesMe(e, x, y, gz) { // can a shooter at e hit a mech standing at (x,y)?
    const ez = e.pos[2] + 7 * (1 + 0.05 * (e.cubes || 0));
    return this.map.los(e.pos[0], e.pos[1], ez, x, y, gz + 4.5 * this.scale) || this.map.los(e.pos[0], e.pos[1], ez, x, y, gz + 8.5 * this.scale);
  }
  canHit(o) { const me = this.me; return this.map.los(me.pos[0], me.pos[1], me.pos[2] + this.muzzleH, o.pos[0], o.pos[1], this.centerZ(o)); }

  navTo(gx, gy, t) {
    const me = this.me, m = this.map;
    const changed = !this.pathGoal || hyp(gx - this.pathGoal[0], gy - this.pathGoal[1]) > 6;
    if (changed || t - this.pathT > 0.8 || !this.path) {
      m.extraCost = this.npcCost; this.path = m.path(me.pos[0], me.pos[1], gx, gy); m.extraCost = null; this.pathGoal = [gx, gy]; this.pathT = t; this.pathI = 0;
    }
    const p = this.path; if (!p || !p.length) return [0, 0, 0];
    // advance to the closest path index near our progress
    let bi = this.pathI, bd = 1e9;
    for (let i = this.pathI; i < Math.min(p.length, this.pathI + 12); i++) { const d = hyp(m.cx(p[i]) - me.pos[0], m.cy(p[i]) - me.pos[1]); if (d < bd) { bd = d; bi = i; } }
    this.pathI = bi;
    let tx = m.cx(p[Math.min(p.length - 1, bi + 1)]), ty = m.cy(p[Math.min(p.length - 1, bi + 1)]);
    for (let i = Math.min(p.length - 1, bi + 22); i > bi + 1; i -= 3) {
      const x = m.cx(p[i]), y = m.cy(p[i]);
      if (m.walkLine(me.pos[0], me.pos[1], x, y)) { tx = x; ty = y; break; }
    }
    if (bi >= p.length - 2) { tx = gx; ty = gy; if (!m.walkable(tx, ty)) { tx = m.cx(p[p.length - 1]); ty = m.cy(p[p.length - 1]); } }
    const dx = tx - me.pos[0], dy = ty - me.pos[1], d = hyp(dx, dy);
    const rem = hyp(gx - me.pos[0], gy - me.pos[1]);
    if (d < 0.3) return [0, 0, rem];
    return [dx / d, dy / d, rem];
  }

  findCover(threats, t) {
    if (this.cover && t - this.coverT < 0.5) return this.cover;
    this.coverT = t;
    const m = this.map, me = this.me, nx = m.nx;
    const s = m.nearestOpen(me.pos[0], me.pos[1]);
    const ep = ++m.epoch, st = m.stamp, q = m.heap; let qh = 0, qt = 0; q[qt++] = s; st[s] = ep; m.gScore[s] = 0;
    const th = threats.slice(0, 4);
    const hidden = (c) => { const x = m.cx(c), y = m.cy(c), g = m.ground[c]; for (const e of th) if (this.seesMe(e, x, y, g)) return false; return true; };
    let best = null, bestScore = 1e9;
    while (qh < qt) {
      const c = q[qh++], d = m.gScore[c];
      if (best !== null && d > bestScore + 6) break;
      if (d > 45) break;
      if (m.nearWall[c] <= 3 && d < bestScore && this.okPos(m.cx(c), m.cy(c)) && hidden(c)) {
        // want a pocket: neighbours hidden too
        let ok = 0, tot = 0;
        for (const n of [c - 1, c + 1, c - nx, c + nx, c - nx - 1, c - nx + 1, c + nx - 1, c + nx + 1]) { if (m.blocked[n]) continue; tot++; if (hidden(n)) ok++; }
        let sc = d + (tot - ok) * 6;
        // dislike cover close to a threat
        for (const e of th) { const de = hyp(e.pos[0] - m.cx(c), e.pos[1] - m.cy(c)); if (de < 40) sc += (40 - de) * 0.5; }
        if (sc < bestScore) { bestScore = sc; best = c; }
      }
      const i = c % nx;
      for (const n of [c - 1, c + 1, c - nx, c + nx]) {
        if (n < 0 || n >= m.N || st[n] === ep || m.blocked[n]) continue;
        if ((n === c - 1 && i === 0) || (n === c + 1 && i === nx - 1)) continue;
        if (!m.stepOK(c, n)) continue;
        st[n] = ep; m.gScore[n] = d + 1; q[qt++] = n;
      }
    }
    this.cover = best === null ? null : [m.cx(best), m.cy(best)];
    return this.cover;
  }

  lead(o, speed, ahead) {
    const me = this.me;
    const bl = this.P.velBlend;
    const vx = o.vel[0] * (1 - bl) + (o.evx ?? o.vel[0]) * bl, vy = o.vel[1] * (1 - bl) + (o.evy ?? o.vel[1]) * bl;
    const vz = Math.abs(o.vel[2]) > 3 ? o.vel[2] * 0.5 : 0;
    const mx = me.pos[0] + me.vel[0] * ahead, my = me.pos[1] + me.vel[1] * ahead, mz = me.pos[2] + this.muzzleH;
    const px = o.pos[0] + o.vel[0] * ahead, py = o.pos[1] + o.vel[1] * ahead, pz = this.centerZ(o);
    let tt = 0, ax = px, ay = py, az = pz;
    if (speed < 1e8) for (let k = 0; k < 4; k++) {
      ax = px + vx * tt; ay = py + vy * tt; az = pz + vz * tt;
      tt = Math.max(0, hyp(ax - mx, ay - my, az - mz) - 3) / speed;
    }
    const d = hyp(ax - mx, ay - my);
    return { yaw: Math.atan2(ay - my, ax - mx), pitch: Math.atan2(az - mz, d), dist: d, tt };
  }

  // ---------- main ----------
  act(obs) {
    const me = obs.self, t = obs.t, m = this.map, P = this.P, cfg = this.cfg;
    this.me = me; this.z = obs.zone; this.t = t;
    this.scale = 1 + 0.05 * me.cubes; this.muzzleH = me.stats.muzzle_height ?? 7;
    const act = { tick: obs.tick };
    const X = me.pos[0], Y = me.pos[1], Z = me.pos[2];
    const hpF = me.hp / me.max_hp;

    // --- events ---
    let killsNow = 0;
    for (const ev of obs.events || []) {
      if (ev.type === "damaged" && ev.weapon !== "zone") {
        this.lastDmgT = t; if (ev.bearing != null) this.lastDmgBearing = ev.bearing; this.lastDmgBy = ev.by;
        const e = this.en.get(ev.by); if (e) { e.hitMeT = t; e.dmgToMe = (e.dmgToMe || 0) + ev.amount; }
        const n = this.npcs.get(ev.by); if (n) n.hitMeT = t;
      } else if (ev.type === "kill") { killsNow++; this.myKills++; this.en.delete(ev.target); }
      else if (ev.type === "hit") { this.hits++; }
    }
    if (obs.alive < this.prevAlive) { this.otherDeaths += Math.max(0, this.prevAlive - obs.alive - killsNow); this.prevAlive = obs.alive; }
    if (this.otherDeaths >= 2 && !this.ffa) this.ffa = true;

    // --- memory ---
    const seenNow = new Set();
    for (const o of obs.mechs) {
      if (o.kind === "npc") { const p = this.npcs.get(o.id) || {}; Object.assign(p, o, { seenT: t }); this.npcs.set(o.id, p); seenNow.add(o.id); continue; }
      const p = this.en.get(o.id) || { evx: o.vel[0], evy: o.vel[1] };
      const a = 0.22;
      p.evx += (o.vel[0] - p.evx) * a; p.evy += (o.vel[1] - p.evy) * a;
      Object.assign(p, o, { seenT: t }); this.en.set(o.id, p); seenNow.add(o.id);
    }
    for (const [id, e] of this.en) if (t - e.seenT > 25) this.en.delete(id);
    for (const [id, e] of this.npcs) {
      if (t - e.seenT > 90) this.npcs.delete(id);
      else if (t - e.seenT > 1 && hyp(e.pos[0] - X, e.pos[1] - Y) < 30 && m.los(X, Y, Z + 8 * this.scale, e.pos[0], e.pos[1], e.pos[2] + 2)) this.npcs.delete(id); // should be visible: gone
    }
    for (const ev of obs.events || []) if (ev.type === "hit" && ev.target >= 100 && ev.target < 1000) { const n = this.npcs.get(ev.target); if (n) n.angry = t; }
    // path cost around drones we are not hunting
    if (!this.npcCost) this.npcCost = new Float32Array(m.N);
    if (t - (this.npcCostT ?? -9) > 2) {
      this.npcCostT = t; const nc = this.npcCost; nc.fill(0);
      const R = 52, rc = Math.ceil(R / CS);
      for (const n of this.npcs.values()) {
        const c0 = m.cellOf(n.pos[0], n.pos[1]), i0 = c0 % m.nx, j0 = (c0 / m.nx) | 0;
        for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
          const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= m.nx || j >= m.ny) continue;
          const d = Math.hypot(di, dj) * CS; if (d > R) continue;
          nc[j * m.nx + i] += 2.5 * (1 - d / R) + 0.5;
        }
      }
    }
    const eyeZ = Z + 8 * this.scale;
    const sync = (store, list) => {
      const ids = new Set();
      for (const o of list) { store.set(o.id, { ...o, seenT: t }); ids.add(o.id); }
      for (const [id, o] of store) if (!ids.has(id)) {
        const d = hyp(o.pos[0] - X, o.pos[1] - Y);
        if (d < 40 && m.los(X, Y, eyeZ, o.pos[0], o.pos[1], o.pos[2] + 1.5)) store.delete(id); // should be visible but isn't: gone
        else if (t - o.seenT > 90) store.delete(id);
      }
    };
    sync(this.crates, obs.crates || []); sync(this.pickups, obs.pickups || []); sync(this.cubes, obs.cubes || []);
    for (const sd of obs.sounds || []) if (sd.dist !== "far" && sd.kind !== "death" && sd.kind !== "drop" && sd.kind !== "crate" && sd.kind !== "npc_gun") { this.soundYaw = sd.bearing; this.soundT = t - sd.age; }

    // --- zone ---
    const z = obs.zone;
    const dC = hyp(X - z.center[0], Y - z.center[1]), dN = hyp(X - z.next_center[0], Y - z.next_center[1]);
    const walk = me.stats.walk_speed;
    const needDist = Math.max(0, dN - (z.next_radius - Math.min(12, 0.4 * z.next_radius)));
    const tEnd = z.shrink_end - t;
    this.zonePull = z.next_radius < z.radius - 0.5 && (needDist / walk + 14 > tEnd - 0 || t > z.shrink_start - 8);
    // late phases: always live inside the next circle
    if (z.radius <= 150) this.zonePull = true;
    const edge = z.radius - dC;
    const zoneUrgent = !me.in_zone || edge < 6 || (this.zonePull && needDist / walk + 5 > tEnd && needDist > 0);

    // --- threats ---
    const mechsNow = [];
    for (const e of this.en.values()) {
      e.dist = hyp(e.pos[0] - X, e.pos[1] - Y);
      e.fresh = t - e.seenT < 0.15;
      e.los = e.fresh && this.canHit(e);
      const toMe = Math.atan2(Y - e.pos[1], X - e.pos[0]);
      e.aimingAtMe = Math.abs(wrap(e.aim[0] - toMe)) < 0.25;
      if (e.fresh) mechsNow.push(e);
    }
    const recent = [...this.en.values()].filter((e) => t - e.seenT < 6);
    const losThreats = mechsNow.filter((e) => e.los && e.dist < 290);
    const attackers = losThreats.filter((e) => (e.hitMeT && t - e.hitMeT < 3) || (e.aimingAtMe && e.dist < 240));
    const underFire = t - this.lastDmgT < 2.5;

    // --- pick a shooting target ---
    const gun = me.weapons[0] && me.weapons[0].kind === "gun" ? me.weapons[0] : null;
    const w1 = me.weapons[1];
    const laser = w1 && w1.kind === "laser" ? w1 : null, light = w1 && w1.kind === "lightning" ? w1 : null, mortar = w1 && w1.kind === "mortar" ? w1 : null;
    const maxRange = Math.max(gun ? gun.stats.range * 0.96 : 0, laser ? laser.stats.range * 0.96 : 0, 60);
    const dmgMul = 1 + cfg.cubes.damage_per_cube * Math.min(me.cubes, cfg.cubes.stat_cap);
    const myDps = (gun ? gun.stats.damage / gun.stats.cooldown * 0.6 : 0) * dmgMul + (laser ? 120 : 0) + 1;
    let target = null, bestS = 1e9;
    for (const e of losThreats) {
      if (e.dist > maxRange) continue;
      const hostile = (e.hitMeT && t - e.hitMeT < 6) || e.aimingAtMe;
      if (this.ffa && !hostile && e.dist > P.ffaEngage && e.hp > 0.5 * e.max_hp) continue;
      let s = (e.hp ?? 1400) / myDps + e.dist / 50 - (hostile ? 2 : 0) - (e.id === this.tgtId ? 1.5 : 0);
      if (s < bestS) { bestS = s; target = e; }
    }
    this.tgtId = target ? target.id : null;
    let npcFoe = null;
    if (!target) for (const n of this.npcs.values()) {
      if (t - n.seenT > 0.3 || !(n.hitMeT && t - n.hitMeT < 4)) continue;
      const d = hyp(n.pos[0] - X, n.pos[1] - Y);
      if (d < 120 && this.canHit(n) && (!npcFoe || d < npcFoe.d)) npcFoe = { ...n, d, kind: "npc" };
    }
    const inCombat = !!target || attackers.length > 0 || (underFire && recent.length > 0);

    // --- retreat decision ---
    const nAtk = Math.max(1, attackers.length);
    const thr = P.retreatHp + P.outnumberStep * (nAtk - 1);
    const killable = target && target.hp != null && target.hp < 0.6 * me.hp && target.hp < 420 && nAtk <= 2;
    const lastRing = z.radius <= 30;
    const foeHp = target ? (target.hp ?? 1400) : 0;
    const evenDuel = target && nAtk <= 1 && me.hp > 0.75 * foeHp && target.dist > 25;
    if (!this.retreating && hpF < thr && !killable && !lastRing && !evenDuel) this.retreating = true;
    if (this.retreating && evenDuel && hpF > 0.2 && t - this.lastDmgT < 1.5) this.retreating = false; // being chased: turn and fight
    if (this.retreating && (hpF > P.returnHp || lastRing || (killable && hpF > 0.25))) this.retreating = false;
    if (this.retreating && !inCombat && recent.every((e) => t - e.seenT > 5) && hpF > 0.7) this.retreating = false;

    // --- movement ---
    let mv = [0, 0], boost = false, jump = false, label = "idle";
    let farmTgt = null; // non-mech thing to shoot
    const threatsForCover = recent.filter((e) => t - e.seenT < 4).sort((a, b) => a.dist - b.dist);

    const dodge = (ref, want) => {
      // strafe around ref keeping `want` distance
      if (t > this.strafeT) { this.strafe = this.rnd() < 0.5 ? -1 : 1; if (this.rnd() < 0.7) this.strafe = -this.lastStrafe || this.strafe; this.lastStrafe = this.strafe; this.strafeT = t + P.strafeMin + this.rnd() * (P.strafeMax - P.strafeMin); }
      const dx = ref.pos[0] - X, dy = ref.pos[1] - Y, d = hyp(dx, dy) || 1, ux = dx / d, uy = dy / d;
      const rad = clamp((d - want) / 25, -1, 1) * 0.75;
      const tryDir = (sgn) => {
        let vx = -uy * sgn + ux * rad, vy = ux * sgn + uy * rad; const n = hyp(vx, vy) || 1; vx /= n; vy /= n;
        let ok = m.walkable(X + vx * 4, Y + vy * 4) && m.walkable(X + vx * 8, Y + vy * 8) && this.okPos(X + vx * 8, Y + vy * 8);
        if (ok && ref.kind !== "npc") for (const n of this.npcs.values()) { const d0 = hyp(n.pos[0] - X, n.pos[1] - Y), d1 = hyp(n.pos[0] - X - vx * 8, n.pos[1] - Y - vy * 8); if (d1 < 50 && d1 < d0) { ok = false; break; } }
        return ok ? [vx, vy] : null;
      };
      let v = tryDir(this.strafe);
      if (!v) { this.strafe = -this.strafe; this.lastStrafe = this.strafe; v = tryDir(this.strafe); }
      if (!v) { const zc = z.next_center; const a = Math.atan2(zc[1] - Y, zc[0] - X); v = [Math.cos(a), Math.sin(a)]; }
      return v;
    };

    if (zoneUrgent) {
      // head into the next circle, somewhere not dead centre unless tiny
      const a = Math.atan2(Y - z.next_center[1], X - z.next_center[0]);
      const r = Math.max(0, z.next_radius * 0.55 - 6);
      const nv = this.navTo(z.next_center[0] + Math.cos(a) * r, z.next_center[1] + Math.sin(a) * r, t);
      mv = [nv[0], nv[1]]; boost = me.energy > 8 && (!me.in_zone || edge < 3); label = "zone";
    } else if (this.retreating && threatsForCover.length) {
      const cov = this.findCover(threatsForCover, t);
      if (cov) {
        const nv = this.navTo(cov[0], cov[1], t);
        if (nv[2] > 2.2) { mv = [nv[0], nv[1]]; boost = me.energy > 15 && losThreats.length > 0; label = "cover"; }
        else if (target) { mv = dodge(target, 150); this.coverT = -9; label = "cornered"; }
        else { mv = [0, 0]; label = "heal"; }
      } else {
        // no cover: run from the nearest threat, dodging
        const e = threatsForCover[0]; mv = dodge(e, 400); boost = me.energy > 30; label = "flee";
      }
    } else if (target) {
      let want = P.wantRange;
      if (target.weapons && target.weapons.includes("lightning")) want = Math.max(want, 80);
      if (light && !laser) want = Math.min(want, 34);
      if (laser && !(target.weapons && target.weapons.includes("lightning"))) want = Math.max(want, P.laserRange);
      if (this.shots > 14 && this.hits / this.shots < 0.3) want = Math.min(want, 70);
      if (z.radius < 80) want = Math.min(want, z.radius * 0.9);
      mv = dodge(target, want); label = "fight " + target.id;
    } else if (npcFoe && hpF > 0.3) {
      farmTgt = npcFoe; mv = dodge(npcFoe, 70); label = "npc fight";
    } else {
      // --- no target: loot / farm / position ---
      const hot = recent.filter((e) => t - e.seenT < 5 && e.dist < 160);
      const quiet = hot.length === 0 && !underFire;
      let best = null, bs = 1e9;
      const consider = (kind, o, w, extra = 0) => {
        if (!this.okPos(o.pos[0], o.pos[1])) return;
        if (m.solid[m.cellOf(o.pos[0], o.pos[1])] || o.pos[2] > m.groundAt(o.pos[0], o.pos[1]) + 4) return; // on a roof
        const d = hyp(o.pos[0] - X, o.pos[1] - Y);
        if (this.ffa) for (const e of recent) if (hyp(e.pos[0] - o.pos[0], e.pos[1] - o.pos[1]) < 90) return;
        const s = d * w + extra; if (s < bs) { bs = s; best = { kind, o, d }; }
      };
      for (const c of this.cubes.values()) consider("cube", c, 0.6);
      const haveRank = w1 ? WRANK[w1.kind] ?? 0 : -1;
      const PW = { laser: 0.35, lightning: 0.9, mortar: 1.3 };
      for (const p of this.pickups.values()) if ((WRANK[p.kind] ?? 0) > haveRank && p.kind !== "gun") consider("pickup", p, (PW[p.kind] ?? 1.2) * (w1 ? 1.3 : 1));
      for (const d of obs.drops || []) if (d.lands_in < 12) consider("drop", d, 0.7, d.holder != null && d.holder !== me.id ? 80 : 0);
      if (quiet && hpF > P.farmHp) {
        for (const c of this.crates.values()) consider("crate", c, 1.3 * P.farmBias, 15 * P.farmBias);
        if (hpF > P.npcFarmHp) for (const n of this.npcs.values()) if (t - n.seenT < 40) consider("npc", n, 1.4 * P.farmBias, 30 * P.farmBias);
      }
      if (!quiet && best && best.d > 45 && hpF < 0.8) best = null;
      if (best && bs < 420) {
        const o = best.o;
        if (best.kind === "crate" || best.kind === "npc") {
          const rng = best.kind === "crate" ? P.crateRange : P.npcRange;
          const vis = best.d < rng && m.los(X, Y, Z + this.muzzleH, o.pos[0], o.pos[1], this.centerZ({ ...o, kind: best.kind }));
          if (vis) { farmTgt = { ...o, kind: best.kind, vel: o.vel || [0, 0, 0] }; if (best.kind === "npc") mv = dodge(o, 65); else if (best.d > 30) { const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]]; } }
          else { const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]]; }
          label = "farm " + best.kind;
        } else {
          const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]];
          if (best.kind === "drop" && best.d < 4) mv = [0, 0];
          if (best.kind === "pickup" && best.d < 3.6) { act.take = o.id; if (w1) act.drop = 1; }
          boost = best.kind !== "drop" && best.d > 25 && me.energy > 60 && quiet;
          label = "get " + best.kind;
        }
      } else if (this.retreating || (hot.length && hpF < 0.8)) {
        // stay hidden and heal
        const cov = threatsForCover.length ? this.findCover(threatsForCover, t) : null;
        if (cov) { const nv = this.navTo(cov[0], cov[1], t); if (nv[2] > 2.2) mv = [nv[0], nv[1]]; }
        label = "hide";
      } else {
        // drift to a waiting spot inside the next circle on our side
        const a = Math.atan2(Y - z.next_center[1], X - z.next_center[0]);
        const r = Math.max(0, Math.min(z.next_radius * 0.6, z.next_radius - 20));
        const gx = z.next_center[0] + Math.cos(a) * r, gy = z.next_center[1] + Math.sin(a) * r;
        if (hyp(gx - X, gy - Y) > 14 && (dN > z.next_radius - 15 || this.zonePull)) { const nv = this.navTo(gx, gy, t); mv = [nv[0] * 0.42, nv[1] * 0.42]; if (this.zonePull) mv = [nv[0], nv[1]]; label = "drift"; }
        else label = "wait";
      }
    }
    // pick up weapons we walk past, even mid-fight
    if (act.take == null) for (const p of obs.pickups || []) {
      const haveRank = w1 ? WRANK[w1.kind] ?? 0 : -1;
      if ((WRANK[p.kind] ?? 0) > haveRank && hyp(p.pos[0] - X, p.pos[1] - Y) < 3.7 && Math.abs(p.pos[2] - Z) < 3.8 && !(laser && laser.charge > 0)) { act.take = p.id; if (w1) act.drop = 1; break; }
    }

    // --- incoming mortar shells ---
    const g = cfg.weapons.mortar.gravity;
    for (const pr of obs.projectiles || []) {
      if (pr.kind !== "mortar") continue;
      let px = pr.pos[0], py = pr.pos[1], pz = pr.pos[2], vz = pr.vel[2];
      for (let k = 0; k < 140; k++) { px += pr.vel[0] * 0.05; py += pr.vel[1] * 0.05; vz -= g * 0.05; pz += vz * 0.05; if (pz <= m.top[m.cellOf(px, py)]) break; }
      const d = hyp(px - X, py - Y);
      if (d < cfg.weapons.mortar.splash_radius * 1.3 + 5) {
        let ax = X - px, ay = Y - py; const n = hyp(ax, ay);
        if (n < 1) { ax = -pr.vel[1]; ay = pr.vel[0]; }
        const nn = hyp(ax, ay) || 1; ax /= nn; ay /= nn;
        if (m.walkable(X + ax * 5, Y + ay * 5)) { mv = [ax, ay]; boost = me.energy > 5; label = "shell"; }
      }
    }

    // --- bullet dodging: pick the move whose next 0.6 s path the visible bullets miss ---
    if (P.dodge && label !== "shell") {
      const R = 2.5 * this.scale + 0.45, H = 9 * this.scale, acc = me.stats.ground_accel ?? 58.5;
      const bl = [];
      for (const pr of obs.projectiles || []) {
        if (pr.kind !== "gun" && pr.kind !== "npc") continue;
        const rx = X - pr.pos[0], ry = Y - pr.pos[1], vv = pr.vel[0] * pr.vel[0] + pr.vel[1] * pr.vel[1];
        if (vv < 1) continue;
        const tc = (rx * pr.vel[0] + ry * pr.vel[1]) / vv; // time of closest approach to where we are
        if (tc < -0.05 || tc > 0.9) continue;
        if (Math.abs(rx * pr.vel[1] - ry * pr.vel[0]) / Math.sqrt(vv) > 14) continue;
        bl.push(pr);
      }
      if (bl.length) {
        const spd = (boost && me.energy > 5 ? me.stats.boost_speed : me.stats.walk_speed);
        const risk = (dx, dy, bst) => {
          const sp = bst ? me.stats.boost_speed : me.stats.walk_speed;
          let vx = me.vel[0], vy = me.vel[1], px = X, py = Y, r = 0;
          const tvx = dx * sp, tvy = dy * sp, st = 0.04;
          const hitT = new Array(bl.length).fill(false);
          for (let k = 1; k <= 18; k++) {
            let ax = tvx - vx, ay = tvy - vy; const al = Math.hypot(ax, ay), mx = acc * st; if (al > mx) { ax *= mx / al; ay *= mx / al; }
            vx += ax; vy += ay; px += vx * st; py += vy * st;
            const tt = k * st;
            for (let b = 0; b < bl.length; b++) {
              if (hitT[b]) continue; const pr = bl[b];
              const bx = pr.pos[0] + pr.vel[0] * tt, by = pr.pos[1] + pr.vel[1] * tt, bz = pr.pos[2] + pr.vel[2] * tt;
              // segment of bullet travel over this step vs our cylinder
              const sx = pr.vel[0] * st, sy = pr.vel[1] * st;
              const qx = px - bx, qy = py - by, ss = sx * sx + sy * sy;
              let u = ss > 0 ? (qx * -sx + qy * -sy) / ss : 0; u = clamp(u, 0, 1);
              const cx = bx - sx * u, cy = by - sy * u;
              if (Math.hypot(px - cx, py - cy) < R && bz > Z - 0.5 && bz < Z + H + 0.5 && !m.solid[m.cellOf(cx, cy)]) { hitT[b] = true; r += pr.kind === "gun" ? 1 : 0.5; }
            }
          }
          return r;
        };
        const wl = Math.hypot(mv[0], mv[1]);
        const base = risk(wl > 0.01 ? mv[0] / wl : 0, wl > 0.01 ? mv[1] / wl : 0, boost);
        if (base > 0) {
          let best = null, bs = base * 10;
          const pref = wl > 0.01 ? Math.atan2(mv[1], mv[0]) : null;
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * TAU, dx = Math.cos(a), dy = Math.sin(a);
            if (!m.walkable(X + dx * 4, Y + dy * 4) || !this.okPos(X + dx * 5, Y + dy * 5)) continue;
            for (const bst of [false, me.energy > 10]) {
              const r = risk(dx, dy, bst);
              const sc = r * 10 + (pref == null ? 0 : (1 - Math.cos(a - pref)) * 0.8) + (bst ? 0.1 : 0);
              if (sc < bs) { bs = sc; best = [dx, dy, bst]; }
            }
          }
          if (best) { mv = [best[0], best[1]]; boost = best[2]; label += "+dodge"; }
        }
      }
    }

    // --- stuck recovery ---
    this.hist.push([t, X, Y]); while (this.hist.length > 12) this.hist.shift();
    const wantMove = hyp(mv[0], mv[1]) > 0.3;
    if (wantMove && this.hist.length >= 12 && t > this.stuckT + 1.5) {
      const h0 = this.hist[0];
      if (hyp(X - h0[1], Y - h0[2]) < 1.2 && !(laser && laser.charge > 0)) { this.stuckT = t; this.unstuckDir = (this.rnd() < 0.5 ? -1 : 1) * (0.6 + this.rnd()); this.path = null; }
    }
    if (t - this.stuckT < 0.7 && wantMove) {
      const a = Math.atan2(mv[1], mv[0]) + this.unstuckDir; mv = [Math.cos(a), Math.sin(a)]; jump = me.grounded; boost = me.energy > 10; label = "unstick";
    }
    // off the nav mesh (roof / pit): head for the nearest open cell
    if (!m.comp[m.cellOf(X, Y)] && wantMove) {
      const c = m.nearestOpen(X, Y); const dx = m.cx(c) - X, dy = m.cy(c) - Y, d = hyp(dx, dy);
      if (d > 0.5 && Z > m.ground[c] + 2.5) mv = [dx / d, dy / d];
    }

    // --- aim & fire ---
    const fire = [false, false];
    let aim = null;
    const shootAt = target || farmTgt;
    const ahead = 0.05;
    if (shootAt) {
      const isMech = shootAt === target;
      const L = gun ? this.lead(shootAt, gun.stats.speed, ahead) : this.lead(shootAt, 1e9, ahead);
      const D = this.lead(shootAt, 1e9, 0.1);
      const rad = (isMech ? 2.5 * (1 + 0.05 * (shootAt.cubes || 0)) : shootAt.kind === "npc" ? 1.8 : 1.4);
      const slack = me.stats.turn_rate * 0.05;
      aim = [L.yaw, L.pitch];
      const gunReady = gun && gun.reload <= 0 && gun.ammo > 0;
      // laser: charge while tracking, release on a direct line
      if (laser) {
        const st = laser.stats, inR = D.dist < st.range * 0.96;
        const ch = laser.charge || 0;
        if (inR && laser.cooldown <= 0.12) {
          const need = (shootAt.hp ?? 9999) < st.damage * dmgMul * st.min_frac ? st.min_charge : st.charge;
          if (ch >= need - 0.11) aim = [D.yaw, D.pitch];
          const ey = Math.abs(wrap(me.aim[0] - D.yaw)), epi = Math.abs(me.aim[1] - D.pitch);
          const tolY = Math.atan2(rad * 0.75, D.dist), tolP = Math.atan2(3.2, D.dist);
          if (ch >= need && ey < tolY + slack * 0.5 && epi < tolP + 0.05) fire[1] = false; // release
          else fire[1] = true;
        } else if (ch > 0) fire[1] = false;
      }
      if (gunReady && L.dist + 0 < gun.stats.range * 0.97) {
        const ey = Math.abs(wrap(me.aim[0] - L.yaw)), epi = Math.abs(me.aim[1] - L.pitch);
        const tolY = Math.atan2(rad * (isMech ? 1.0 : 0.8), L.dist), tolP = Math.atan2(isMech ? 4 : 1.2, L.dist);
        if (ey < tolY + slack && epi < tolP + 0.04) { fire[0] = true; if (isMech) this.shots += this.dt / gun.stats.cooldown; }
      }
      if (light && isMech && D.dist < light.stats.range * 0.97 && Math.abs(wrap(me.aim[0] - D.yaw)) < (light.stats.cone_deg * Math.PI / 180) * 0.85 && me.energy > 8) fire[1] = true;
      if (mortar && isMech && !gunReady && D.dist > 22 && D.dist < 190 && mortar.cooldown <= 0.15) {
        const v = mortar.stats.speed; let tt = D.dist / (v * 0.9), sol = null;
        for (let k = 0; k < 3; k++) {
          const px = shootAt.pos[0] + shootAt.vel[0] * tt * 0.7, py = shootAt.pos[1] + shootAt.vel[1] * tt * 0.7;
          const d = hyp(px - X, py - Y), h = shootAt.pos[2] + 1 - (Z + 9.5 * this.scale);
          const disc = v ** 4 - g * (g * d * d + 2 * h * v * v);
          if (disc < 0) { sol = null; break; }
          const th = Math.atan2(v * v - Math.sqrt(disc), g * d);
          tt = d / (v * Math.cos(th)); sol = [Math.atan2(py - Y, px - X), th];
        }
        if (sol) { aim = sol; if (Math.abs(wrap(me.aim[0] - sol[0])) < 0.05 && Math.abs(me.aim[1] - sol[1]) < 0.04) fire[1] = true; }
      }
    } else {
      if (laser && (laser.charge || 0) > 0) fire[1] = false;
      // look: at whoever hurt us, at last known enemy, at a sound, else sweep along travel
      const lastE = recent.filter((e) => t - e.seenT < 6).sort((a, b) => a.dist - b.dist)[0];
      if (t - this.lastDmgT < 2 && this.lastDmgBearing != null && !(lastE && lastE.fresh)) aim = [this.lastDmgBearing, 0];
      else if (lastE) aim = [Math.atan2(lastE.pos[1] - Y, lastE.pos[0] - X), clamp(Math.atan2(this.centerZ(lastE) - Z - 7, lastE.dist || 1), -0.5, 0.8)];
      else if (t - this.soundT < 1.5 && this.soundYaw != null) aim = [this.soundYaw, 0];
      else {
        const base = wantMove ? Math.atan2(mv[1], mv[0]) : (this.scanBase ?? me.aim[0]);
        if (wantMove) { this.scanBase = base; aim = [base + 1.15 * Math.sin(t * 1.3), 0]; }
        else aim = [wrap(me.aim[0] + 1.6 * this.dt * 6), 0]; // slow 360 scan while standing
      }
    }
    // reload when it is free to do so
    if (gun && gun.reload <= 0 && gun.ammo < gun.stats.mag) {
      if (gun.ammo === 0 || (!shootAt && gun.ammo <= gun.stats.mag - 3 && losThreats.length === 0)) act.reload = true;
    }
    // --- upgrades ---
    if (obs.offer) {
      let bi = 0, br = 1e9;
      obs.offer.choices.forEach((c, i) => { let r = UPG.indexOf(c.id); if (r < 0) r = 50; if (r < br) { br = r; bi = i; } });
      act.pick = bi;
    }
    act.move = [Math.round(mv[0] * 1000) / 1000, Math.round(mv[1] * 1000) / 1000];
    act.boost = !!boost && wantMove; act.jump = !!jump;
    if (aim) act.aim = [Math.round(wrap(aim[0]) * 10000) / 10000, Math.round(clamp(aim[1], me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3) * 10000) / 10000];
    act.fire = fire;
    this.label = label;
    return act;
  }
}
