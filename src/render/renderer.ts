/**
 * Canvas renderer — draws the board, devices, beams, particles and Lumo.
 * Everything is drawn procedurally (no image assets).
 *
 * v1.4 "Radiance" upgrade:
 *  - three-pass beams (wide bloom + color body + white-hot core) with
 *    flowing energy dashes and endpoint star glints
 *  - faceted gems with specular highlights, solved crystals that beam light
 *    upward (pillar) and pop with shockwave rings
 *  - parallax starfield + drifting nebula behind the board, biome-tinted
 *  - quality tier auto-degrades on slow devices (particle caps, star count)
 */

import { Board, Cell, Color, COLOR_HEX } from '../core/grid';
import { SimResult, BeamSeg } from '../core/sim';
import { Biome } from '../core/difficulty';

/** A line currently sliding (drag or commit glide), drawn as a conveyor. */
export interface SlideState {
  axis: 0 | 1;
  index: number;
  /** movable cell indices of the line, in line order */
  slots: number[];
  /** line-coordinate (col for rows, row for cols) of each slot */
  positions: number[];
  /** current visual offset per slot, in CELLS (conveyor-wrapped when drawn) */
  offsets: number[];
  /** cells excluded from the static pass while sliding */
  skip: Set<number>;
}

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string; size: number;
  /** v1.4: sparkle particles render as 4-point stars, circles otherwise */
  star?: boolean;
  /** v1.4: no gravity for sparkle dust (floaty) */
  floaty?: boolean;
}

export interface FloatText {
  x: number; y: number; text: string; life: number; color: string;
}

/** v1.4: expanding shockwave ring. */
export interface Ring {
  x: number; y: number; r: number; maxR: number;
  life: number; maxLife: number; color: string; width: number;
}

/** v1.4: quality tier, degrades automatically when FPS is low. */
export type Quality = 'high' | 'medium' | 'low';

interface Star {
  x: number; y: number; z: number; tw: number; size: number;
}

const MAX_PARTICLES = 220;

export class Renderer {
  ctx: CanvasRenderingContext2D;
  cell = 48;
  ox = 0;
  oy = 0;
  particles: Particle[] = [];
  floats: FloatText[] = [];
  rings: Ring[] = [];
  time = 0;
  hintCells = new Set<number>();
  hintPulse = 0;
  solvedFlash = 0;
  /** active line slide (drag preview + commit glide), conveyor-style */
  slide: SlideState | null = null;
  /** beams dim while a line slides (eased in step()) */
  beamFade = 1;
  /** v1.4: screen shake (magnitude in px, decays) */
  shake = 0;
  /** v1.4: full-board win flash */
  winFlash = 0;
  /** v1.4: canvas size in CSS px (for starfield) */
  private vw = 0;
  private vh = 0;
  private stars: Star[] = [];
  private starBiome = '';
  private lumoBlink = 0;
  /** v1.4: quality tier + rolling FPS average */
  quality: Quality = 'high';
  private fpsAvg = 60;
  private lowFpsStreak = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  layout(b: Board, dpr: number): void {
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    this.vw = W;
    this.vh = H;
    this.cell = Math.floor(Math.min(W / (b.w + 1.2), H / (b.h + 1.6)));
    this.ox = Math.round((W - this.cell * b.w) / 2);
    this.oy = Math.round((H - this.cell * b.h) / 2 + this.cell * 0.18);
  }

  cellCenter(x: number, y: number): { cx: number; cy: number } {
    return { cx: this.ox + x * this.cell + this.cell / 2, cy: this.oy + y * this.cell + this.cell / 2 };
  }

  cellAtPoint(px: number, py: number, b: Board): { x: number; y: number } | null {
    const x = Math.floor((px - this.ox) / this.cell);
    const y = Math.floor((py - this.oy) / this.cell);
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return null;
    return { x, y };
  }

