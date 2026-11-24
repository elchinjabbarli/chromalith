/**
 * Canvas renderer — draws the board, devices, beams, particles and Lumo.
 * Everything is drawn procedurally (no image assets).
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
}

export interface FloatText {
  x: number; y: number; text: string; life: number; color: string;
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  cell = 48;
  ox = 0;
  oy = 0;
  particles: Particle[] = [];
  floats: FloatText[] = [];
  time = 0;
  hintCells = new Set<number>();
  hintPulse = 0;
  solvedFlash = 0;
  /** active line slide (drag preview + commit glide), conveyor-style */
  slide: SlideState | null = null;
  /** beams dim while a line slides (eased in step()) */
  beamFade = 1;
  private lumoBlink = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  layout(b: Board, dpr: number): void {
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
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
    // beams dim while sliding (but stay faintly visible), restore after
    const target = this.slide ? 0.45 : 1;
    this.beamFade += (target - this.beamFade) * Math.min(1, dt * 14);
    if (this.beamFade > 0.995) this.beamFade = 1;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 40 * dt;
      p.vx *= 0.99;
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const f of this.floats) {
      f.life -= dt;
      f.y -= 26 * dt;
    }
    this.floats = this.floats.filter(f => f.life > 0);
  }

  burst(cx: number, cy: number, color: string, n = 14, speed = 90): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30,
        life: 0.5 + Math.random() * 0.5, maxLife: 1,
        color, size: 2 + Math.random() * 3,
      });
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

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

    this.drawParticles();
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
    // soft vignette board plate
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(10,14,26,0.55)';
    roundRect(ctx, this.ox - 8, this.oy - 8, b.w * this.cell + 16, b.h * this.cell + 16, 14);
    ctx.fill();
    ctx.restore();

    // checker cells
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const even = (x + y) % 2 === 0;
        ctx.fillStyle = even ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
        roundRect(ctx, this.ox + x * this.cell + 1.5, this.oy + y * this.cell + 1.5, this.cell - 3, this.cell - 3, 8);
        ctx.fill();
      }
    }
    void biome;
  }

  private drawBeams(sim: SimResult): void {
    const { ctx } = this;
    if (this.beamFade <= 0.02) return; // safety only (target floor is 0.45)
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha *= this.beamFade;

    const px = (v: number): number => this.ox + v * this.cell;
    const py = (v: number): number => this.oy + v * this.cell;
    for (const sp of sim.spans) {
      const color = COLOR_HEX[sp.c] ?? '#fff';
      const x1 = px(sp.x1);
      const y1 = py(sp.y1);
      const x2 = px(sp.x2);
      const y2 = py(sp.y2);
      // glow pass
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(6, this.cell * 0.16);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // core pass
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = Math.max(2, this.cell * 0.055);
      ctx.strokeStyle = mixHex(color, '#ffffff', 0.55);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
    // traveling sparkles
    if (sim.segs.length > 0 && Math.random() < 0.3) {
      const s = sim.segs[Math.floor(Math.random() * sim.segs.length)];
      const { cx, cy } = this.cellCenter(s.x, s.y);
      this.particles.push({
        x: cx, y: cy, vx: 0, vy: 0, life: 0.5, maxLife: 0.5,
        color: COLOR_HEX[s.c] ?? '#fff', size: 1.6,
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
        ctx.fillStyle = 'rgba(30,36,52,0.9)';
        roundRect(ctx, cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.76, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      }

      case 'mirror': {
        const col = lit ? '#ffffff' : '#9fb4d8';
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(c.dir === 0 ? -Math.PI / 4 : Math.PI / 4);
        ctx.fillStyle = lit ? 'rgba(255,255,255,0.95)' : 'rgba(159,180,216,0.8)';
        if (lit) {
          ctx.shadowColor = '#fff';
          ctx.shadowBlur = 12;
        }
        roundRect(ctx, -s * 0.30, -s * 0.055, s * 0.60, s * 0.11, 3);
        ctx.fill();
        ctx.restore();
        break;
      }

      case 'splitter': {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(c.dir === 0 ? -Math.PI / 4 : Math.PI / 4);
        ctx.fillStyle = lit ? 'rgba(190,240,255,0.95)' : 'rgba(120,170,200,0.75)';
        if (lit) { ctx.shadowColor = '#bfefff'; ctx.shadowBlur = 12; }
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
        if (lit) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
        roundRect(ctx, cx - s * 0.30, cy - s * 0.30, s * 0.60, s * 0.60, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        // glass shine
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.2, cy - s * 0.02);
        ctx.lineTo(cx - s * 0.02, cy - s * 0.2);
        ctx.lineTo(cx + s * 0.06, cy - s * 0.2);
        ctx.lineTo(cx - s * 0.12, cy + s * 0.02);
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
        if (lit) { ctx.shadowColor = '#d0fff0'; ctx.shadowBlur = 16; }
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
        ctx.fillStyle = got ? col : 'rgba(143,163,200,0.7)';
        if (got) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
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
        const pulse = exact ? 1 + 0.05 * Math.sin(this.time * 5) : 1;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(pulse, pulse);
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
          ctx.shadowBlur = 18;
          ctx.fillStyle = colW;
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
        // inner facet
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = (Math.PI * 2 / 3) * k - Math.PI / 6;
          const px = Math.cos(a) * s * 0.17;
          const py = Math.sin(a) * s * 0.17;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = exact ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.restore();
        break;
      }

      case 'source': {
        const col = COLOR_HEX[c.color] ?? '#fff';
        ctx.save();
        ctx.translate(cx, cy);
        // housing
        ctx.fillStyle = 'rgba(24,30,48,0.95)';
        roundRect(ctx, -s * 0.34, -s * 0.34, s * 0.68, s * 0.68, 9);
        ctx.fill();
        ctx.strokeStyle = hexA(col, 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
        // glowing core
        ctx.shadowColor = col;
        ctx.shadowBlur = 14;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.15 * (1 + 0.08 * Math.sin(this.time * 4 + idx)), 0, Math.PI * 2);
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

  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
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
    // aura
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    g.addColorStop(0, 'rgba(255,244,200,0.9)');
    g.addColorStop(0.5, 'rgba(255,220,130,0.25)');
    g.addColorStop(1, 'rgba(255,220,130,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    // body — teardrop
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.quadraticCurveTo(10, -2, 8, 7);
    ctx.quadraticCurveTo(5, 13, 0, 13);
    ctx.quadraticCurveTo(-5, 13, -8, 7);
    ctx.quadraticCurveTo(-10, -2, 0, -13);
    ctx.closePath();
    ctx.fillStyle = '#fff3c4';
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
    // spark
    if (happy === 'cheer') {
      const a = t * 5;
      for (let k = 0; k < 3; k++) {
        const ang = a + (k * Math.PI * 2) / 3;
        ctx.fillStyle = 'rgba(255,235,150,0.9)';
        star4(ctx, Math.cos(ang) * 20, Math.sin(ang) * 14 - 4, 2.6);
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
