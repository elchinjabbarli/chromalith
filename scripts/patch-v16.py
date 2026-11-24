#!/usr/bin/env python3
"""v1.6.0 'Photon' — renderer upgrades (aurora ribbons, photon packets,
glass sheen, drag trail, anamorphic flare, shooting star, color grading)."""
import sys

P = 'src/render/renderer.ts'
s = open(P).read()
n_applied = 0

def sub(old, new, label):
    global s, n_applied
    assert old in s, f'ANCHOR NOT FOUND: {label}'
    assert s.count(old) == 1, f'ANCHOR NOT UNIQUE: {label}'
    s = s.replace(old, new, 1)
    n_applied += 1
    print(f'  ok: {label}')

# 1) header comment — v1.6 block
sub(
""" *  - vignette: subtle darkened edges, focuses the eye on the board
 */""",
""" *  - vignette: subtle darkened edges, focuses the eye on the board
 *
 * v1.6 "Photon":
 *  - aurora ribbons: broad soft bands of biome-tinted light slowly waving
 *    behind the starfield
 *  - photon packets: bright beads of light flowing along each beam, fed
 *    into the bloom layer as they travel
 *  - glass sheen: top-edge light + a slow diagonal sweep across the plate
 *  - drag trail: sparkles left behind the line while sliding
 *  - anamorphic win flare: horizontal cinematic light streak on victory
 *  - occasional shooting star streaking across the sky
 *  - biome color grading baked into the vignette (soft corner tint)
 */""",
'header v1.6')

# 2) types after MOTE_COUNTS
sub(
"""const MOTE_COUNTS: Record<Quality, number> = { high: 22, medium: 14, low: 0 };""",
"""const MOTE_COUNTS: Record<Quality, number> = { high: 22, medium: 14, low: 0 };

/** v1.6: aurora ribbon — a broad soft band of light waving in the sky. */
interface Ribbon {
  baseY: number; amp: number; freq: number; speed: number;
  width: number; alpha: number; color: string; phase: number;
}

/** v1.6: shooting star with a glowing tail. */
interface Shoot { x: number; y: number; vx: number; vy: number; life: number; }

/** v1.6: ribbon count per quality tier. */
const RIBBON_COUNTS: Record<Quality, number> = { high: 3, medium: 2, low: 0 };""",
'types')

# 3) fields — vignette key swap + new v1.6 fields
sub(
"""  /** v1.5: cached vignette (rebuilt only when the canvas size changes) */
  private vignetteCanvas: HTMLCanvasElement | null = null;
  private vignetteW = 0;
  private vignetteH = 0;""",
"""  /** v1.5: cached vignette (rebuilt only when size or biome changes) */
  private vignetteCanvas: HTMLCanvasElement | null = null;
  private vignetteKey = '';
  /** v1.6: aurora ribbons + shooting star */
  private ribbons: Ribbon[] = [];
  private ribbonBiome = '';
  private shoot: Shoot | null = null;
  private nextShoot = 6;
  /** v1.6: anamorphic win flare (1→0), horizontal streak at flareY */
  private flare = 0;
  private flareY = 0;""",
'fields')

# 4) ensureVignette — biome param + grading tint
sub(
"""  /** (Re)build the cached vignette layer for the current size. */
  private ensureVignette(W: number, H: number): void {
    if (this.vignetteCanvas && this.vignetteW === W && this.vignetteH === H) return;
    this.vignetteW = W;
    this.vignetteH = H;
    const c = this.vignetteCanvas ?? document.createElement('canvas');
    c.width = Math.max(1, Math.round(W));
    c.height = Math.max(1, Math.round(H));
    const g = c.getContext('2d')!;
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,4,10,0.42)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    this.vignetteCanvas = c;
  }""",
"""  /** (Re)build the cached vignette layer for the current size + biome. */
  private ensureVignette(W: number, H: number, biome: Biome): void {
    const key = Math.round(W) + 'x' + Math.round(H) + '@' + biome.key;
    if (this.vignetteCanvas && this.vignetteKey === key) return;
    this.vignetteKey = key;
    const c = this.vignetteCanvas ?? document.createElement('canvas');
    c.width = Math.max(1, Math.round(W));
    c.height = Math.max(1, Math.round(H));
    const g = c.getContext('2d')!;
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,4,10,0.42)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    // v1.6: biome color grading — a soft accent tint toward the corners,
    // baked in so the per-frame blit stays a single drawImage
    const tint = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    tint.addColorStop(0, 'rgba(0,0,0,0)');
    tint.addColorStop(1, hexA(biome.accent, 0.10));
    g.fillStyle = tint;
    g.fillRect(0, 0, W, H);
    this.vignetteCanvas = c;
  }""",
'ensureVignette grading')