  step(dt: number): void {
    this.time += dt;
    this.lumoBlink += dt;
    if (this.hintPulse > 0) this.hintPulse = Math.max(0, this.hintPulse - dt);
    if (this.solvedFlash > 0) this.solvedFlash = Math.max(0, this.solvedFlash - dt);
    if (this.winFlash > 0) this.winFlash = Math.max(0, this.winFlash - dt * 1.4);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 26);
    // beams dim while sliding (but stay faintly visible), restore after
    const target = this.slide ? 0.45 : 1;
    this.beamFade += (target - this.beamFade) * Math.min(1, dt * 14);
    if (this.beamFade > 0.995) this.beamFade = 1;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (!p.floaty) {
        p.vy += 40 * dt;
        p.vx *= 0.99;
      } else {
        p.vx *= 0.985;
        p.vy *= 0.985;
      }
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const r of this.rings) {
      r.life -= dt;
      const k = 1 - r.life / r.maxLife;
      r.r = r.maxR * (1 - Math.pow(1 - k, 2.2));
    }
    this.rings = this.rings.filter(r => r.life > 0);
    for (const f of this.floats) {
      f.life -= dt;
      f.y -= 26 * dt;
    }
    this.floats = this.floats.filter(f => f.life > 0);
    // quality monitor: sustained <45fps degrades, >55fps for long recovers
    const fps = dt > 0 ? 1 / dt : 60;
    this.fpsAvg += (fps - this.fpsAvg) * 0.04;
    if (this.fpsAvg < 45 && dt > 0.001) this.lowFpsStreak += dt; else this.lowFpsStreak = 0;
    if (this.lowFpsStreak > 2 && this.quality === 'high') { this.quality = 'medium'; this.lowFpsStreak = 0; }
    else if (this.lowFpsStreak > 2 && this.quality === 'medium') { this.quality = 'low'; this.lowFpsStreak = 0; }
    else if (this.fpsAvg > 55 && this.quality === 'low') { this.quality = 'medium'; this.lowFpsStreak = 0; }
    else if (this.fpsAvg > 57 && this.quality === 'medium') {
      // recovered: climb back up (stars rebuild at the new tier)
      this.quality = 'high';
      this.lowFpsStreak = 0;
    }
  }

  burst(cx: number, cy: number, color: string, n = 14, speed = 90): void {
    n = Math.round(n * (this.quality === 'high' ? 1 : this.quality === 'medium' ? 0.65 : 0.4));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30,
        life: 0.5 + Math.random() * 0.5, maxLife: 1,
        color, size: 2 + Math.random() * 3,
        star: Math.random() < 0.4, floaty: Math.random() < 0.3,
      });
    }
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  /** v1.4: expanding shockwave ring. */
  ring(cx: number, cy: number, maxR: number, color: string, width = 3): void {
    if (this.quality === 'low') return;
    this.rings.push({ x: cx, y: cy, r: 0, maxR, life: 0.55, maxLife: 0.55, color, width });
  }

  /** v1.4: celebratory fountain — gem-colored sparks + rings + shake. */
  celebrate(cx: number, cy: number, colors: string[]): void {
    for (const col of colors) {
      this.burst(cx, cy, col, 22, 160);
    }
    this.ring(cx, cy, this.cell * 1.6, colors[0] ?? '#fff', 4);
    this.ring(cx, cy, this.cell * 2.4, '#ffffff', 2);
    this.shake = Math.max(this.shake, 5);
  }

  /** v1.4: big win celebration across the board. */
  winBlast(w: number, h: number, biome: Biome): void {
    this.winFlash = 1;
    this.shake = Math.max(this.shake, 9);
    for (let i = 0; i < 8; i++) {
      const x = this.ox + (Math.random() * w) * this.cell;
      const y = this.oy + (Math.random() * h) * this.cell;
      this.ring(x, y, this.cell * (1.5 + Math.random()), i % 2 ? biome.accent : '#ffe9a8', 3);
      this.burst(x, y, i % 2 ? biome.accent : '#ffe9a8', 14, 130);
    }
  }

  float(cx: number, cy: number, text: string, color = '#fff'): void {
    this.floats.push({ x: cx, y: cy, text, life: 1.1, color });
  }

  /* -------------------------------------------------------------- */

  draw(b: Board, sim: SimResult, biome: Biome, solvedSet?: Set<number>): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    if (W !== this.vw || H !== this.vh) { this.vw = W; this.vh = H; this.stars = []; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // screen shake — decaying random offset applied to everything below
    const sh = this.shake;
    if (sh > 0.1) {
      ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    }

    this.drawBackdrop(b, biome);
    this.drawBoardBase(b, biome);

    // beams under devices, dimmed (not hidden) while sliding
    this.drawBeams(sim);

    const slide = this.slide;

    // static pass: every cell except the sliding line's movable slots
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const i = y * b.w + x;
        if (slide && slide.skip.has(i)) continue;
        const lit = sim.litCells.has(i);
        this.drawCell(b.cells[i], x, y, lit, sim.sinkHits.get(i), i, solvedSet);
      }
    }

    if (slide) {
      // sliding strip ON TOP of everything, softly lifted: wrap copies
      // (linePos ± len) make cells leaving one edge re-enter at the other,
      // clipped to the board plate so nothing leaks outside
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;
      this.clipLine(b, slide);
      const len = slide.axis === 0 ? b.w : b.h;
      for (let j = 0; j < slide.slots.length; j++) {
        const idx = slide.slots[j];
        const pos = slide.positions[j];
        const x = slide.axis === 0 ? pos : slide.index;
        const y = slide.axis === 0 ? slide.index : pos;
        const lit = sim.litCells.has(idx);
        for (const k of [-1, 0, 1, -2, 2]) {
          const linePos = pos + slide.offsets[j] + k * len;
          if (linePos < -1 || linePos >= len) continue;
          const dx = slide.axis === 0 ? (linePos - pos) * this.cell : 0;
          const dy = slide.axis === 1 ? (linePos - pos) * this.cell : 0;
          this.drawCell(b.cells[idx], x, y, lit, sim.sinkHits.get(idx), idx, solvedSet, dx, dy);
        }
      }
      ctx.restore();
    }

    // hint highlight
    if (this.hintCells.size > 0 && this.hintPulse > 0) {
      const a = 0.25 + 0.35 * Math.sin(this.time * 6);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(255, 230, 120, ${a.toFixed(3)})`;
      for (const i of this.hintCells) {
        const x = i % b.w;
        const y = Math.floor(i / b.w);
        ctx.strokeRect(this.ox + x * this.cell + 3, this.oy + y * this.cell + 3, this.cell - 6, this.cell - 6);
      }
    }

    this.drawRings();
    this.drawParticles();

    // full-board win flash overlay
    if (this.winFlash > 0.01) {
      ctx.globalAlpha = 0.32 * this.winFlash;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-20, -20, W + 40, H + 40);
      ctx.globalAlpha = 1;
    }
  }

  /* -------------------------------------------------------------- */
  /* backdrop: biome-tinted starfield + soft nebula                 */

  private ensureStars(biome: Biome): void {
    const key = biome.key + '@' + Math.round(this.vw) + 'x' + Math.round(this.vh) + '@' + this.quality;
    if (this.starBiome === key) return;
    this.starBiome = key;
    const count = this.quality === 'high' ? 90 : this.quality === 'medium' ? 55 : 26;
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: Math.random() * this.vw,
        y: Math.random() * this.vh,
        z: 0.3 + Math.random() * 0.7,           // parallax depth
        tw: Math.random() * Math.PI * 2,        // twinkle phase
        size: 0.6 + Math.random() * 1.4,
      });
    }
  }

  private drawBackdrop(b: Board, biome: Biome): void {
    const { ctx } = this;
    this.ensureStars(biome);

    // soft radial glow behind the board, biome-tinted
    const cx = this.ox + (b.w * this.cell) / 2;
    const cy = this.oy + (b.h * this.cell) / 2;
    const R = Math.max(this.vw, this.vh) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, this.cell, cx, cy, R);
    g.addColorStop(0, hexA(biome.accent, 0.10));
    g.addColorStop(0.5, hexA(biome.accent, 0.035));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.vw, this.vh);

    // parallax stars — slow drift + twinkle
    const drift = this.time * 4;
    for (const s of this.stars) {
      const y = (s.y + drift * s.z) % (this.vh + 20) - 10;
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.time * (0.8 + s.z) + s.tw));
      ctx.globalAlpha = tw * 0.5 * s.z;
      ctx.fillStyle = '#dfe8ff';
      ctx.beginPath();
      ctx.arc(s.x, y, s.size * s.z, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Clip to the board plate so sliding cells never leak outside it. */
  private clipLine(b: Board, slide: SlideState): void {
    const { ctx } = this;
    const pad = 2;
    ctx.beginPath();
    if (slide.axis === 0) {
      const y0 = this.oy + slide.index * this.cell;
      ctx.rect(this.ox - pad, y0 - pad, b.w * this.cell + pad * 2, this.cell + pad * 2);
    } else {
      const x0 = this.ox + slide.index * this.cell;
      ctx.rect(x0 - pad, this.oy - pad, this.cell + pad * 2, b.h * this.cell + pad * 2);
    }
    ctx.clip();
  }

  private drawBoardBase(b: Board, biome: Biome): void {
    const { ctx } = this;
    const s = this.cell;

    // deep plate with biome tint + layered glow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 24;
    const plate = ctx.createLinearGradient(0, this.oy - 8, 0, this.oy + b.h * s + 8);
    plate.addColorStop(0, hexA(biome.accent, 0.06));
    plate.addColorStop(0.5, 'rgba(10,14,26,0.62)');
    plate.addColorStop(1, 'rgba(8,11,20,0.72)');
    ctx.fillStyle = plate;
    roundRect(ctx, this.ox - 8, this.oy - 8, b.w * s + 16, b.h * s + 16, 14);
    ctx.fill();
    ctx.restore();

    // hairline frame with accent
    ctx.strokeStyle = hexA(biome.accent, 0.22);
    ctx.lineWidth = 1.2;
    roundRect(ctx, this.ox - 8, this.oy - 8, b.w * s + 16, b.h * s + 16, 14);
    ctx.stroke();

    // checker cells — subtle luminous grid
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const even = (x + y) % 2 === 0;
        ctx.fillStyle = even ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
        roundRect(ctx, this.ox + x * s + 1.5, this.oy + y * s + 1.5, s - 3, s - 3, 8);
        ctx.fill();
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* beams: three-pass glow with flowing energy                     */

  private drawBeams(sim: SimResult): void {
    const { ctx } = this;
    if (this.beamFade <= 0.02) return; // safety only (target floor is 0.45)
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha *= this.beamFade;

    const px = (v: number): number => this.ox + v * this.cell;
    const py = (v: number): number => this.oy + v * this.cell;
    const flow = (this.time * 0.9) % 1;

    for (const sp of sim.spans) {
      const color = COLOR_HEX[sp.c] ?? '#fff';
      const x1 = px(sp.x1);
      const y1 = py(sp.y1);
      const x2 = px(sp.x2);
      const y2 = py(sp.y2);

      // pass 1: wide bloom
      ctx.globalAlpha = 0.22 * this.beamFade;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(8, this.cell * 0.22);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // pass 2: color body
      ctx.globalAlpha = 0.85 * this.beamFade;
      ctx.lineWidth = Math.max(3, this.cell * 0.085);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // pass 3: white-hot core
      ctx.globalAlpha = 0.95 * this.beamFade;
      ctx.lineWidth = Math.max(1.5, this.cell * 0.035);
      ctx.strokeStyle = mixHex(color, '#ffffff', 0.7);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // flowing energy dashes toward the far end
      if (this.quality !== 'low') {
        const len = Math.hypot(x2 - x1, y2 - y1);
        const n = Math.max(1, Math.floor(len / (this.cell * 0.9)));
        ctx.save();
        ctx.globalAlpha = 0.55 * this.beamFade;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, this.cell * 0.03);
        for (let i = 0; i < n; i++) {
          const t0 = ((i + flow) / n) % 1;
          const t1 = Math.min(1, t0 + 0.5 / n);
          ctx.beginPath();
          ctx.moveTo(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0);
          ctx.lineTo(x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // endpoint star glints (source emitters + sink entries)
    if (this.quality === 'high') {
      for (const sp of sim.spans) {
        const color = COLOR_HEX[sp.c] ?? '#fff';
        const gx = px(sp.x2);
        const gy = py(sp.y2);
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 6 + sp.x2 + sp.y2);
        ctx.globalAlpha = 0.5 * this.beamFade * pulse;
        ctx.fillStyle = '#ffffff';
        star4(ctx, gx, gy, this.cell * 0.11);
      }
    }
    ctx.restore();

    // ambient sparkle dust along random segments
    const dust = this.quality === 'high' ? 0.3 : this.quality === 'medium' ? 0.15 : 0;
    if (sim.segs.length > 0 && Math.random() < dust) {
      const s = sim.segs[Math.floor(Math.random() * sim.segs.length)];
      const { cx, cy } = this.cellCenter(s.x, s.y);
      this.particles.push({
        x: cx, y: cy, vx: (Math.random() - 0.5) * 12, vy: -6 - Math.random() * 10,
        life: 0.6, maxLife: 0.6,
        color: COLOR_HEX[s.c] ?? '#fff', size: 1.6, star: true, floaty: true,
      });
    }
  }

  private drawCell(
    c: Cell, x: number, y: number, lit: boolean, hit: Color | undefined,
    idx: number, solvedSet?: Set<number>, dx = 0, dy = 0,
  ): void {
    const { ctx } = this;
    const { cx, cy } = this.cellCenter(x, y);
    ctx.save();
    if (dx || dy) ctx.translate(dx, dy);
    const s = this.cell;
    const solved = solvedSet?.has(idx) ?? false;

    switch (c.kind) {
      case 'empty': {
        if (lit) {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          roundRect(ctx, cx - s / 2 + 2, cy - s / 2 + 2, s - 4, s - 4, 8);
          ctx.fill();
        }
        break; // falls through to the shared restore below
      }

      case 'block': {
        // beveled stone
        const g = ctx.createLinearGradient(cx - s * 0.38, cy - s * 0.38, cx + s * 0.38, cy + s * 0.38);
        g.addColorStop(0, 'rgba(44,52,74,0.95)');
        g.addColorStop(1, 'rgba(26,31,46,0.95)');
        ctx.fillStyle = g;
        roundRect(ctx, cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.76, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // top light edge
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.26, cy - s * 0.30);
        ctx.lineTo(cx + s * 0.26, cy - s * 0.30);
        ctx.stroke();
        break;
      }

      case 'mirror': {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(c.dir === 0 ? -Math.PI / 4 : Math.PI / 4);
        // metallic base
        ctx.fillStyle = 'rgba(70,84,116,0.9)';
        roundRect(ctx, -s * 0.32, -s * 0.075, s * 0.64, s * 0.15, 4);
        ctx.fill();
        // reflective face
        const g = ctx.createLinearGradient(-s * 0.30, 0, s * 0.30, 0);
        if (lit) {
          g.addColorStop(0, '#ffffff');
          g.addColorStop(0.5, '#ffffff');
          g.addColorStop(1, '#dfe9ff');
          ctx.shadowColor = '#fff';
          ctx.shadowBlur = 14;
        } else {
          g.addColorStop(0, '#c7d6f2');
          g.addColorStop(0.5, '#8fa3c8');
          g.addColorStop(1, '#c7d6f2');
        }
        ctx.fillStyle = g;
        roundRect(ctx, -s * 0.30, -s * 0.055, s * 0.60, s * 0.11, 3);
        ctx.fill();
        ctx.restore();
        break;
      }

      case 'splitter': {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(c.dir === 0 ? -Math.PI / 4 : Math.PI / 4);
        const g = ctx.createLinearGradient(-s * 0.30, 0, s * 0.30, 0);
        if (lit) {
          g.addColorStop(0, '#ffffff');
          g.addColorStop(1, '#bfefff');
          ctx.shadowColor = '#bfefff';
          ctx.shadowBlur = 14;
        } else {
          g.addColorStop(0, '#a8d4ea');
          g.addColorStop(1, '#6f9cc0');
        }
        ctx.fillStyle = g;
        roundRect(ctx, -s * 0.30, -s * 0.05, s * 0.60, s * 0.10, 3);
        ctx.fill();
        // dashed center line = half-silvered
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(-s * 0.28, 0);
        ctx.lineTo(s * 0.28, 0);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        break;
      }

      case 'filter': {
        const col = COLOR_HEX[c.color] ?? '#fff';
        ctx.globalAlpha = lit ? 0.95 : 0.55;
        ctx.fillStyle = col;
        if (lit) { ctx.shadowColor = col; ctx.shadowBlur = 16; }
        roundRect(ctx, cx - s * 0.30, cy - s * 0.30, s * 0.60, s * 0.60, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        // frame
        ctx.globalAlpha = 1;
        ctx.strokeStyle = hexA(col, lit ? 0.95 : 0.6);
        ctx.lineWidth = 1.6;
        roundRect(ctx, cx - s * 0.30, cy - s * 0.30, s * 0.60, s * 0.60, 6);
        ctx.stroke();
        // double glass shine
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.2, cy - s * 0.02);
        ctx.lineTo(cx - s * 0.02, cy - s * 0.2);
        ctx.lineTo(cx + s * 0.06, cy - s * 0.2);
        ctx.lineTo(cx - s * 0.12, cy + s * 0.02);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.08, cy + s * 0.1);
        ctx.lineTo(cx + s * 0.16, cy + s * 0.02);
        ctx.lineTo(cx + s * 0.2, cy + s * 0.06);
        ctx.lineTo(cx + s * 0.12, cy + s * 0.14);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }

      case 'prism': {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        const g = ctx.createLinearGradient(-s * 0.26, -s * 0.26, s * 0.26, s * 0.26);
        g.addColorStop(0, 'rgba(255,120,140,0.85)');
        g.addColorStop(0.5, 'rgba(140,240,200,0.85)');
        g.addColorStop(1, 'rgba(120,160,255,0.85)');
        ctx.fillStyle = lit ? '#eafffa' : g;
        if (lit) { ctx.shadowColor = '#d0fff0'; ctx.shadowBlur = 18; }
        roundRect(ctx, -s * 0.26, -s * 0.26, s * 0.52, s * 0.52, 5);
        ctx.fill();
        ctx.restore();
        break;
      }

      case 'mixer': {
        const got = hit ?? 0;
        const col = COLOR_HEX[got] ?? '#8fa3c8';
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        const g = ctx.createLinearGradient(-s * 0.26, -s * 0.26, s * 0.26, s * 0.26);
        if (got) {
          g.addColorStop(0, mixHex(col, '#ffffff', 0.3));
          g.addColorStop(1, col);
          ctx.shadowColor = col;
          ctx.shadowBlur = 16;
        } else {
          g.addColorStop(0, 'rgba(120,138,172,0.85)');
          g.addColorStop(1, 'rgba(90,104,134,0.85)');
        }
        ctx.fillStyle = g;
        roundRect(ctx, -s * 0.26, -s * 0.26, s * 0.52, s * 0.52, 5);
        ctx.fill();
        ctx.restore();
        // output arrow
        drawArrow(ctx, cx, cy, c.dir, s * 0.42, 'rgba(255,255,255,0.75)');
        break;
      }

      case 'sink': {
        const want = c.color;
        const got = hit ?? 0;
        const exact = got === want;
        const colW = COLOR_HEX[want] ?? '#fff';
        const colG = COLOR_HEX[got] ?? '#333';
        const pulse = exact ? 1 + 0.06 * Math.sin(this.time * 5 + idx) : 1;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(pulse, pulse);

        // solved: light pillar beaming upward + halo
        if (exact && this.quality !== 'low') {
          const pg = ctx.createLinearGradient(0, -s * 1.15, 0, -s * 0.1);
          pg.addColorStop(0, hexA(colW, 0));
          pg.addColorStop(0.55, hexA(colW, 0.16));
          pg.addColorStop(1, hexA(colW, 0.34));
          ctx.fillStyle = pg;
          ctx.beginPath();
          ctx.moveTo(-s * 0.13, -s * 0.1);
          ctx.lineTo(s * 0.13, -s * 0.1);
          ctx.lineTo(s * 0.05, -s * 1.15);
          ctx.lineTo(-s * 0.05, -s * 1.15);
          ctx.closePath();
          ctx.fill();
        }

        // crystal silhouette (hexagon)
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k - Math.PI / 6;
          const px = Math.cos(a) * s * 0.34;
          const py = Math.sin(a) * s * 0.34;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        if (exact) {
          ctx.shadowColor = colW;
          ctx.shadowBlur = 22;
          const gg = ctx.createLinearGradient(cx - s * 0.2, cy - s * 0.3, cx + s * 0.2, cy + s * 0.3);
          gg.addColorStop(0, mixHex(colW, '#ffffff', 0.45));
          gg.addColorStop(1, colW);
          ctx.fillStyle = gg;
        } else if (got !== 0) {
          ctx.fillStyle = colG;
          ctx.shadowColor = colG;
          ctx.shadowBlur = 8;
        } else {
          ctx.fillStyle = 'rgba(40,48,70,0.9)';
        }
        ctx.fill();
        ctx.strokeStyle = exact ? '#ffffff' : hexA(colW, 0.7);
        ctx.lineWidth = 2;
        ctx.stroke();

        // wrong-color warning ring: lit but not the exact hue
        if (!exact && got !== 0) {
          const wob = 0.5 + 0.5 * Math.sin(this.time * 7);
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.44 + wob * 2, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,107,125,${(0.35 + 0.4 * wob).toFixed(2)})`;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // faceted core: triangle + specular glints
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = (Math.PI * 2 / 3) * k - Math.PI / 6;
          const px = Math.cos(a) * s * 0.17;
          const py = Math.sin(a) * s * 0.17;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = exact ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.12)';
        ctx.fill();
        // edge facets (thin highlight lines from center to corners)
        if (exact) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k - Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * s * 0.33, Math.sin(a) * s * 0.33);
            ctx.stroke();
          }
          // twinkle glint
          const tw = 0.5 + 0.5 * Math.sin(this.time * 3 + idx * 2.1);
          if (tw > 0.7 && this.quality === 'high') {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            star4(ctx, -s * 0.14, -s * 0.15, s * 0.07 * (tw - 0.5) * 2);
          }
        }
        ctx.restore();
        break;
      }

      case 'source': {
        const col = COLOR_HEX[c.color] ?? '#fff';
        ctx.save();
        ctx.translate(cx, cy);
        // housing with gradient
        const hg = ctx.createLinearGradient(-s * 0.34, -s * 0.34, s * 0.34, s * 0.34);
        hg.addColorStop(0, 'rgba(34,42,66,0.98)');
        hg.addColorStop(1, 'rgba(18,23,40,0.98)');
        ctx.fillStyle = hg;
        roundRect(ctx, -s * 0.34, -s * 0.34, s * 0.68, s * 0.68, 9);
        ctx.fill();
        ctx.strokeStyle = hexA(col, 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
        // glowing core with inner gradient
        const cr = s * 0.15 * (1 + 0.08 * Math.sin(this.time * 4 + idx));
        const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, cr * 2.2);
        cg.addColorStop(0, '#ffffff');
        cg.addColorStop(0.4, col);
        cg.addColorStop(1, hexA(col, 0));
        ctx.shadowColor = col;
        ctx.shadowBlur = 16;
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(0, 0, cr * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // direction tick
        drawArrow(ctx, cx, cy, c.dir, s * 0.44, hexA(col, 0.95));
        break;
      }
    }
    // single shared restore: every case above must leave the context balanced
    ctx.restore();
  }

  private drawRings(): void {
    const { ctx } = this;
    for (const r of this.rings) {
      const k = r.life / r.maxLife;
      ctx.globalAlpha = k * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * k + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      if (p.star) {
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 4;
        star4(ctx, p.x, p.y, p.size * 1.7);
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const f of this.floats) {
      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.font = `700 ${Math.round(this.cell * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = f.color;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  /** Lumo — the little light-spirit companion, drawn near a point. */
  drawLumo(x: number, y: number, happy: 'idle' | 'cheer' | 'think', scale = 1): void {
    const { ctx } = this;
    const t = this.time;
    const bob = Math.sin(t * 2.2) * 3;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.scale(scale, scale);
    // aura — breathing glow
    const auraR = 26 + Math.sin(t * 1.6) * 2;
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, auraR);
    g.addColorStop(0, 'rgba(255,244,200,0.9)');
    g.addColorStop(0.5, 'rgba(255,220,130,0.25)');
    g.addColorStop(1, 'rgba(255,220,130,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, auraR, 0, Math.PI * 2);
    ctx.fill();
    // body — teardrop with vertical sheen
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.quadraticCurveTo(10, -2, 8, 7);
    ctx.quadraticCurveTo(5, 13, 0, 13);
    ctx.quadraticCurveTo(-5, 13, -8, 7);
    ctx.quadraticCurveTo(-10, -2, 0, -13);
    ctx.closePath();
    const bodyG = ctx.createLinearGradient(-8, -13, 8, 13);
    bodyG.addColorStop(0, '#fffbdf');
    bodyG.addColorStop(0.5, '#fff3c4');
    bodyG.addColorStop(1, '#ffe9a0');
    ctx.fillStyle = bodyG;
    ctx.shadowColor = 'rgba(255,230,140,0.9)';
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    // eyes
    const blink = Math.sin(this.lumoBlink * 1.3) > 0.985 ? 0.15 : 1;
    ctx.fillStyle = '#2a2440';
    const eyeY = happy === 'cheer' ? -3 : -2;
    ctx.beginPath();
    ctx.ellipse(-3.4, eyeY, 1.5, 2.6 * blink, 0, 0, Math.PI * 2);
    ctx.ellipse(3.4, eyeY, 1.5, 2.6 * blink, 0, 0, Math.PI * 2);
    ctx.fill();
    // eye glints
    if (blink === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(-3.0, eyeY - 0.9, 0.5, 0, Math.PI * 2);
      ctx.arc(3.8, eyeY - 0.9, 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // mouth
    ctx.strokeStyle = '#2a2440';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (happy === 'cheer') {
      ctx.arc(0, 3, 3, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (happy === 'think') {
      ctx.arc(0, 5, 2.2, 1.15 * Math.PI, 1.85 * Math.PI);
    } else {
      ctx.arc(0, 2.5, 2.4, 0.2 * Math.PI, 0.8 * Math.PI);
    }
    ctx.stroke();
    // orbiting sparks
    if (happy === 'cheer') {
      const a = t * 5;
      for (let k = 0; k < 3; k++) {
        const ang = a + (k * Math.PI * 2) / 3;
        ctx.fillStyle = 'rgba(255,235,150,0.9)';
        star4(ctx, Math.cos(ang) * 20, Math.sin(ang) * 14 - 4, 2.6);
      }
    } else {
      // idle: occasional single twinkle
      const tw = Math.sin(t * 1.2);
      if (tw > 0.85) {
        ctx.fillStyle = 'rgba(255,235,150,0.75)';
        star4(ctx, 12 * Math.sign(Math.sin(t * 0.7)), -14, 2.2);
      }
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */

export function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawArrow(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, r: number, color: string,
): void {
  const ang = [0, Math.PI / 2, Math.PI, -Math.PI / 2][d];
  ctx.save();
  ctx.translate(cx + Math.cos(ang) * r * 0.0, cy + Math.sin(ang) * r * 0.0);
  ctx.rotate(ang);
  ctx.translate(r, 0);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(4, 0);
  ctx.lineTo(-2.5, 4);
  ctx.lineTo(-2.5, -4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function star4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (Math.PI / 4) * k;
    const rr = k % 2 === 0 ? r : r * 0.4;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function hex2rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(a: string, b: string, t: number): string {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}

function hexA(hex: string, a: number): string {
  const [r, g, b] = hex2rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
