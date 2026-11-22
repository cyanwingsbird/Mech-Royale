// Static map model: nav grid, obstacle heights, line of sight, A* pathfinding.
import fs from "node:fs";
import path from "node:path";

export const CS = 2; // cell size, meters

export function inPoly(ring, x, y) {
  let c = false;
  for (let i = 0, n = ring.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export class GameMap {
  constructor(dir) {
    const world = JSON.parse(fs.readFileSync(path.join(dir, "v2/world.json"), "utf8"));
    const T = world.terrain;
    const buf = fs.readFileSync(path.join(dir, "v2/terrain.i16"));
    const ter = new Int16Array(buf.buffer, buf.byteOffset, T.nx * T.ny);
    this.ter = ter; this.T = T;
    this.minX = T.minX; this.minY = T.minY;
    this.nx = Math.floor(((T.nx - 1) * T.step) / CS);
    this.ny = Math.floor(((T.ny - 1) * T.step) / CS);
    const nx = this.nx, ny = this.ny, N = nx * ny;
    this.N = N;
    this.bounds = world.bounds;
    this.ground = new Float32Array(N); // walking surface height
    this.top = new Float32Array(N); // obstacle top (== ground where open)
    this.solid = new Uint8Array(N); // building body
    this.blocked = new Uint8Array(N); // not walkable for a mech center
    this.nearWall = new Uint8Array(N); // distance (cells, capped) to solid, for cover search
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const g = this.terrainAt(this.minX + (i + 0.5) * CS, this.minY + (j + 0.5) * CS);
        this.ground[j * nx + i] = g; this.top[j * nx + i] = g;
      }
    const low = new Uint8Array(N);
    for (const p of world.prisms) {
      const r = p.ring;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let k = 0; k < r.length; k += 2) {
        if (r[k] < x0) x0 = r[k]; if (r[k] > x1) x1 = r[k];
        if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k + 1] > y1) y1 = r[k + 1];
      }
      const i0 = Math.max(0, Math.floor((x0 - this.minX) / CS) - 1), i1 = Math.min(nx - 1, Math.floor((x1 - this.minX) / CS) + 1);
      const j0 = Math.max(0, Math.floor((y0 - this.minY) / CS) - 1), j1 = Math.min(ny - 1, Math.floor((y1 - this.minY) / CS) + 1);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cx = this.minX + (i + 0.5) * CS, cy = this.minY + (j + 0.5) * CS;
          // sample centre and 4 offsets so thin walls register
          let hit = false;
          for (let s = 0; s < 5 && !hit; s++) {
            const sx = cx + (s === 1 ? 0.8 : s === 2 ? -0.8 : 0), sy = cy + (s === 3 ? 0.8 : s === 4 ? -0.8 : 0);
            if (!inPoly(r, sx, sy)) continue;
            let inHole = false;
            for (const h of p.holes || []) if (inPoly(h, sx, sy)) { inHole = true; break; }
            if (!inHole) hit = true;
          }
          if (!hit) continue;
          const c = j * nx + i, g = this.terrainAt(cx, cy);
          if (p.base > g + 4) { // elevated: bridge / overhang
            if (p.base - g < 16) low[c] = 1;
          } else if (p.top <= g + 1.2) {
            if (p.top > this.ground[c]) { this.ground[c] = p.top; if (!this.solid[c]) this.top[c] = Math.max(this.top[c], p.top); }
          } else {
            this.solid[c] = 1;
            if (p.top > this.top[c]) this.top[c] = p.top;
          }
        }
    }
    // 1 m obstacle-top raster for accurate line of sight
    const fx = T.nx - 1, fy = T.ny - 1; this.fx = fx; this.fy = fy;
    const ft = new Float32Array(fx * fy); this.ftop = ft;
    for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) {
      const k = j * T.nx + i; ft[j * fx + i] = Math.max(ter[k], ter[k + 1], ter[k + T.nx], ter[k + T.nx + 1]) * T.scale;
    }
    for (const p of world.prisms) {
      const r = p.ring; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let k = 0; k < r.length; k += 2) { if (r[k] < x0) x0 = r[k]; if (r[k] > x1) x1 = r[k]; if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k + 1] > y1) y1 = r[k + 1]; }
      if (p.base > this.terrainAt((x0 + x1) / 2, (y0 + y1) / 2) + 4) continue; // bridges: shots pass under
      for (let j = Math.max(0, Math.floor(y0 - T.minY)); j <= Math.min(fy - 1, Math.floor(y1 - T.minY)); j++)
        for (let i = Math.max(0, Math.floor(x0 - T.minX)); i <= Math.min(fx - 1, Math.floor(x1 - T.minX)); i++) {
          const x = T.minX + i + 0.5, y = T.minY + j + 0.5;
          if (!inPoly(r, x, y)) continue; let h = false; for (const hl of p.holes || []) if (inPoly(hl, x, y)) { h = true; break; } if (h) continue;
          if (p.top > ft[j * fx + i]) ft[j * fx + i] = p.top;
        }
    }
    // blocked = solid dilated by one cell, low overhangs, steep ground, map edge
    const b = this.blocked;
    const bx0 = Math.ceil((world.bounds.minX + 4 - this.minX) / CS), bx1 = Math.floor((world.bounds.maxX - 4 - this.minX) / CS) - 1;
    const by0 = Math.ceil((world.bounds.minY + 4 - this.minY) / CS), by1 = Math.floor((world.bounds.maxY - 4 - this.minY) / CS) - 1;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (i < bx0 || i > bx1 || j < by0 || j > by1 || low[c]) { b[c] = 1; continue; }
        let blk = 0;
        for (let dj = -1; dj <= 1 && !blk; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            if (this.solid[jj * nx + ii]) { blk = 1; break; }
          }
        if (!blk) {
          // steep: any 4-neighbour rise beyond what a mech can walk
          const g = this.ground[c];
          let steep = 0;
          if (i > 0 && Math.abs(this.ground[c - 1] - g) > 2.3) steep++;
          if (i < nx - 1 && Math.abs(this.ground[c + 1] - g) > 2.3) steep++;
          if (j > 0 && Math.abs(this.ground[c - nx] - g) > 2.3) steep++;
          if (j < ny - 1 && Math.abs(this.ground[c + nx] - g) > 2.3) steep++;
          if (steep >= 2) blk = 1;
        }
        b[c] = blk;
      }
    // distance to solid (chebyshev, capped at 6)
    const nw = this.nearWall; nw.fill(7);
    let frontier = [];
    for (let c = 0; c < N; c++) if (this.solid[c]) { nw[c] = 0; frontier.push(c); }
    for (let d = 1; d <= 6; d++) {
      const nf = [];
      for (const c of frontier) {
        const i = c % nx, j = (c / nx) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const cc = jj * nx + ii;
          if (nw[cc] > d) { nw[cc] = d; nf.push(cc); }
        }
      }
      frontier = nf;
    }
    // main connected component of walkable cells
    this.comp = new Uint8Array(N);
    const seen = new Int32Array(N); let best = 0, bestId = 0, id = 0;
    const stack = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (b[s] || seen[s]) continue;
      id++; let sp = 0, cnt = 0; stack[sp++] = s; seen[s] = id;
      while (sp) {
        const c = stack[--sp]; cnt++;
        const i = c % nx;
        if (i > 0 && !b[c - 1] && !seen[c - 1] && this.stepOK(c, c - 1)) { seen[c - 1] = id; stack[sp++] = c - 1; }
        if (i < nx - 1 && !b[c + 1] && !seen[c + 1] && this.stepOK(c, c + 1)) { seen[c + 1] = id; stack[sp++] = c + 1; }
        if (c >= nx && !b[c - nx] && !seen[c - nx] && this.stepOK(c, c - nx)) { seen[c - nx] = id; stack[sp++] = c - nx; }
        if (c < N - nx && !b[c + nx] && !seen[c + nx] && this.stepOK(c, c + nx)) { seen[c + nx] = id; stack[sp++] = c + nx; }
      }
      if (cnt > best) { best = cnt; bestId = id; }
    }
    for (let c = 0; c < N; c++) this.comp[c] = seen[c] === bestId ? 1 : 0;
    // A* scratch
    this.gScore = new Float32Array(N); this.came = new Int32Array(N); this.stamp = new Int32Array(N); this.closed = new Int32Array(N);
    this.epoch = 0;
    this.heap = new Int32Array(N * 2); this.heapF = new Float32Array(N * 2);
    this.extraCost = null; // optional Float32Array per-cell cost
  }
  // cheapest way from every off-mesh cell (courtyard, pit, roof, stadium) to the main walkable component, allowing jump/jet climbs
  computeExit() {
    const N = this.N, nx = this.nx, ny = this.ny, b = this.bounds;
    const h = new Float32Array(N); for (let c = 0; c < N; c++) h[c] = this.solid[c] ? this.top[c] : this.ground[c];
    const i0 = Math.ceil((b.minX + 4 - this.minX) / CS), i1 = Math.floor((b.maxX - 4 - this.minX) / CS) - 1, j0 = Math.ceil((b.minY + 4 - this.minY) / CS), j1 = Math.floor((b.maxY - 4 - this.minY) / CS) - 1;
    const dist = new Float64Array(N).fill(1e9), next = new Int32Array(N).fill(-1);
    let heap = [], hd = [];
    const push = (c, f) => { let k = heap.length; heap.push(c); hd.push(f); while (k > 0) { const q = (k - 1) >> 1; if (hd[q] <= f) break; heap[k] = heap[q]; hd[k] = hd[q]; k = q; } heap[k] = c; hd[k] = f; };
    const pop = () => { const top = heap[0], tf = hd[0]; const c = heap.pop(), f = hd.pop(); const n = heap.length; if (n) { let k = 0; for (;;) { let q = 2 * k + 1; if (q >= n) break; if (q + 1 < n && hd[q + 1] < hd[q]) q++; if (hd[q] >= f) break; heap[k] = heap[q]; hd[k] = hd[q]; k = q; } heap[k] = c; hd[k] = f; } return [top, tf]; };
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * nx + i; if (!this.comp[c]) continue;
      let edge = false; for (let dj = -1; dj <= 1 && !edge; dj++) for (let di = -1; di <= 1; di++) { const n = c + dj * nx + di; if (n >= 0 && n < N && !this.comp[n]) { edge = true; break; } }
      dist[c] = 0; if (edge) push(c, 0);
    }
    while (heap.length) {
      const [v, dv] = pop(); if (dv > dist[v]) continue;
      const vi = v % nx, vj = (v / nx) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ui = vi + di, uj = vj + dj; if (ui < i0 || ui > i1 || uj < j0 || uj > j1) continue;
        const u = uj * nx + ui; if (this.comp[u]) continue;
        const rise = h[v] - h[u]; if (rise > 45) continue;
        if (!this.solid[v] && ((this.solid[v - 1] && this.solid[v + 1]) || (this.solid[v - nx] && this.solid[v + nx]))) continue; // gap too narrow for a mech
        const w = (di && dj ? 1.4142 : 1) + (rise > 1.2 ? 3 + 1.5 * rise : 0) + (rise < -25 ? 4 : 0) + (!this.solid[v] && this.nearWall[v] <= 1 ? 1.5 : 0);
        const nd = dv + w; if (nd < dist[u]) { dist[u] = nd; next[u] = v; push(u, nd); }
      }
    }
    this.exitNext = next; this.exitDist = dist; this.hgt = h;
  }
  terrainAt(x, y) {
    const T = this.T;
    let fx = (x - T.minX) / T.step, fy = (y - T.minY) / T.step;
    if (fx < 0) fx = 0; if (fy < 0) fy = 0;
    if (fx > T.nx - 1.001) fx = T.nx - 1.001; if (fy > T.ny - 1.001) fy = T.ny - 1.001;
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * T.nx + i, t = this.ter;
    return ((t[k] * (1 - u) + t[k + 1] * u) * (1 - v) + (t[k + T.nx] * (1 - u) + t[k + T.nx + 1] * u) * v) * T.scale;
  }
  stepOK(a, b) { return this.ground[b] - this.ground[a] <= 2.3; }
  cellOf(x, y) {
    let i = Math.floor((x - this.minX) / CS), j = Math.floor((y - this.minY) / CS);
    if (i < 0) i = 0; if (j < 0) j = 0; if (i >= this.nx) i = this.nx - 1; if (j >= this.ny) j = this.ny - 1;
    return j * this.nx + i;
  }
  cx(c) { return this.minX + ((c % this.nx) + 0.5) * CS; }
  cy(c) { return this.minY + (((c / this.nx) | 0) + 0.5) * CS; }
  groundAt(x, y) { return this.ground[this.cellOf(x, y)]; }
  walkable(x, y) { const c = this.cellOf(x, y); return !this.blocked[c]; }
  // nearest cell of the main walkable component
  nearestOpen(x, y, maxR = 40) {
    const c0 = this.cellOf(x, y);
    if (this.comp[c0]) return c0;
    const i0 = c0 % this.nx, j0 = (c0 / this.nx) | 0;
    let best = -1, bd = 1e9;
    for (let r = 1; r <= maxR; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
        const c = j * this.nx + i;
        if (this.comp[c]) { const d = di * di + dj * dj; if (d < bd) { bd = d; best = c; } }
      }
      if (best >= 0 && r * r >= bd) break;
    }
    return best >= 0 ? best : c0;
  }
  // 3D line of sight against buildings/terrain (trees ignored)
  los(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const d = Math.hypot(dx, dy);
    const n = Math.ceil(d / 1.5);
    if (n <= 1) return true;
    const fx = this.fx, fy = this.fy, mx = this.minX, my = this.minY, ft = this.ftop;
    const m2 = Math.ceil(d / 0.8);
    for (let k = 1; k < m2; k++) {
      const f = k / m2;
      const i = Math.floor(x0 + dx * f - mx), j = Math.floor(y0 + dy * f - my);
      if (i < 0 || j < 0 || i >= fx || j >= fy) continue;
      if (ft[j * fx + i] > z0 + dz * f + 0.1) return false;
    }
    return true;
  }
  // straight walk possible between two points (grid ray)
  walkLine(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy), n = Math.ceil(d / 1.0);
    let prev = this.cellOf(x0, y0);
    for (let k = 1; k <= n; k++) {
      const f = k / n, c = this.cellOf(x0 + dx * f, y0 + dy * f);
      if (c === prev) continue;
      if (this.blocked[c] || !this.stepOK(prev, c)) return false;
      prev = c;
    }
    return true;
  }
  // A*; returns array of cells from start to goal (inclusive) or null
  path(sx, sy, gx, gy, maxExp = 40000) {
    const nx = this.nx, N = this.N, b = this.blocked;
    const s = this.nearestOpen(sx, sy), g = this.nearestOpen(gx, gy);
    if (s === g) return [s];
    const ep = ++this.epoch, gS = this.gScore, came = this.came, st = this.stamp, cl = this.closed, heap = this.heap, hf = this.heapF, ex = this.extraCost;
    const gi = g % nx, gj = (g / nx) | 0;
    const H = (c) => { const di = Math.abs((c % nx) - gi), dj = Math.abs(((c / nx) | 0) - gj); return (di > dj ? di + 0.4142 * dj : dj + 0.4142 * di); };
    let hn = 0;
    const push = (c, f) => { let k = hn++; while (k > 0) { const p = (k - 1) >> 1; if (hf[p] <= f) break; heap[k] = heap[p]; hf[k] = hf[p]; k = p; } heap[k] = c; hf[k] = f; };
    const pop = () => { const top = heap[0]; const c = heap[--hn], f = hf[hn]; let k = 0; for (;;) { let m = 2 * k + 1; if (m >= hn) break; if (m + 1 < hn && hf[m + 1] < hf[m]) m++; if (hf[m] >= f) break; heap[k] = heap[m]; hf[k] = hf[m]; k = m; } heap[k] = c; hf[k] = f; return top; };
    gS[s] = 0; st[s] = ep; came[s] = -1; push(s, H(s));
    let exp = 0, found = false, bestC = s, bestH = H(s);
    while (hn) {
      const c = pop();
      if (cl[c] === ep) continue; cl[c] = ep;
      if (c === g) { found = true; break; }
      if (++exp > maxExp) break;
      const h = H(c); if (h < bestH) { bestH = h; bestC = c; }
      const i = c % nx, gc = gS[c];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di; if (ii < 0 || ii >= nx) continue;
        const n = c + dj * nx + di; if (n < 0 || n >= N) continue;
        if (b[n] || cl[n] === ep) continue;
        if (di && dj && (b[c + di] || b[c + dj * nx])) continue; // no corner cutting
        if (this.ground[n] - this.ground[c] > (di && dj ? 3.1 : 2.3)) continue;
        let w = (di && dj ? 1.4142 : 1) + (this.nearWall[n] <= 1 ? 0.6 : this.nearWall[n] === 2 ? 0.2 : 0);
        if (ex) w += ex[n];
        const ng = gc + w;
        if (st[n] !== ep || ng < gS[n]) { gS[n] = ng; st[n] = ep; came[n] = c; push(n, ng + H(n)); }
      }
    }
    let c = found ? g : bestC; const out = [];
    while (c !== -1) { out.push(c); c = came[c]; }
    out.reverse();
    return out;
  }
}
