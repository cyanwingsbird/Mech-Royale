// Mech Royale bot: ranged duelist that fights from health, heals behind cover, farms cubes when clear.
import { CS } from "./map.mjs";

const TAU = Math.PI * 2;
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hyp = Math.hypot;

export const PARAMS = {
  wantRange: 130, // preferred gun duel distance
  retreatHp: 0.32, // go to cover below this
  returnHp: 0.85, // come back above this
  outnumberStep: 0.14, // extra retreat threshold per additional attacker
  strafeMin: 0.35, strafeMax: 0.95,
  crateRange: 70, npcRange: 85,
  farmHp: 0.5,
  npcFarmHp: 0.6,
  farmBias: 1.0,
  velBlend: 0.2, // lead on blend of instantaneous and smoothed velocity
  ffaEngage: 200,
  dodge: 1,
  explore: 1,
  pickyEngage: 0,
  coverStrafe: 0,
  dropW: 0.7, dropLead: 12,
  lightClose: 1,
  unstickBoost: 1,
  eagerReload: 0,
  seek: 0, seekHp: 0.8,
  laserTiming: 0, laserVlat: 4, laserWait: 1.2,
  laserHold: 0,
  kite: 0,
  headAim: 0, duck: 0,
  dual: 0, // carry laser + lightning (drops the gun)
  grabR: 120, grabLight: 0, grabRetreat: 0, spin0: 1.7, laserDodge: 0, ldStart: 0.4, pwL: 0.35, pwE: 0.9, noLight: 0, boostStrafe: 0, bsR: 120, bsE: 40, aimSlack: 0.05, leadMul: 1, ahead: 0.05, spinForce: 0, polite: 0, politeR: 0, esc: 0, offSkip: 0, offRoof: 0, peri: 0, periH: 28, periE: 70, periEvery: 9, periUntil: 90, escGate: 0, offRush: 0, scout: 0, scoutT: 60, scoutE: 30, scoutFightR: 0, grabRoof: 0, npcLaserR: 0, npcLaserW: 1, climb2: 0, rushR: 0, boostLaser: 0, kb: 0, kbBoost: 140, evade: 0, evadeAfter: 0, evadeNoLaser: 0, npcW: 1, quietR: 160, laserTgt: 0, crateNoLaser: 1, threatW: 0, noMortar: 1, rseed: 0, roof: 0, roofAlways: 0, roofMinH: 8, roofMaxH: 38, roofLaserR: 70,
  laserRange: 200,
  camp: 0, // hold a defensive spot while the match looks like a squad hunt (no unexplained deaths)
  campLootR: 45, campLaserR: 110, campFightLeash: 12,
  climb: 0, // jet up onto roofs for lasers (off: roof items are rarely visible from the street)
};
Object.assign(PARAMS, {"explore":1,"scout":1,"grabR":400,"rushR":400,"boostLaser":1,"esc":1,"offSkip":1,"escGate":1,"offRush":140,"laserHold":1});

const UPG = ["laser_damage", "plating", "laser_charge", "lightning_range", "lightning_efficiency", "armor", "gun_damage", "nanites", "gun_rate", "servos", "gun_mag", "gun_velocity",
  "reactor", "capacitor", "gyros", "lightning_chain", "jets", "mortar_reload", "sensors"];
const WRANK = { laser: 3, lightning: 2, mortar: 1, gun: 0 };

export class Bot {
  constructor(hello, map, params = {}) {
    this.name = "kestrel";
    this.cfg = hello.config; this.map = map; this.id = hello.slot;
    this.P = { ...PARAMS, ...params };
    if ((this.P.esc || this.P.offRush) && map && !map.exitNext) { map.computeExit(); for (let k = 0; k < 6; k++) map.fieldTo(40 * k - 100, 30 * k - 90, 150); }
    let s = (((hello.seed >>> 0) || 12345) ^ (this.P.rseed | 0)) >>> 0 || 1;
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
  centerZ(o) {
    if (o.kind === "mech" && o.aimZoff != null) return o.pos[2] + o.aimZoff;
    return o.pos[2] + (o.kind === "npc" ? 1.75 : o.kind === "crate" ? 1.2 : 4.5 * (1 + 0.05 * (o.cubes || 0)));
  }
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
  canHit(o) {
    const me = this.me, mz = me.pos[2] + this.muzzleH;
    if (o.kind !== "mech") return this.map.los(me.pos[0], me.pos[1], mz, o.pos[0], o.pos[1], this.centerZ(o));
    // try the body centre, then the upper torso and head (a mech on a roof often shows only its top)
    const sc = 1 + 0.05 * (o.cubes || 0);
    for (const dz of (this.P.headAim ? [4.5 * sc, 7 * sc, 8.3 * sc] : [4.5 * sc])) {
      if (this.map.los(me.pos[0], me.pos[1], mz, o.pos[0], o.pos[1], o.pos[2] + dz)) { o.aimZoff = dz; return true; }
    }
    o.aimZoff = null; return false;
  }

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

  // a defensive spot near (x,y): beside walls, open to a few directions only, inside the safe circle
  findCamp(x, y, t) {
    const m = this.map, z = this.z;
    const c0 = m.nearestOpen(x, y), i0 = c0 % m.nx, j0 = (c0 / m.nx) | 0;
    const R = 30; let best = null, bs = -1e9;
    const zc = this.zonePull || z.radius > z.next_radius + 1 ? z.next_center : z.center;
    const zr = this.zonePull || z.radius > z.next_radius + 1 ? z.next_radius : z.radius;
    for (let dj = -R; dj <= R; dj += 2) for (let di = -R; di <= R; di += 2) {
      const i = i0 + di, j = j0 + dj; if (i < 1 || j < 1 || i >= m.nx - 1 || j >= m.ny - 1) continue;
      const c = j * m.nx + i; if (!m.comp[c] || m.nearWall[c] > 2) continue;
      const cx = m.cx(c), cy = m.cy(c);
      const dz = hyp(cx - zc[0], cy - zc[1]); if (dz > zr * 0.75 - 8) continue;
      // how many of 16 directions are blocked within 14 m (walls behind us)
      const g = m.ground[c] + 6;
      let blocked = 0, farOpen = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU, ex = cx + Math.cos(a) * 14, ey = cy + Math.sin(a) * 14;
        if (!m.los(cx, cy, g, ex, ey, g)) blocked++;
        else if (m.los(cx, cy, g, cx + Math.cos(a) * 70, cy + Math.sin(a) * 70, g)) farOpen++;
      }
      if (blocked < 4 || farOpen < 2) continue;
      const d = hyp(cx - x, cy - y);
      const sc = Math.min(blocked, 10) * 1.0 + Math.min(farOpen, 5) * 0.6 - d * 0.06 - dz / zr * 2;
      if (sc > bs) { bs = sc; best = [cx, cy]; }
    }
    return best;
  }

