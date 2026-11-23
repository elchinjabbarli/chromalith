/**
 * Menu logo — a small canvas emblem: crystal + converging beams, drawn once.
 * Mirrors the app icon design so the storefront and menu feel unified.
 */

const RED = '#ff5566';
const GREEN = '#2bd97b';
const BLUE = '#4d9dff';

export function drawMenuLogo(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 360;
  const H = 170;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H * 0.44;
  const L = 64;

  // soft aura
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 78);
  g.addColorStop(0, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 78, 0, Math.PI * 2);
  ctx.fill();

  // three beams converging on the crystal
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 7;
  ctx.strokeStyle = RED;
  ctx.beginPath(); ctx.moveTo(cx - L, cy - L * 0.55); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.strokeStyle = GREEN;
  ctx.beginPath(); ctx.moveTo(cx + L * 0.6, cy + L * 0.85); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.strokeStyle = BLUE;
  ctx.beginPath(); ctx.moveTo(cx + L, cy - L * 0.55); ctx.lineTo(cx, cy); ctx.stroke();

  // beam glow pass
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 16;
  ctx.strokeStyle = RED;
  ctx.beginPath(); ctx.moveTo(cx - L, cy - L * 0.55); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.strokeStyle = GREEN;
  ctx.beginPath(); ctx.moveTo(cx + L * 0.6, cy + L * 0.85); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.strokeStyle = BLUE;
  ctx.beginPath(); ctx.moveTo(cx + L, cy - L * 0.55); ctx.lineTo(cx, cy); ctx.stroke();

  // crystal (hexagon, white core)
  ctx.globalAlpha = 1;
  const r = 26;
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 22;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k - Math.PI / 6;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  // facet
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = (Math.PI * 2 / 3) * k - Math.PI / 6;
    const px = cx + Math.cos(a) * r * 0.5;
    const py = cy + Math.sin(a) * r * 0.5;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(210,230,255,0.9)';
  ctx.fill();

  // small orbiting sparks
  const palette = [RED, GREEN, BLUE];
  for (let i = 0; i < 3; i++) {
    const a = (Math.PI * 2 * i) / 3 + 0.6;
    const sx = cx + Math.cos(a) * 52;
    const sy = cy + Math.sin(a) * 30 - 6;
    ctx.fillStyle = palette[i];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