# 5) step(): shooting star spawn/update + flare decay (before quality monitor)
sub(
"""    // quality monitor: sustained <45fps degrades, >55fps for long recovers""",
"""    // v1.6: occasional shooting star
    this.nextShoot -= dt;
    if (this.nextShoot <= 0) {
      this.nextShoot = 9 + Math.random() * 14;
      if (this.quality !== 'low' && this.vw > 0) {
        const fromLeft = Math.random() < 0.5;
        this.shoot = {
          x: fromLeft ? -30 : this.vw + 30,
          y: 10 + Math.random() * this.vh * 0.35,
          vx: (fromLeft ? 1 : -1) * (260 + Math.random() * 140),
          vy: 90 + Math.random() * 60,
          life: 1.4,
        };
      }
    }
    if (this.shoot) {
      const sh = this.shoot;
      sh.x += sh.vx * dt; sh.y += sh.vy * dt; sh.life -= dt;
      if (sh.life <= 0 || sh.x < -60 || sh.x > this.vw + 60 || sh.y > this.vh + 60) this.shoot = null;
    }
    // v1.6: anamorphic flare decay
    if (this.flare > 0) this.flare = Math.max(0, this.flare - dt * 1.8);
    // quality monitor: sustained <45fps degrades, >55fps for long recovers""",
'step shooting star + flare')

# 6) winBlast: trigger flare
sub(
"""  winBlast(w: number, h: number, biome: Biome): void {
    this.winFlash = 1;
    this.shake = Math.max(this.shake, 9);""",
"""  winBlast(w: number, h: number, biome: Biome): void {
    this.winFlash = 1;
    this.shake = Math.max(this.shake, 9);
    this.flare = 1; // v1.6: anamorphic streak across the board
    this.flareY = this.oy + (h * this.cell) / 2;""",
'winBlast flare')

# 7) trailSpark public API (before burst)
sub(
"""  burst(cx: number, cy: number, color: string, n = 14, speed = 90): void {""",
"""  /** v1.6: sparkle left behind a dragging line (called from pointermove). */
  trailSpark(x: number, y: number, color: string): void {
    if (this.quality === 'low') return;
    if (Math.random() > 0.45) return; // not every move — a light dusting
    this.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 10,
      vy: (Math.random() - 0.5) * 10,
      life: 0.4, maxLife: 0.4,
      color, size: 1.5, star: true, floaty: true,
    });
  }

  burst(cx: number, cy: number, color: string, n = 14, speed = 90): void {""",
'trailSpark')

# 8) drawBackdrop: ribbons before stars
sub(
"""    // parallax stars — slow drift + twinkle""",
"""    // v1.6: aurora ribbons — broad soft bands of light waving in the sky,
    // drawn under the stars for depth. Each ribbon is one stroked sine path.
    this.ensureRibbons(biome);
    if (this.ribbons.length) {
      ctx.save();
      ctx.lineCap = 'round';
      for (const rb of this.ribbons) {
        ctx.strokeStyle = rb.color;
        ctx.lineWidth = rb.width;
        ctx.globalAlpha = rb.alpha;
        ctx.beginPath();
        const segs = 22;
        let lx = -40;
        let ly = rb.baseY + Math.sin(lx * rb.freq + this.time * rb.speed + rb.phase) * rb.amp;
        ctx.moveTo(lx, ly);
        for (let i = 1; i <= segs; i++) {
          const x = -40 + (this.vw + 80) * (i / segs);
          const y = rb.baseY
            + Math.sin(x * rb.freq + this.time * rb.speed + rb.phase) * rb.amp
            + Math.sin(x * rb.freq * 2.3 + this.time * rb.speed * 0.6) * rb.amp * 0.3;
          ctx.quadraticCurveTo(lx, ly, (lx + x) / 2, (ly + y) / 2);
          lx = x; ly = y;
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // parallax stars — slow drift + twinkle""",
'drawBackdrop ribbons')

# 9) drawBackdrop: shooting star after motes (end of function)
sub(
"""      ctx.globalAlpha = 1;
    }
  }

  /** v1.5: (re)build the ambient mote field for the current biome + quality. */""",
"""      ctx.globalAlpha = 1;
    }

    // v1.6: occasional shooting star with a glowing tail
    if (this.shoot) {
      const sh = this.shoot;
      const tail = 90;
      const mag = Math.hypot(sh.vx, sh.vy);
      const nx = sh.vx / mag, ny = sh.vy / mag;
      const fade = Math.min(1, sh.life / 0.4);
      const tg = ctx.createLinearGradient(sh.x, sh.y, sh.x - nx * tail, sh.y - ny * tail);
      tg.addColorStop(0, `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`);
      tg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = tg;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(sh.x - nx * tail, sh.y - ny * tail);
      ctx.stroke();
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sh.x, sh.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (this.glowCtx) this.glowBlob(sh.x, sh.y, 26, '#cfe0ff', 0.5);
    }
  }

  /** v1.5: (re)build the ambient mote field for the current biome + quality. */""",
'drawBackdrop shooting star')