  // ---------- rooftops ----------
  computeRoofs() {
    const m = this.map, nx = m.nx, N = m.N, P = this.P;
    const key = P.roofMinH + "/" + P.roofMaxH;
    if (m._roofs && m._roofs.key === key) { ({ lab: this.roofLab, dist: this.roofDist, good: this.roofs } = m._roofs); return; }
    const lab = new Int32Array(N).fill(-1); const roofs = [];
    for (let c = 0; c < N; c++) {
      if (!m.solid[c] || lab[c] !== -1) continue;
      const top = m.top[c], h = top - m.terrainAt(m.cx(c), m.cy(c));
      if (h < P.roofMinH || h > P.roofMaxH) { lab[c] = -2; continue; }
      const id = roofs.length, cells = [], st = [c]; lab[c] = id;
      while (st.length) {
        const k = st.pop(); cells.push(k); const i = k % nx;
        for (const n of [k - 1, k + 1, k - nx, k + nx]) {
          if (n < 0 || n >= N || (n === k - 1 && i === 0) || (n === k + 1 && i === nx - 1)) continue;
          if (lab[n] !== -1 || !m.solid[n] || Math.abs(m.top[n] - top) > 0.7) continue;
          lab[n] = id; st.push(n);
        }
      }
      roofs.push({ id, cells, top });
    }
    // distance from the roof edge (cells) by multi-source BFS inside each roof
    const dist = new Int16Array(N).fill(-1); const q = [];
    for (const r of roofs) for (const k of r.cells) {
      const i = k % nx; let edge = false;
      for (const n of [k - 1, k + 1, k - nx, k + nx]) if (n < 0 || n >= N || (n === k - 1 && i === 0) || (n === k + 1 && i === nx - 1) || lab[n] !== r.id) { edge = true; break; }
      if (edge) { dist[k] = 0; q.push(k); }
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h], i = k % nx;
      for (const n of [k - 1, k + 1, k - nx, k + nx]) { if (n < 0 || n >= N || (n === k - 1 && i === 0) || (n === k + 1 && i === nx - 1)) continue; if (lab[n] !== lab[k] || dist[n] !== -1) continue; dist[n] = dist[k] + 1; q.push(n); }
    }
    const good = [];
    for (const r of roofs) {
      let best = -1, bd = -1;
      for (const k of r.cells) if (dist[k] > bd) { bd = dist[k]; best = k; }
      if (bd < 3) continue;
      r.center = [m.cx(best), m.cy(best)]; r.depth = bd;
      r.edges = r.cells.filter((k) => dist[k] === 0);
      good.push(r);
    }
    this.roofLab = lab; this.roofDist = dist; this.roofs = good;
    m._roofs = { key, lab, dist, good };
  }
  roofAt(x, y, z) {
    if (!this.roofs) return null;
    const c = this.map.cellOf(x, y), id = this.roofLab[c];
    if (id < 0) return null;
    const r = this.roofs.find((q) => q.id === id);
    return r && z > r.top - 1.5 ? r : null;
  }
  roofOK(r, t) {
    const z = this.z;
    if (this.roofBan && this.roofBan.get(r.id) > t) return false;
    const [x, y] = r.center;
    if (hyp(x - z.center[0], y - z.center[1]) > z.radius - 20) return false;
    if (hyp(x - z.next_center[0], y - z.next_center[1]) > z.next_radius * 0.85 - 10) return false;
    return true;
  }
  pickRoof(t) {
    if (!this.roofs) this.computeRoofs();
    if (this.roof && this.roofOK(this.roof, t) && t - this.roofPickT < 20) return this.roof;
    if (this.roof && this.roofOK(this.roof, t)) { this.roofPickT = t; return this.roof; }
    const me = this.me; let best = null, bs = 1e9;
    for (const r of this.roofs) {
      if (!this.roofOK(r, t)) continue;
      const d = hyp(r.center[0] - me.pos[0], r.center[1] - me.pos[1]);
      if (d > 320) continue;
      const sc = d + (r.top - this.map.terrainAt(r.center[0], r.center[1])) * 1.5 - Math.min(r.depth, 8) * 3;
      if (sc < bs) { bs = sc; best = r; }
    }
    if (best !== this.roof) { this.roof = best; this.roofClimbT = null; this.roofApproach = null; }
    this.roofPickT = t;
    return best;
  }
  roofApproachFor(r) {
    // open ground cell hugging the roof's wall, cheap to reach from here
    const m = this.map, me = this.me, nx = m.nx; let best = null, bs = 1e9;
    for (const k of r.edges) {
      const de = hyp(m.cx(k) - me.pos[0], m.cy(k) - me.pos[1]); if (de > bs) continue;
      const i0 = k % nx, j0 = (k / nx) | 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= m.ny) continue;
        const c = j * nx + i; if (!m.comp[c] || m.solid[c]) continue;
        const sc = hyp(m.cx(c) - me.pos[0], m.cy(c) - me.pos[1]) + 6 * hyp(di, dj);
        if (sc < bs) { bs = sc; best = { x: m.cx(c), y: m.cy(c), ex: m.cx(k), ey: m.cy(k) }; }
      }
    }
    return best;
  }
  climbStep(rf, gx, gy, t) {
    const me = this.me, X = me.pos[0], Y = me.pos[1], Z = me.pos[2], m = this.map;
    if (!this.cl || this.cl.id !== rf.id) this.cl = { id: rf.id, ap: this.roofApproachFor(rf), t0: null };
    const st = this.cl, ap = st.ap; if (!ap) { (this.climbBan ??= new Set()).add(rf.id); return null; }
    const h = rf.top - Z;
    if (Z > rf.top - 1.5 && this.roofLab[m.cellOf(X, Y)] === rf.id) { const dd = hyp(gx - X, gy - Y) || 1; return { mv: [(gx - X) / dd, (gy - Y) / dd], jump: false, boost: false, label: "C:walk" }; }
    const dAp = hyp(ap.x - X, ap.y - Y), dEdge = hyp(ap.ex - X, ap.ey - Y);
    if (dAp < 3 || dEdge < 5 || (st.t0 != null && t - st.t0 < 9)) {
      if (st.t0 == null) st.t0 = t;
      if (t - st.t0 > 8) { (this.climbBan ??= new Set()).add(rf.id); this.cl = null; return null; }
      const need = Math.min(100, 1.7 * Math.max(0, h) + 12);
      if (me.grounded && me.energy < need && h > 2) { st.t0 = t; return { mv: [0, 0], jump: false, boost: false, label: "C:charge" }; }
      const tx = Z > rf.top + 0.5 ? gx : ap.ex, ty = Z > rf.top + 0.5 ? gy : ap.ey;
      const dd = hyp(tx - X, ty - Y) || 1; const out = { mv: [(tx - X) / dd, (ty - Y) / dd], jump: false, boost: false, label: "C:climb" };
      if (h > -1.5) { if (me.grounded) out.jump = true; else out.boost = me.energy > 1; }
      return out;
    }
    st.t0 = null;
    const nv = this.navTo(ap.x, ap.y, t); return { mv: [nv[0], nv[1]], jump: false, boost: me.energy > 40, label: "C:to" };
  }
  onRoofCell(r, x, y, minDepth = 1) {
    const c = this.map.cellOf(x, y);
    return this.roofLab[c] === r.id && this.roofDist[c] >= minDepth;
  }

  // where to look for a fight: nearest enemy seen in the last 40 s, else the last near/mid gunshot
  scoutMark(me) {
    const m = this.map, b = m.bounds, C = 20;
    if (!this.sg) { this.sgW = Math.ceil((b.maxX - b.minX) / C); this.sgH = Math.ceil((b.maxY - b.minY) / C); this.sg = new Uint8Array(this.sgW * this.sgH); }
    const X = me.pos[0], Y = me.pos[1], ay = me.aim[0], R = 160, cx0 = Math.floor((X - b.minX) / C), cy0 = Math.floor((Y - b.minY) / C), rr = Math.ceil(R / C);
    for (let j = Math.max(0, cy0 - rr); j <= Math.min(this.sgH - 1, cy0 + rr); j++) for (let i = Math.max(0, cx0 - rr); i <= Math.min(this.sgW - 1, cx0 + rr); i++) {
      const k = j * this.sgW + i; if (this.sg[k]) continue;
      const px = b.minX + (i + 0.5) * C - X, py = b.minY + (j + 0.5) * C - Y, d = hyp(px, py);
      if (d < 45 || (d < R && Math.abs(wrap(Math.atan2(py, px) - ay)) < 0.95)) this.sg[k] = 1;
    }
  }
  scoutGoal(t, X, Y) {
    if (this.scoutTo && t < this.scoutUntil && hyp(this.scoutTo[0] - X, this.scoutTo[1] - Y) > 12) return this.scoutTo;
    const m = this.map, b = m.bounds, C = 20, z = this.z; let best = null, bs = -1e9;
    for (let k = 0; k < 16; k++) for (const r of [70, 130]) {
      const a = (k / 16) * TAU, px = X + Math.cos(a) * r, py = Y + Math.sin(a) * r;
      if (px < b.minX + 10 || px > b.maxX - 10 || py < b.minY + 10 || py > b.maxY - 10) continue;
      if (!this.okPos(px, py) || hyp(px - z.next_center[0], py - z.next_center[1]) > z.next_radius * 0.9) continue;
      const c = m.cellOf(px, py); if (!m.comp[c]) continue;
      const ci = Math.floor((px - b.minX) / C), cj = Math.floor((py - b.minY) / C); let un = 0;
      for (let j = cj - 4; j <= cj + 4; j++) for (let i = ci - 4; i <= ci + 4; i++) { if (i < 0 || j < 0 || i >= this.sgW || j >= this.sgH) continue; if ((i - ci) ** 2 + (j - cj) ** 2 > 16) continue; if (!this.sg[j * this.sgW + i]) un++; }
      let sc = un - 0.03 * r;
      for (const e of this.en.values()) if (t - e.seenT < 8 && hyp(e.pos[0] - px, e.pos[1] - py) < 110) sc -= 25;
      if (sc > bs) { bs = sc; best = [px, py]; }
    }
    this.scoutTo = best; this.scoutUntil = t + 3; return best;
  }
  // off the walkable mesh (courtyard, stadium, pit, roof): follow the precomputed exit field, jumping and jetting over walls
  escapeStep(me, field = null) {
    const m = this.map, X = me.pos[0], Y = me.pos[1], Z = me.pos[2];
    if (!m.exitNext) m.computeExit();
    const nxt = field ? field.next : m.exitNext;
    const c0 = m.cellOf(X, Y);
    if (nxt[c0] < 0) return null;
    const chain = []; let c = c0;
    for (let k = 0; k < 3; k++) { const n = nxt[c]; if (n < 0) break; c = n; chain.push(c); if (field ? c === field.goal : m.comp[c]) break; }
    // highest obstacle on the straight line from us to a cell centre
    const lineMax = (cc) => { const tx = m.cx(cc), ty = m.cy(cc), d = hyp(tx - X, ty - Y), n = Math.max(1, Math.ceil(d / 0.25)); let h = -1e9; for (let i = 1; i <= n; i++) { const q = m.cellOf(X + (tx - X) * i / n, Y + (ty - Y) * i / n); if (q !== c0 && m.hgt[q] > h) h = m.hgt[q]; } return h; };
    let wp = chain[0], need = Math.max(m.hgt[chain[0]], lineMax(chain[0])), cm = -1e9;
    for (let k = 0; k < chain.length; k++) { cm = Math.max(cm, m.hgt[chain[k]]); if (k > 0) { const lm = lineMax(chain[k]); if (lm <= cm + 0.5) { wp = chain[k]; need = cm; } } }
    const dx = m.cx(wp) - X, dy = m.cy(wp) - Y, d = hyp(dx, dy) || 1;
    const out = { mv: [dx / d, dy / d], jump: false, boost: false, label: "E:walk" };
    const rise = need - Z;
    if (me.grounded) {
      if (rise > 1.0) {
        const reqE = Math.min(96, 1.7 * rise + 12);
        if (me.energy < reqE && rise > 2.6) { out.mv = [0, 0]; out.label = "E:charge"; } else { out.jump = true; out.label = "E:climb"; }
      }
    } else if (Z < need + 1.5) { out.boost = me.energy > 1; out.label = "E:climb"; }
    return out;
  }
  // ground spot we cannot walk to (enclosed courtyard, stadium) while we stand on the mesh
  offMesh(x, y) {
    if (!this.P.offSkip) return false;
    const m = this.map; if (m.comp[m.cellOf(x, y)]) return false;
    const me = this.me; if (!m.comp[m.cellOf(me.pos[0], me.pos[1])]) return false;
    const n = m.nearestOpen(x, y, 6); return !m.comp[n] || hyp(m.cx(n) - x, m.cy(n) - y) > 5;
  }
  seekGoal(t) {
    const me = this.me; let best = null, bd = 1e9;
    for (const e of this.en.values()) {
      if (t - e.seenT > 40) continue;
      const d = hyp(e.pos[0] - me.pos[0], e.pos[1] - me.pos[1]);
      if (d < bd && this.okPos(e.pos[0], e.pos[1])) { bd = d; best = [e.pos[0], e.pos[1]]; }
    }
    if (best) return best;
    if (this.soundYaw != null && t - this.soundT < 8) {
      const r = 90; const x = me.pos[0] + Math.cos(this.soundYaw) * r, y = me.pos[1] + Math.sin(this.soundYaw) * r;
      if (this.okPos(x, y)) return [x, y];
    }
    return null;
  }

  // an enemy that shot us in the last 2 s and that we cannot shoot back at
  snipedBy(t) {
    if (t - this.lastDmgT > 2 || this.lastDmgBy == null) return null;
    const e = this.en.get(this.lastDmgBy);
    return e && !e.los ? e : null;
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
      const tl = tt * this.P.leadMul; ax = px + vx * tl; ay = py + vy * tl; az = pz + vz * tl;
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
    if (this.P.scout) this.scoutMark(me);
    const act = { tick: obs.tick };
    const X = me.pos[0], Y = me.pos[1], Z = me.pos[2];
    const hpF = me.hp / me.max_hp;

    // --- events ---
    let killsNow = 0;
    for (const ev of obs.events || []) {
      if (ev.type === "damaged" && ev.weapon !== "zone") {
        this.lastDmgT = t; if (ev.bearing != null) this.lastDmgBearing = ev.bearing; this.lastDmgBy = ev.by;
        const e = this.en.get(ev.by); if (e) { e.hitMeT = t; e.dmgToMe = (e.dmgToMe || 0) + ev.amount; }
        if (ev.by != null && ev.by < 100 && ev.weapon !== "zone") (this.hostileIds ??= new Set()).add(ev.by);
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
      if (o.charging) { if (!(p.charging && t - (p.seenT ?? -9) < 0.35) || p.chargeT == null) p.chargeT = t; } else p.chargeT = null;
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
    this.multiThreats = recent.filter((e) => t - e.seenT < 3 && e.dist < 220).sort((a, b) => a.dist - b.dist).slice(0, 4);

    // --- pick a shooting target ---
    const slotOf = (k) => me.weapons.findIndex((w) => w && w.kind === k);
    const gS = slotOf("gun"), lS = slotOf("laser"), eS = slotOf("lightning"), mS = slotOf("mortar");
    const gun = gS >= 0 ? me.weapons[gS] : null, laser = lS >= 0 ? me.weapons[lS] : null, light = eS >= 0 ? me.weapons[eS] : null, mortar = mS >= 0 ? me.weapons[mS] : null;
    const w1 = me.weapons[1];
    // which slot a pickup of this kind should go into: null = empty slot, 0/1 = replace that slot, -1 = not wanted
    const pickSlot = (kind) => {
      if (kind === "gun" || slotOf(kind) >= 0) return -1;
      if (kind === "mortar" && P.noMortar) return -1;
      if (kind === "lightning" && P.noLight) return -1;
      if (P.dual && gun && ((kind === "lightning" && laser) || (kind === "laser" && light))) return gS; // laser + lightning, drop the gun
      if (!w1) return null;
      return (WRANK[kind] ?? 0) > (WRANK[w1.kind] ?? 0) ? 1 : -1;
    };
    const maxRange = Math.max(gun ? gun.stats.range * 0.96 : 0, laser ? laser.stats.range * 0.96 : 0, 60);
    const dmgMul = 1 + cfg.cubes.damage_per_cube * Math.min(me.cubes, cfg.cubes.stat_cap);
    const myDps = (gun ? gun.stats.damage / gun.stats.cooldown * 0.6 : 0) * dmgMul + (laser ? 120 : 0) + 1;
    let target = null, bestS = 1e9;
    for (const e of losThreats) {
      if (e.dist > maxRange) continue;
      const hostile = (e.hitMeT && t - e.hitMeT < 6) || e.aimingAtMe;
      if (P.polite && !this.ffa && !(this.hostileIds && this.hostileIds.has(e.id)) && !(e.charging && e.aimingAtMe) && !(e.dist < P.politeR)) continue;
      if ((this.ffa || P.pickyEngage) && !hostile && e.dist > P.ffaEngage && e.hp > 0.5 * e.max_hp) continue;
      let s = (e.hp ?? 1400) / myDps + e.dist / 50 - (hostile ? 2 : 0) - (e.id === this.tgtId ? 1.5 : 0);
      if (P.laserTgt && !laser && (e.weapons || []).includes("laser")) s -= P.laserTgt;
      if (P.threatW) {
        const ew = e.weapons || [];
        const theirDps = (ew.includes("laser") ? 130 : 0) + (ew.includes("lightning") && e.dist < 55 ? 240 : 0) + (ew.includes("mortar") ? 70 : 0);
        s -= P.threatW * theirDps / 100;
        if (laser && ew.includes("mortar")) s -= P.threatW * 0.6;
      }
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
    let rushP = null, rushRoof = null, rushOff = null;
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
      // several enemies around: pick the step that the fewest other enemies can see
      if (P.coverStrafe && ref.kind !== "npc") {
        const others = this.multiThreats.filter((e) => e !== ref);
        if (others.length) {
          let best = null, bs = 1e9;
          const pref = v ? Math.atan2(v[1], v[0]) : null;
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * TAU, vx = Math.cos(a), vy = Math.sin(a);
            const px = X + vx * 8, py = Y + vy * 8;
            if (!m.walkable(X + vx * 4, Y + vy * 4) || !m.walkable(px, py) || !this.okPos(px, py)) continue;
            const g = m.groundAt(px, py);
            let sc = 0;
            for (const e of others) if (this.seesMe(e, px, py, g)) sc += 3;
            if (!this.seesMe(ref, px, py, g)) sc += 1.5; // stay able to shoot the target
            const dd = hyp(ref.pos[0] - px, ref.pos[1] - py); if (dd < want * 0.6) sc += 1;
            if (pref != null) sc += (1 - Math.cos(a - pref)) * 0.6;
            if (sc < bs) { bs = sc; best = [vx, vy]; }
          }
          if (best) v = best;
        }
      }
      if (!v) { const zc = z.next_center; const a = Math.atan2(zc[1] - Y, zc[0] - X); v = [Math.cos(a), Math.sin(a)]; }
      return v;
    };

    const roofMode = P.roof && (!this.ffa || P.roofAlways);
    let roofLabel = null;
    if (roofMode) {
      if (!this.roofs) this.computeRoofs();
      const here = this.roofAt(X, Y, Z);
      // move on the roof towards `des`, never closer than 2 m to the edge
      const roofStep = (rf, des) => {
        const dn = hyp(des[0], des[1]); if (dn < 0.05) return [0, 0];
        let best = [0, 0], bs = 0.15;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU, vx = Math.cos(a), vy = Math.sin(a);
          if (!this.onRoofCell(rf, X + vx * 3, Y + vy * 3, 1) || !this.onRoofCell(rf, X + vx * 5, Y + vy * 5, 1)) continue;
          const sc = (vx * des[0] + vy * des[1]) / dn; if (sc > bs) { bs = sc; best = [vx, vy]; }
        }
        return best;
      };
      if (here && this.roofOK(here, t)) {
        this.roof = here; this.roofClimbT = null; this.roofApproach = null;
        const cx = here.center[0] - X, cy = here.center[1] - Y, dc = hyp(cx, cy) || 1;
        const slack = Math.max(4, here.depth * 2 * 0.5);
        if (target) {
          if (t > this.strafeT) { this.strafe = -(this.strafe || 1); this.strafeT = t + P.strafeMin + this.rnd() * (P.strafeMax - P.strafeMin); }
          const dx = target.pos[0] - X, dy = target.pos[1] - Y, d = hyp(dx, dy) || 1, ux = dx / d, uy = dy / d;
          const tl = (target.weapons || []).includes("lightning");
          let rad = tl && d < 60 ? -1 : (d > 140 ? 0.4 : 0);
          let vx = -uy * this.strafe + ux * rad, vy = ux * this.strafe + uy * rad;
          if (dc > slack) { vx += cx / dc * 0.8; vy += cy / dc * 0.8; }
          mv = roofStep(here, [vx, vy]);
          if (mv[0] === 0 && mv[1] === 0) { this.strafe = -this.strafe; mv = roofStep(here, [uy * this.strafe + ux * rad, -ux * this.strafe + uy * rad]); }
          roofLabel = "R:fight";
        } else {
          mv = dc > 1.5 ? roofStep(here, [cx, cy]) : [0, 0];
          roofLabel = "R:hold";
        }
      } else if (!zoneUrgent && (!inCombat || (this.roofClimbT != null && Z > m.groundAt(X, Y) + 3))) {
        const laserNear = laser == null && !inCombat && [...this.pickups.values()].some((p) => p.kind === "laser" && hyp(p.pos[0] - X, p.pos[1] - Y) < P.roofLaserR && p.pos[2] < m.groundAt(p.pos[0], p.pos[1]) + 4);
        const rf = laserNear ? null : this.pickRoof(t);
        if (rf) {
          if (!this.roofApproach) this.roofApproach = this.roofApproachFor(rf);
          const ap = this.roofApproach;
          const h = rf.top - Z;
          if (ap) {
            const dAp = hyp(ap.x - X, ap.y - Y), dEdge = hyp(ap.ex - X, ap.ey - Y);
            if (dAp < 3 || dEdge < 5 || (this.roofClimbT != null && t - this.roofClimbT < 9)) {
              if (this.roofClimbT == null) this.roofClimbT = t;
              if (t - this.roofClimbT > 8) { (this.roofBan ??= new Map()).set(rf.id, t + 60); this.roof = null; this.roofClimbT = null; this.roofApproach = null; }
              const need = Math.min(100, 1.7 * Math.max(0, h) + 12);
              if (me.grounded && me.energy < need && h > 2) { mv = [0, 0]; roofLabel = "R:charge"; this.roofClimbT = t; }
              else {
                const gx = Z > rf.top + 0.5 ? rf.center[0] : ap.ex, gy = Z > rf.top + 0.5 ? rf.center[1] : ap.ey;
                const dd = hyp(gx - X, gy - Y) || 1; mv = [(gx - X) / dd, (gy - Y) / dd];
                if (h > -1.5) { if (me.grounded) jump = true; else boost = me.energy > 1; }
                roofLabel = "R:climb";
              }
            } else {
              this.roofClimbT = null;
              const nv = this.navTo(ap.x, ap.y, t); mv = [nv[0], nv[1]]; roofLabel = "R:to";
            }
          } else { (this.roofBan ??= new Map()).set(rf.id, t + 300); this.roof = null; }
        }
      }
    }
    if (roofLabel) {
      label = roofLabel;
    } else if (zoneUrgent) {
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
      if (light && !laser && P.lightClose) want = Math.min(want, 25);
      if (laser && !(target.weapons && target.weapons.includes("lightning"))) want = Math.max(want, P.laserRange);
      if (this.shots > 14 && this.hits / this.shots < 0.3) want = Math.min(want, 70);
      if (z.radius < 80) want = Math.min(want, z.radius * 0.9);
      if (P.camp && (!this.ffa || P.campAlways) && this.camp) {
        want = Math.min(Math.max(target.dist, 40), 200); // hold the current distance, do not chase
        mv = dodge(target, want);
        const dcamp = hyp(this.camp[0] - X, this.camp[1] - Y);
        if (dcamp > P.campFightLeash) { const nv = this.navTo(this.camp[0], this.camp[1], t); mv = [nv[0], nv[1]]; }
        label = "hold " + target.id;
      } else if (P.kite && attackers.length >= 2) {
        // outnumbered: back away from the group while strafing so they arrive one at a time
        let cx = 0, cy = 0; for (const e of attackers) { cx += e.pos[0]; cy += e.pos[1]; } cx /= attackers.length; cy /= attackers.length;
        const ax = X - cx, ay = Y - cy, an = hyp(ax, ay) || 1;
        const sv = dodge(target, want);
        let vx = ax / an * P.kite + sv[0] * (1 - P.kite), vy = ay / an * P.kite + sv[1] * (1 - P.kite); const vn = hyp(vx, vy) || 1; vx /= vn; vy /= vn;
        if (m.walkable(X + vx * 6, Y + vy * 6) && this.okPos(X + vx * 8, Y + vy * 8)) mv = [vx, vy]; else mv = sv;
        label = "kite " + target.id;
      } else { mv = dodge(target, want); label = "fight " + target.id; if (P.boostStrafe && target.dist < P.bsR && me.energy > P.bsE && !(light && !laser)) boost = true; }
      if (P.kb && laser && !this.ffa && target.dist < P.laserRange - 15 && !(target.weapons || []).includes("lightning") || (P.kb && laser && !this.ffa && target.dist < 60)) {
        // sniper: back straight off to laser range (they barely hit beyond ~150 m), sprint when close
        const ax = X - target.pos[0], ay = Y - target.pos[1], an = hyp(ax, ay) || 1;
        let best = null, bs = -1e9;
        for (let k = -4; k <= 4; k++) {
          const a = Math.atan2(ay, ax) + k * 0.3, vx = Math.cos(a), vy = Math.sin(a);
          if (!m.walkable(X + vx * 5, Y + vy * 5) || !m.walkable(X + vx * 10, Y + vy * 10) || !this.okPos(X + vx * 12, Y + vy * 12)) continue;
          const sc = Math.cos(k * 0.3) - (hyp(X + vx * 12 - z.next_center[0], Y + vy * 12 - z.next_center[1]) > z.next_radius - 10 ? 2 : 0);
          if (sc > bs) { bs = sc; best = [vx, vy]; }
        }
        if (best) { mv = best; boost = target.dist < P.kbBoost && me.energy > 25; label = "kb " + target.id; }
      }
      if (P.scout && P.scoutFightR && !laser && t < P.scoutT && target.dist > P.scoutFightR) { const g4 = this.scoutGoal(t, X, Y); if (g4) { const nv = this.navTo(g4[0], g4[1], t); mv = [nv[0], nv[1]]; boost = me.energy > P.scoutE + 20; label = "scoutf " + target.id; } }
      if (P.evade && !this.ffa && this.myKills >= P.evadeAfter && (!P.evadeNoLaser || !laser)) { mv = dodge(target, P.evade); boost = me.energy > 40 && target.dist < P.evade * 0.7; label = "evade " + target.id; }
      if (P.grabR && !laser && (!this.retreating || P.grabRetreat)) {
        // a laser lying close by is worth more than a few seconds of strafing: go and take it while shooting
        let gp = null, gd = 1e9;
        for (const p of this.pickups.values()) {
          const isL = p.kind === "laser", isE = P.grabLight && p.kind === "lightning" && !w1;
          if (!(isL || isE) || p.pos[2] > m.groundAt(p.pos[0], p.pos[1]) + 4 || !this.okPos(p.pos[0], p.pos[1]) || this.offMesh(p.pos[0], p.pos[1])) continue;
          const d = hyp(p.pos[0] - X, p.pos[1] - Y) * (isL ? 1 : P.grabLight); if (d < Math.min(gd, P.grabR)) { gd = d; gp = p; }
        }
        if (gp) { const nv = this.navTo(gp.pos[0], gp.pos[1], t); mv = [nv[0], nv[1]]; label = "grab " + gp.kind; if (P.boostLaser && gd > 12 && me.energy > 20) boost = true; }
        else if (P.grabRoof && !laser) {
          if (!this.roofs) this.computeRoofs();
          let rr = null, bd = P.grabRoof;
          for (const p of this.pickups.values()) {
            if (p.kind !== "laser" || p.pos[2] <= m.groundAt(p.pos[0], p.pos[1]) + 4) continue;
            const id = this.roofLab[m.cellOf(p.pos[0], p.pos[1])]; if (id == null || id < 0 || (this.climbBan && this.climbBan.has(id))) continue;
            const rf = this.roofs.find((q) => q.id === id); if (!rf || Math.abs(rf.top - p.pos[2]) > 3) continue;
            const d = hyp(p.pos[0] - X, p.pos[1] - Y); if (d < bd) { bd = d; rr = { p, rf }; }
          }
          if (rr) {
            const st = this.climbStep(rr.rf, rr.p.pos[0], rr.p.pos[1], t);
            if (st) { mv = st.mv; jump = st.jump; boost = st.boost; label = st.label; }
            if (hyp(rr.p.pos[0] - X, rr.p.pos[1] - Y) < 3.6 && Math.abs(rr.p.pos[2] - Z) < 3.8 && pickSlot(rr.p.kind) !== -1) { act.take = rr.p.id; const ds = pickSlot(rr.p.kind); if (ds != null) act.drop = ds; }
          }
        }
      }
    } else if (P.duck && this.snipedBy(t)) {
      const e = this.snipedBy(t);
      const cov = this.findCover([e, ...threatsForCover.filter((x) => x !== e)], t);
      if (cov) { const nv = this.navTo(cov[0], cov[1], t); mv = nv[2] > 2.2 ? [nv[0], nv[1]] : [0, 0]; boost = me.energy > 30 && nv[2] > 2.2; }
      else mv = dodge(e, 400);
      label = "duck";
    } else if (npcFoe && hpF > 0.3) {
      farmTgt = npcFoe; mv = dodge(npcFoe, 70); label = "npc fight";
    } else {
      // --- no target: loot / farm / position ---
      rushP = null; rushRoof = null; rushOff = null;
      if (P.rushR && !laser) {
        let rd = P.rushR;
        for (const p of this.pickups.values()) {
          if (p.kind !== "laser" || p.pos[2] > m.groundAt(p.pos[0], p.pos[1]) + 4 || !this.okPos(p.pos[0], p.pos[1]) || this.offMesh(p.pos[0], p.pos[1])) continue;
          const d = hyp(p.pos[0] - X, p.pos[1] - Y); if (d < rd) { rd = d; rushP = p; }
        }
        if (!rushP && P.climb2) {
          if (!this.roofs) this.computeRoofs();
          let bd = P.rushR;
          for (const p of this.pickups.values()) {
            if (p.kind !== "laser" || p.pos[2] <= m.groundAt(p.pos[0], p.pos[1]) + 4) continue;
            const id = this.roofLab[m.cellOf(p.pos[0], p.pos[1])]; if (id == null || id < 0 || (this.climbBan && this.climbBan.has(id))) continue;
            const rf = this.roofs.find((q) => q.id === id); if (!rf || Math.abs(rf.top - p.pos[2]) > 3) continue;
            const d = hyp(p.pos[0] - X, p.pos[1] - Y); if (d < bd) { bd = d; rushRoof = { p, rf }; }
          }
        }
      }
      if (P.offRush && !laser && m.comp[m.cellOf(X, Y)]) {
        let bd = Math.min(P.offRush, rushP ? hyp(rushP.pos[0] - X, rushP.pos[1] - Y) - 40 : 1e9);
        for (const p of this.pickups.values()) {
          if (p.kind !== "laser") continue;
          const c = m.cellOf(p.pos[0], p.pos[1]);
          const roofy = m.solid[c] || p.pos[2] > m.ground[c] + 4;
          if ((m.comp[c] && !roofy) || (roofy && !(P.offRoof && p.pos[2] - Z < P.offRoof)) || !this.okPos(p.pos[0], p.pos[1]) || (this.offBan && this.offBan.has(p.id))) continue;
          const d = hyp(p.pos[0] - X, p.pos[1] - Y); if (d < bd) { bd = d; rushOff = p; }
        }
        if (rushOff) rushP = null;
      }
      const hot = recent.filter((e) => t - e.seenT < 5 && e.dist < P.quietR);
      const quiet = hot.length === 0 && !underFire;
      let best = null, bs = 1e9;
      const consider = (kind, o, w, extra = 0) => {
        if (!this.okPos(o.pos[0], o.pos[1])) return;
        if (kind !== "drop" && this.offMesh(o.pos[0], o.pos[1])) return;
        let roofPen = 0;
        if (m.solid[m.cellOf(o.pos[0], o.pos[1])] || o.pos[2] > m.groundAt(o.pos[0], o.pos[1]) + 4) { // on a roof
          const h = o.pos[2] - Z;
          if (!(P.climb && kind === "pickup" && o.kind === "laser" && h < 42 && !(this.noClimb && this.noClimb.has(o.id)))) return;
          roofPen = 10 + h * 1.2;
        } else if (P.climbTest && kind === "pickup") return;
        const d = hyp(o.pos[0] - X, o.pos[1] - Y) + roofPen;
        if (this.ffa) for (const e of recent) if (hyp(e.pos[0] - o.pos[0], e.pos[1] - o.pos[1]) < 90) return;
        const s = d * w + extra; if (s < bs) { bs = s; best = { kind, o, d }; }
      };
      for (const c of this.cubes.values()) consider("cube", c, 0.6);
      const PW = { laser: 0.35, lightning: 0.9, mortar: 1.3 };
      for (const p of this.pickups.values()) if (pickSlot(p.kind) !== -1) consider("pickup", p, (p.kind === "laser" ? P.pwL : p.kind === "lightning" ? P.pwE : (PW[p.kind] ?? 1.2)) * (w1 ? 1.3 : 1));
      for (const d of obs.drops || []) if (d.lands_in < P.dropLead) consider("drop", d, P.dropW, d.holder != null && d.holder !== me.id ? 80 : 0);
      if (quiet && hpF > P.farmHp) {
        for (const c of this.crates.values()) consider("crate", c, 1.3 * P.farmBias * (laser ? 1 : P.crateNoLaser), 15 * P.farmBias * (laser ? 1 : P.crateNoLaser));
        if (hpF > P.npcFarmHp) for (const n of this.npcs.values()) if (t - n.seenT < 40) consider("npc", n, 1.4 * P.farmBias * P.npcW * (laser && P.npcLaserR ? P.npcLaserW : 1), 30 * P.farmBias * P.npcW * (laser && P.npcLaserR ? P.npcLaserW : 1));
      }
      if (!quiet && best && best.d > 45 && hpF < 0.8) best = null;
      const camping = P.camp && (!this.ffa || P.campAlways);
      if (camping && best) {
        const isLaser = best.kind === "pickup" && best.o.kind === "laser";
        const lim = isLaser ? P.campLaserR : best.kind === "drop" ? 0 : P.campLootR;
        if (best.d > lim || (best.kind === "npc")) best = null;
      }
      if (camping && !best && !this.retreating) {
        if (!this.camp || t - this.campT > 6 || !this.okPos(this.camp[0], this.camp[1])) {
          const nc = this.findCamp(this.camp && this.okPos(this.camp[0], this.camp[1]) ? this.camp[0] : X, this.camp && this.okPos(this.camp[0], this.camp[1]) ? this.camp[1] : Y, t);
          if (nc) { this.camp = nc; this.campT = t; }
        }
      }
      if (camping && !best && this.camp && !(this.retreating || (hot.length && hpF < 0.8))) {
        const dcamp = hyp(this.camp[0] - X, this.camp[1] - Y);
        if (dcamp > 2.5) { const nv = this.navTo(this.camp[0], this.camp[1], t); mv = [nv[0], nv[1]]; if (dcamp < 8) mv = [mv[0] * 0.4, mv[1] * 0.4]; label = "to camp"; }
        else { mv = [0, 0]; label = "camp"; }
      } else if (best && bs < 420) {
        const o = best.o;
        if (best.kind === "crate" || best.kind === "npc") {
          const rng = best.kind === "crate" ? P.crateRange : (laser && P.npcLaserR ? P.npcLaserR : P.npcRange);
          const vis = best.d < rng && m.los(X, Y, Z + this.muzzleH, o.pos[0], o.pos[1], this.centerZ({ ...o, kind: best.kind }));
          if (vis) { farmTgt = { ...o, kind: best.kind, vel: o.vel || [0, 0, 0] }; if (best.kind === "npc") mv = dodge(o, laser && P.npcLaserR ? 140 : 65); else if (best.d > 30) { const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]]; } }
          else { const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]]; }
          label = "farm " + best.kind;
        } else if (best.kind === "pickup" && (m.solid[m.cellOf(o.pos[0], o.pos[1])] || o.pos[2] > m.groundAt(o.pos[0], o.pos[1]) + 4)) {
          // roof item: walk to the building, then jump and jet up while pushing toward it
          const hd = hyp(o.pos[0] - X, o.pos[1] - Y), h = o.pos[2] - Z;
          if (this.climbId !== o.id) { this.climbId = o.id; this.climbT0 = t; }
          if (t - this.climbT0 > 25) { (this.noClimb ??= new Set()).add(o.id); }
          const near = hd < 16 || !m.comp[m.cellOf(X, Y)];
          if (!near) { const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]]; label = "to roof"; }
          else {
            const need = Math.min(100, 1.6 * Math.max(0, h) + 12);
            if (h > 1 && me.grounded && me.energy < need) { mv = [0, 0]; label = "charge jets"; }
            else {
              mv = hd > 0.5 ? [(o.pos[0] - X) / hd, (o.pos[1] - Y) / hd] : [0, 0];
              if (h > 0.8) { if (me.grounded) jump = true; else boost = me.energy > 2; }
              label = "climb";
            }
          }
          if (hd < 3.6 && Math.abs(h) < 3.8 && pickSlot(o.kind) !== -1) { act.take = o.id; const ds = pickSlot(o.kind); if (ds != null) act.drop = ds; }
        } else {
          const nv = this.navTo(o.pos[0], o.pos[1], t); mv = [nv[0], nv[1]];
          if (best.kind === "drop" && best.d < 4) mv = [0, 0];
          if (best.kind === "pickup" && best.d < 3.6 && pickSlot(o.kind) !== -1) { act.take = o.id; const ds = pickSlot(o.kind); if (ds != null) act.drop = ds; }
          boost = best.kind !== "drop" && best.d > 25 && me.energy > 60 && quiet;
          if (P.boostLaser && best.kind === "pickup" && o.kind === "laser" && !laser && best.d > 12 && me.energy > 20) boost = true;
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
        else if (P.seek && !this.ffa && hpF > P.seekHp && (laser || me.cubes >= 3) && this.seekGoal(t)) {
          const g2 = this.seekGoal(t); const nv = this.navTo(g2[0], g2[1], t); mv = [nv[0], nv[1]]; label = "seek";
        }
        else if (P.scout && !laser && t < P.scoutT && this.scoutGoal(t, X, Y)) {
          const g3 = this.scoutGoal(t, X, Y); const nv = this.navTo(g3[0], g3[1], t); mv = [nv[0], nv[1]]; boost = me.energy > P.scoutE; label = "scout";
        }
        else if (P.explore && quiet && (!laser || me.cubes < 10)) {
          // nothing to do: walk to a fresh spot inside the next circle to find weapons, crates and cubes
          const ex = this.exploreTo;
          if (!ex || t > this.exploreUntil || hyp(ex[0] - X, ex[1] - Y) < 8 || !this.okPos(ex[0], ex[1])) {
            let pick = null;
            for (let k = 0; k < 20 && !pick; k++) {
              const a = this.rnd() * TAU, r = 60 + this.rnd() * 120;
              const px = X + Math.cos(a) * r, py = Y + Math.sin(a) * r;
              if (hyp(px - z.next_center[0], py - z.next_center[1]) > z.next_radius * 0.85) continue;
              const c = m.cellOf(px, py); if (!m.comp[c]) continue;
              pick = [px, py];
            }
            this.exploreTo = pick || [z.next_center[0], z.next_center[1]]; this.exploreUntil = t + 25;
          }
          const nv = this.navTo(this.exploreTo[0], this.exploreTo[1], t); mv = [nv[0], nv[1]]; label = "explore";
        }
        else label = "wait";
      }
    }
    if (!rushP && rushRoof && !label.startsWith("zone")) {
      const st = this.climbStep(rushRoof.rf, rushRoof.p.pos[0], rushRoof.p.pos[1], t);
      if (st) { mv = st.mv; jump = st.jump; boost = st.boost; label = st.label; }
      const p = rushRoof.p;
      if (hyp(p.pos[0] - X, p.pos[1] - Y) < 3.6 && Math.abs(p.pos[2] - Z) < 3.8 && pickSlot(p.kind) !== -1) { act.take = p.id; const ds = pickSlot(p.kind); if (ds != null) act.drop = ds; }
    }
    if (rushOff && !label.startsWith("zone")) {
      const p = rushOff, d = hyp(p.pos[0] - X, p.pos[1] - Y);
      if (!this.offF || this.offF.id !== p.id) this.offF = { id: p.id, f: m.fieldTo(p.pos[0], p.pos[1], Math.min(170, d + 25)), t0: t };
      const st = this.escapeStep(me, this.offF.f);
      if (!st || t - this.offF.t0 > 30) (this.offBan ??= new Set()).add(p.id);
      else { mv = st.mv; jump = st.jump; boost = st.boost || (st.label === "E:walk" && me.grounded && me.energy > 75 && d > 25); label = "E:laser"; this.stuckT = -9; }
      if (d < 3.6 && Math.abs(p.pos[2] - Z) < 3.8 && pickSlot(p.kind) !== -1) { act.take = p.id; const ds = pickSlot(p.kind); if (ds != null) act.drop = ds; }
    }
    if (rushP && !label.startsWith("zone")) {
      const d = hyp(rushP.pos[0] - X, rushP.pos[1] - Y);
      const nv = this.navTo(rushP.pos[0], rushP.pos[1], t); mv = [nv[0], nv[1]];
      boost = d > 10 && me.energy > 15;
      if (d < 3.6 && pickSlot(rushP.kind) !== -1) { act.take = rushP.id; const ds = pickSlot(rushP.kind); if (ds != null) act.drop = ds; }
      label = "rush laser";
    }
    // pick up weapons we walk past, even mid-fight
    if (act.take == null) for (const p of obs.pickups || []) {
      const ds = pickSlot(p.kind);
      if (ds !== -1 && hyp(p.pos[0] - X, p.pos[1] - Y) < 3.7 && Math.abs(p.pos[2] - Z) < 3.8 && !(laser && laser.charge > 0)) { act.take = p.id; if (ds != null) act.drop = ds; break; }
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
    if (P.laserDodge && label !== "shell" && label !== "climb" && !label.startsWith("R:")) {
      let th = null, td = 0;
      for (const e of this.en.values()) {
        if (e.seenT !== t || !e.charging || e.chargeT == null || t - e.chargeT < P.ldStart) continue;
        const dx = X - e.pos[0], dy = Y - e.pos[1], d = hyp(dx, dy);
        if (d > 290 || d < 12) continue;
        if (Math.abs(wrap(e.aim[0] - Math.atan2(dy, dx))) > Math.max(0.05, 6 / d)) continue;
        if (!th || d < td) { th = e; td = d; }
      }
      if (th && P.laserDodge === 3) {
        // step out of the beam's line of sight if cover is close enough to reach before it fires
        const left = Math.max(0.15, th.stats?.charge ?? 0.75) - (t - th.chargeT) + 0.15;
        const sp = me.energy > (light ? 40 : 10) ? me.stats.boost_speed : me.stats.walk_speed;
        let best = null, bd = 1e9;
        for (const r of [2.5, 4, 6, 8]) {
          if (r > sp * left + 1.5) break;
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * TAU, vx = Math.cos(a), vy = Math.sin(a), qx = X + vx * r, qy = Y + vy * r;
            if (!m.walkable(qx, qy) || !m.walkable(X + vx * r * 0.5, Y + vy * r * 0.5)) continue;
            if (this.seesMe(th, qx, qy, m.groundAt(qx, qy))) continue;
            if (r < bd) { bd = r; best = [vx, vy]; }
          }
          if (best) break;
        }
        if (best) { mv = best; boost = me.energy > (light ? 40 : 10); label += "+lcover"; }
      } else if (th) {
        const ux = (X - th.pos[0]) / td, uy = (Y - th.pos[1]) / td, px = -uy, py = ux;
        const vl = me.vel[0] * px + me.vel[1] * py;
        let sg = vl >= 0 ? 1 : -1; if (P.laserDodge === 1) sg = -sg; // 1 = reverse lateral motion, 2 = keep going
        if (!m.walkable(X + px * sg * 4, Y + py * sg * 4)) sg = -sg;
        if (m.walkable(X + px * sg * 4, Y + py * sg * 4)) { mv = [px * sg, py * sg]; boost = me.energy > (light ? 40 : 10); label += "+ldodge"; }
      }
    }
    if (P.dodge && label !== "shell" && label !== "climb" && !(label.startsWith("R:") && label !== "R:to") && !(label.startsWith("C:") && label !== "C:to") && !label.startsWith("E:") && !label.endsWith("+ldodge") && !label.endsWith("+lcover")) {
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
            for (const bst of [false, me.energy > (light ? 40 : 10)]) {
              const r = risk(dx, dy, bst);
              const sc = r * 10 + (pref == null ? 0 : (1 - Math.cos(a - pref)) * 0.8) + (bst ? 0.1 : 0);
              if (sc < bs) { bs = sc; best = [dx, dy, bst]; }
            }
          }
          if (best) { mv = [best[0], best[1]]; boost = best[2]; label += "+dodge"; }
        }
      }
    }

    // --- periscope: hop up on the jets to look over the buildings for a laser ---
    if (P.peri && !laser && !this.ffa) {
      const known = [...this.pickups.values()].some((p) => p.kind === "laser" && !(this.offBan && this.offBan.has(p.id)));
      const busy = !!target || label.startsWith("E:") || label.startsWith("C:") || label.startsWith("R:") || /^(flee|cover|heal|hide|cornered|shell|grab|rush|climb|charge)/.test(label);
      if (this.periOn) {
        if (me.grounded && t - this.periT0 > 0.4) this.periOn = false;
        else { if (Z - this.periZ0 < P.periH && me.energy > 4 && me.vel[2] > -1) boost = true; jump = false; this.periSpin = true; }
      } else if (!known && !busy && me.grounded && me.energy >= P.periE && t < P.periUntil && t - (this.periLast ?? -99) > P.periEvery && (t > 0.3)) {
        this.periOn = true; this.periT0 = t; this.periLast = t; this.periZ0 = Z; jump = true; label = "peri";
      }
      if (this.periOn) label = "peri";
    } else this.periOn = false;
    // --- stuck recovery ---
    this.hist.push([t, X, Y]); while (this.hist.length > 12) this.hist.shift();
    const wantMove = hyp(mv[0], mv[1]) > 0.3;
    if (wantMove && this.hist.length >= 12 && t > this.stuckT + 1.5) {
      const h0 = this.hist[0];
      if (hyp(X - h0[1], Y - h0[2]) < 1.2 && !(laser && laser.charge > 0)) { this.stuckT = t; this.unstuckDir = (this.rnd() < 0.5 ? -1 : 1) * (0.6 + this.rnd()); this.path = null; }
    }
    const climbing = label === "climb" || label === "charge jets" || label === "peri" || label === "E:laser" || (label.startsWith("R:") && label !== "R:to") || (label.startsWith("C:") && label !== "C:to");
    if (climbing) this.stuckT = -9;
    if (t - this.stuckT < 0.7 && wantMove && !climbing) {
      const a = Math.atan2(mv[1], mv[0]) + this.unstuckDir; mv = [Math.cos(a), Math.sin(a)]; jump = me.grounded; boost = P.unstickBoost && me.energy > 10; label = "unstick";
    }
    if (P.esc && !m.comp[m.cellOf(X, Y)] && !target && !climbing && label !== "E:laser" && !(label.startsWith("C:") || label.startsWith("R:")) && !(P.escGate && /^(flee|cover|heal|hide|cornered|duck|shell|npc|hold)/.test(label))) {
      let es = null;
      // a laser lying inside the same enclosure: take it before leaving
      if (!laser) for (const p of this.pickups.values()) {
        if (p.kind !== "laser" || m.comp[m.cellOf(p.pos[0], p.pos[1])] || Math.abs(p.pos[2] - Z) > 4) continue;
        const d = hyp(p.pos[0] - X, p.pos[1] - Y); if (d > 90 || !m.walkLine(X, Y, p.pos[0], p.pos[1])) continue;
        es = { mv: [(p.pos[0] - X) / (d || 1), (p.pos[1] - Y) / (d || 1)], jump: false, boost: me.energy > 60, label: "E:loot" };
        if (d < 3.6 && pickSlot(p.kind) !== -1) { act.take = p.id; const ds = pickSlot(p.kind); if (ds != null) act.drop = ds; }
        break;
      }
      if (!es && !(t < (this.escBan || 0))) {
        es = this.escapeStep(me);
        const ed = m.exitDist[m.cellOf(X, Y)];
        if (this.escBest == null || ed < this.escBest - 0.5 || t - this.escT > 12) { this.escBest = ed; this.escT = t; }
        else if (t - this.escT > 5 && me.grounded && es && es.label !== "E:charge") { this.escBan = t + 2.5; this.escBest = null; es = null; } // no progress: let the old wiggle try
      }
      if (es) { mv = es.mv; jump = es.jump; boost = es.boost; label = es.label; this.stuckT = -9; }
    } else
    if (!m.comp[m.cellOf(X, Y)] && wantMove && !climbing) {
      const c = m.nearestOpen(X, Y); const dx = m.cx(c) - X, dy = m.cy(c) - Y, d = hyp(dx, dy);
      if (d > 0.5 && Z > m.ground[c] + 2.5) mv = [dx / d, dy / d];
    }

    // --- aim & fire ---
    const fire = [false, false];
    let aim = null;
    const shootAt = target || (P.spinForce && t < P.spin0 ? null : farmTgt);
    this.shootAt = shootAt ? { id: shootAt.id, kind: shootAt.kind || (this.crates.has(shootAt.id) ? "crate" : "?"), dist: hyp(shootAt.pos[0] - X, shootAt.pos[1] - Y), vis: shootAt.seenT === t, vel: shootAt.vel } : null;
    const ahead = P.ahead;
    if (shootAt) {
      const isMech = shootAt === target;
      const L = gun ? this.lead(shootAt, gun.stats.speed, ahead) : this.lead(shootAt, 1e9, ahead);
      const D = this.lead(shootAt, 1e9, 0.1);
      const rad = (isMech ? 2.5 * (1 + 0.05 * (shootAt.cubes || 0)) : shootAt.kind === "npc" ? 1.8 : 1.4);
      const slack = me.stats.turn_rate * P.aimSlack;
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
          // wait for a moment when the target is not sliding sideways (strafe reversal), up to laserWait s after full charge
          if (ch >= need) { if (this.laserFullT == null) this.laserFullT = t; } else this.laserFullT = null;
          const lx = Math.cos(D.yaw), ly = Math.sin(D.yaw);
          const vlat = Math.abs(-ly * (shootAt.vel[0] - me.vel[0]) + lx * (shootAt.vel[1] - me.vel[1]));
          const steady = !P.laserTiming || vlat < P.laserVlat || D.dist < 45 || (this.laserFullT != null && t - this.laserFullT > P.laserWait);
          if (ch >= need && steady && ey < tolY + slack * 0.5 && epi < tolP + 0.05) { fire[lS] = false; this.laserFullT = null; } // release
          else fire[lS] = true;
        } else if (ch > 0) { fire[lS] = P.laserHold ? true : false; if (P.laserHold) aim = [D.yaw, D.pitch]; } // keep the charge aimed instead of wasting it
        if (isMech) this.lastShotAt = { x: shootAt.pos[0], y: shootAt.pos[1], z: this.centerZ(shootAt), t };
      }
      if (gunReady && L.dist + 0 < gun.stats.range * 0.97) {
        const ey = Math.abs(wrap(me.aim[0] - L.yaw)), epi = Math.abs(me.aim[1] - L.pitch);
        const tolY = Math.atan2(rad * (isMech ? 1.0 : 0.8), L.dist), tolP = Math.atan2(isMech ? (shootAt.aimZoff > 6 ? 1.2 : 4) : 1.2, L.dist);
        if (ey < tolY + slack && epi < tolP + 0.04) { fire[gS] = true; if (isMech) this.shots += this.dt / gun.stats.cooldown; }
      }
      if (light && isMech && D.dist < light.stats.range * 0.97 && Math.abs(wrap(me.aim[0] - D.yaw)) < (light.stats.cone_deg * Math.PI / 180) * 0.85 && me.energy > 8) fire[eS] = true;
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
        if (sol) { aim = sol; if (Math.abs(wrap(me.aim[0] - sol[0])) < 0.05 && Math.abs(me.aim[1] - sol[1]) < 0.04) fire[mS] = true; }
      }
    } else {
      if (laser && (laser.charge || 0) > 0) fire[lS] = false;
      const holdLaser = P.laserHold && laser && (laser.charge || 0) > 0 && this.lastShotAt && t - this.lastShotAt.t < 4;
      if (holdLaser) fire[lS] = true;
      // look: at whoever hurt us, at last known enemy, at a sound, else sweep along travel
      const lastE = recent.filter((e) => t - e.seenT < 6).sort((a, b) => a.dist - b.dist)[0];
      if (t - this.lastDmgT < 2 && this.lastDmgBearing != null && !(lastE && lastE.fresh)) aim = [this.lastDmgBearing, 0];
      else if (lastE) aim = [Math.atan2(lastE.pos[1] - Y, lastE.pos[0] - X), clamp(Math.atan2(this.centerZ(lastE) - Z - 7, lastE.dist || 1), -0.5, 0.8)];
      else if (t - this.soundT < 1.5 && this.soundYaw != null) aim = [this.soundYaw, 0];
      else if (this.periOn) aim = [wrap(me.aim[0] + 2), -0.15];
      else if (P.spin0 && t < P.spin0) aim = [wrap(me.aim[0] + 2), 0]; // look all around once at the start
      else {
        const base = wantMove ? Math.atan2(mv[1], mv[0]) : (this.scanBase ?? me.aim[0]);
        if (wantMove) { this.scanBase = base; aim = [base + 1.15 * Math.sin(t * 1.3), 0]; }
        else aim = [wrap(me.aim[0] + 1.6 * this.dt * 6), 0]; // slow 360 scan while standing
      }
    }
    if (!shootAt && P.laserHold && laser && (laser.charge || 0) > 0 && this.lastShotAt && t - this.lastShotAt.t < 4) {
      const L2 = this.lastShotAt; aim = [Math.atan2(L2.y - Y, L2.x - X), Math.atan2(L2.z - (Z + this.muzzleH), hyp(L2.x - X, L2.y - Y) || 1)];
    }
    // reload when it is free to do so
    if (gun && gun.reload <= 0 && gun.ammo < gun.stats.mag) {
      if (gun.ammo === 0 || (!shootAt && gun.ammo <= gun.stats.mag - 3 && losThreats.length === 0) || (P.eagerReload && !target && gun.ammo < gun.stats.mag * 0.6)) act.reload = true;
    }
    // --- upgrades ---
    if (obs.offer) {
      let bi = 0, br = 1e9;
      const order = P.upg || UPG;
      obs.offer.choices.forEach((c, i) => { let r = order.indexOf(c.id); if (r < 0) r = 50; if (r < br) { br = r; bi = i; } });
      act.pick = bi;
    }
    act.move = [Math.round(mv[0] * 1000) / 1000, Math.round(mv[1] * 1000) / 1000];
    act.boost = !!boost && (wantMove || !me.grounded); act.jump = !!jump;
    if (aim) act.aim = [Math.round(wrap(aim[0]) * 10000) / 10000, Math.round(clamp(aim[1], me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3) * 10000) / 10000];
    act.fire = fire;
    this.label = label;
    return act;
  }
}
