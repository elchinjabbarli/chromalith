/**
 * Decorative canvas FX: win-screen celebration (static one-shot draw).
 * Pure canvas, no assets. The menu background is pure CSS (see style.css).
 */

import { Renderer } from './renderer';

/** Celebration canvas for the win panel: Lumo + crystal trio + beams. */
export function drawWinFx(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = 320;
  const H = 200;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const r = new Renderer(canvas);
  r.cell = 48;
  r.ox = 0;
  r.oy = 0;

  // radial rays behind Lumo
  const t = 0;
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * 2 * i) / 10 + t;
    const grad = ctx.createLinearGradient(W / 2, H / 2, W / 2 + Math.cos(a) * 160, H / 2 + Math.sin(a) * 160);
    grad.addColorStop(0, 'rgba(255,235,160,0.16)');
    grad.addColorStop(1, 'rgba(255,235,160,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 + Math.cos(a) * 160, H / 2 + Math.sin(a) * 160);
    ctx.stroke();
  }
  // three little crystals
  const crystals: [number, number, string][] = [
    [W / 2 - 90, H / 2 + 26, '#ff5566'],
    [W / 2 + 90, H / 2 + 26, '#4d9dff'],
    [W / 2, H / 2 + 44, '#2ee6d6'],
  ];
  for (const [cx, cy, col] of crystals) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k - Math.PI / 6;
      const px = Math.cos(a) * 15;
      const py = Math.sin(a) * 15;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.restore();
  }
  // beams from crystals to Lumo
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const [cx, cy, col] of crystals) {
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(W / 2, H / 2 - 26);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  r.time = 0;
  r.drawLumo(W / 2, H / 2 - 30, 'cheer', 1.6);
}