# 10) ensureRibbons after ensureMotes
sub(
"""  /** Clip to the board plate so sliding cells never leak outside it. */""",
"""  /** v1.6: (re)build the aurora ribbon set for the current biome + quality. */
  private ensureRibbons(biome: Biome): void {
    const key = biome.key + '@' + this.quality;
    if (this.ribbonBiome === key) return;
    this.ribbonBiome = key;
    const n = RIBBON_COUNTS[this.quality];
    this.ribbons = [];
    if (!n) return;
    // biome accent + two companions: a paler tone and a cool teal
    const colors = [biome.accent, mixHex(biome.accent, '#ffffff', 0.45), '#3ee6c8'];
    for (let i = 0; i < n; i++) {
      this.ribbons.push({
        baseY: this.vh * (0.12 + 0.14 * i) + Math.random() * 30,
        amp: this.cell * (1.2 + Math.random() * 1.1),
        freq: 0.004 + Math.random() * 0.004,
        speed: 0.15 + Math.random() * 0.22,
        width: this.cell * (0.9 + Math.random() * 0.7),
        alpha: 0.05 + Math.random() * 0.035,
        color: colors[i % colors.length],
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Clip to the board plate so sliding cells never leak outside it. */""",
'ensureRibbons')

# 11) drawBoardBase: glass sheen after checkerboard
sub(
"""        ctx.fillStyle = even ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
        roundRect(ctx, this.ox + x * s + 1.5, this.oy + y * s + 1.5, s - 3, s - 3, 8);
        ctx.fill();
      }
    }
  }""",
"""        ctx.fillStyle = even ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
        roundRect(ctx, this.ox + x * s + 1.5, this.oy + y * s + 1.5, s - 3, s - 3, 8);
        ctx.fill();
      }
    }

    // v1.6: glass sheen — a light line along the top edge of the plate plus
    // a slow diagonal sweep across it (clipped so it never leaks outside)
    if (this.quality !== 'low') {
      const px0 = this.ox, py0 = this.oy;
      const pw = b.w * s, ph = b.h * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px0, py0, pw, ph);
      ctx.clip();
      const te = ctx.createLinearGradient(0, py0, 0, py0 + 10);
      te.addColorStop(0, 'rgba(255,255,255,0.13)');
      te.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = te;
      ctx.fillRect(px0, py0, pw, 10);
      const sweep = Math.sin(this.time * 0.4) * 0.5 + 0.5; // 0..1, breathing
      const sx = px0 + (sweep - 0.25) * pw;
      const dg = ctx.createLinearGradient(sx - pw * 0.18, py0, sx + pw * 0.18, py0 + ph);
      dg.addColorStop(0, 'rgba(255,255,255,0)');
      dg.addColorStop(0.5, 'rgba(255,255,255,0.035)');
      dg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = dg;
      ctx.fillRect(px0, py0, pw, ph);
      ctx.restore();
    }
  }""",
'glass sheen')

# 12) drawBeams: photon packets after the dashes, still inside the span loop
sub(
"""        ctx.restore();
      }
    }

    // endpoint star glints (source emitters + sink entries)""",
"""        ctx.restore();
      }

      // v1.6: photon packets — bright beads of light flowing along the
      // beam, accelerating mid-travel, feeding the bloom layer as they go
      if (this.quality === 'high') {
        const hash = ((sp.x1 * 7 + sp.y1 * 13 + sp.x2 * 5) % 10) / 10;
        for (let i = 0; i < 2; i++) {
          const t = (this.time * 0.35 + hash + i / 2) % 1;
          const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const x = x1 + (x2 - x1) * te;
          const y = y1 + (y2 - y1) * te;
          if (this.glowCtx) this.glowBlob(x, y, this.cell * 0.42, color, 0.4);
          ctx.globalAlpha = 0.9 * this.beamFade;
          ctx.fillStyle = mixHex(color, '#ffffff', 0.6);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.5, this.cell * 0.075), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // endpoint star glints (source emitters + sink entries)""",
'photon packets')

# 13) draw(): vignette call with biome + flare before win flash
sub(
"""    // v1.5: vignette — darken the edges, keep focus on the board.
    // Pre-rendered once per resize (see ensureVignette), blitted per frame.
    this.ensureVignette(W, H);
    if (this.vignetteCanvas) {
      ctx.drawImage(this.vignetteCanvas, 0, 0, W, H);
    }

    // full-board win flash overlay""",
"""    // v1.5: vignette — darken the edges, keep focus on the board.
    // Pre-rendered once per resize (see ensureVignette), blitted per frame.
    // v1.6: now also carries the biome color grading (soft corner tint).
    this.ensureVignette(W, H, biome);
    if (this.vignetteCanvas) {
      ctx.drawImage(this.vignetteCanvas, 0, 0, W, H);
    }

    // v1.6: anamorphic win flare — horizontal cinematic light streak
    if (this.flare > 0.01) {
      const k = this.flare;
      const fy = this.flareY;
      const hgt = this.cell * 0.55 * k + 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const fg = ctx.createLinearGradient(0, fy - hgt, 0, fy + hgt);
      fg.addColorStop(0, 'rgba(255,255,255,0)');
      fg.addColorStop(0.5, `rgba(255,255,255,${(0.5 * k).toFixed(3)})`);
      fg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, fy - hgt, W, hgt * 2);
      ctx.globalAlpha = 0.8 * k;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, fy - 1, W, 2);
      ctx.restore();
    }

    // full-board win flash overlay""",
'draw flare + vignette biome')

open(P, 'w').write(s)
print(f'ALL {n_applied} PATCHES APPLIED ✓')
