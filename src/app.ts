/**
 * App shell — screens, navigation, DOM UI wiring, game loop.
 */

import { Board, makeCell } from './core/grid';
import { simulate, sinkStats } from './core/sim';
import { BIOMES, biomeFor, TOTAL_LEVELS } from './core/difficulty';
import { Renderer } from './render/renderer';
import { Session, Shift } from './session';
import { loadSave, persistSave, SaveState, todayKey } from './systems/save';
import { setLang, getLang, t, Lang, LANGS, isRTL, langMeta } from './systems/i18n';
import { sfx } from './systems/audio';
import { platform, setHapticsEnabled } from './systems/platform';
import {
  HINT_COST, SOLVE_COST, levelGems, starsFor, interstitialEvery, canClaimDaily, applyDaily,
} from './systems/economy';
import { VERSION } from './version';

/* ------------------------------------------------------------------ */
/* level pack loading                                                  */

interface PackedLevel {
  n: number; w: number; h: number; par: number;
  c: number[]; s: number[];
}

const KINDS = ['empty', 'block', 'mirror', 'splitter', 'filter', 'prism', 'mixer', 'sink', 'source'] as const;

function decodeBoard(p: PackedLevel): Board {
  return {
    w: p.w, h: p.h,
    cells: p.c.map(v => makeCell(
      KINDS[v & 15] as Board['cells'][number]['kind'],
      (v >> 4) & 15,
      ((v >> 8) & 15) as 0 | 1 | 2 | 3,
      ((v >> 12) & 1) === 1,
    )),
  };
}

function decodeSolution(p: PackedLevel): Shift[] {
  return p.s.map(v => ({
    axis: ((v >> 12) & 1) as 0 | 1,
    index: (v >> 4) & 255,
    amount: v & 15,
  }));
}

let LEVELS: PackedLevel[] = [];
let packVersion = '';

async function loadLevels(): Promise<void> {
  const res = await fetch('levels.json');
  const pack = await res.json();
  LEVELS = pack.levels;
  packVersion = pack.v;
  if (packVersion !== VERSION) {
    console.warn(`level pack version ${packVersion} != app ${VERSION}`);
  }
}

/* ------------------------------------------------------------------ */
/* globals                                                             */

let save: SaveState;
let renderer: Renderer;
let session: Session | null = null;
// debug handle (read-only, used by automated tests)
Object.defineProperty(window, '__chromalith', {
  value: { get session() { return session; }, get renderer() { return renderer; } },
});
let canvas: HTMLCanvasElement;
let raf = 0;
let lastT = 0;
let completedCount = 0; // for interstitial cadence
/** where the map/settings were opened from, so Back returns correctly */
let returnScreen = 'screen-menu';
let lumoMood: 'idle' | 'cheer' | 'think' = 'idle';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/* ------------------------------------------------------------------ */
/* screens                                                             */

function showScreen(id: string): void {
  for (const s of document.querySelectorAll('.screen')) {
    (s as HTMLElement).classList.toggle('active', s.id === id);
  }
}

/* ------------------------------------------------------------------ */
/* main menu                                                           */

function renderMainMenu(): void {
  const unlocked = save.level;
  const cur = biomeFor(unlocked);
  $('mm-play-label').textContent = unlocked > 1 ? t('continue') : t('play');
  $('mm-level-badge').textContent = `${t('level')} ${unlocked} / ${TOTAL_LEVELS}`;
  $('mm-biome-name').textContent = t(cur.nameKey as never);
  $('mm-progress-label').textContent = `${unlocked} / ${TOTAL_LEVELS}`;
  const mmG = $('mm-gems');
  if (mmG.textContent !== String(save.gems)) {
    mmG.textContent = String(save.gems);
    mmG.classList.remove('pulse');
    void mmG.offsetWidth;
    mmG.classList.add('pulse');
  }
  $('mm-version').textContent = `v${VERSION}`;
}

/** Keep the SVG stage sky gradient in sync with the current biome vars. */
function syncSkyGradient(): void {
  const svgNS = 'http://www.w3.org/2000/svg';
  let def = document.getElementById('sky-grad-def') as SVGLinearGradientElement | null;
  if (!def) {
    // inject once: a linearGradient whose stops read the CSS vars
    def = document.createElementNS(svgNS, 'linearGradient') as SVGLinearGradientElement;
    def.id = 'sky-grad-def';
    def.setAttribute('x1', '0'); def.setAttribute('y1', '0');
    def.setAttribute('x2', '0'); def.setAttribute('y2', '1');
    const s1 = document.createElementNS(svgNS, 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', 'var(--bg3)');
    const s2 = document.createElementNS(svgNS, 'stop');
    s2.setAttribute('offset', '45%'); s2.setAttribute('stop-color', 'var(--bg2)');
    const s3 = document.createElementNS(svgNS, 'stop');
    s3.setAttribute('offset', '100%'); s3.setAttribute('stop-color', 'var(--bg1)');
    def.append(s1, s2, s3);
    document.querySelector('.stage-sky defs')?.appendChild(def);
  }
  // nudge the base rect to re-resolve var() stops (Safari quirk)
  const rect = document.querySelector('.stage-sky rect');
  if (rect) rect.setAttribute('fill', 'url(#sky-grad-def)');
}

function startLevel(n: number): void {
  const p = LEVELS[n - 1];
  if (!p) return;
  const board = decodeBoard(p);
  const biome = biomeFor(n);
  const r = renderer;
  session = new Session(n, board, p.par, decodeSolution(p), biome, r, {
    onWin: (moves, par) => onLevelWon(n, moves, par),
    onSinksChanged: (ok, total) => updateHud(ok, total),
    onShift: () => { save.shiftsTotal++; },
    onLitBad: () => { lumoMood = 'think'; },
  });
  lumoMood = 'idle';
  // biome bg
  const bg = document.body;
  bg.style.setProperty('--bg1', biome.bg[0]);
  bg.style.setProperty('--bg2', biome.bg[1]);
  bg.style.setProperty('--bg3', biome.bg[2]);
  bg.style.setProperty('--accent', biome.accent);
  syncSkyGradient();
  platform.vibrate(12);
  // hud
  $('hud-level').textContent = `${t('level')} ${n}`;
  $('hud-par').textContent = `${t('par')} ${p.par}`;
  $('hud-moves').textContent = `0 ${t('moves')}`;
  $('hud-biome').textContent = t(biome.nameKey as never);
  $('hud-gems').textContent = String(save.gems);
  // first-time biome toast
  if (!save.seenBiomes.includes(biome.range[0])) {
    save.seenBiomes.push(biome.range[0]);
    toast(t('newBiome') + ' — ' + t(biome.nameKey as never), biome.accent);
  }
  sfx.ambient(BIOMES.indexOf(biome));
  showScreen('screen-game');
  requestAnimationFrame(() => {
    layoutCanvas();
    session?.renderer.layout(board, window.devicePixelRatio || 1);
    session?.renderer.revealBoard(); // v1.5: cascade-in on every level start
  });
}

function updateHud(ok: number, total: number): void {
  $('hud-sinks').textContent = `${ok}/${total}`;
  const s = session;
  if (s) $('hud-moves').textContent = `${s.moves} ${t('moves')}`;
  updateHudGems();
}

function updateHudGems(): void {
  const el = $('hud-gems');
  if (el.textContent !== String(save.gems)) {
    el.textContent = String(save.gems);
    el.classList.remove('pulse');
    void el.offsetWidth; // restart animation
    el.classList.add('pulse');
  }
}

/* ------------------------------------------------------------------ */
/* win flow                                                            */

async function onLevelWon(n: number, moves: number, par: number): Promise<void> {
  const sol = session;
  if (!sol || sol.levelNum !== n) return; // stale win from an earlier level
  const stars = sol.usedSolve
    ? 1
    : starsFor(moves, par);
  const prevStars = save.stars[n] ?? 0;
  if (stars > prevStars) save.stars[n] = stars;
  const gained = levelGems(stars, n);
  save.gems += gained;
  if (n >= save.level && n < TOTAL_LEVELS) save.level = n + 1;
  persistSave(save);

  // ad cadence
  completedCount++;
  if (completedCount % interstitialEvery(save) === 0 && !save.adsRemoved) {
    await platform.showInterstitial();
  }

  // UI
  sfx.win();
  lumoMood = 'cheer';
  $('win-title').textContent = stars === 3 ? t('perfect') : stars === 2 ? t('good') : t('ok');
  $('win-sub').textContent = t(`stars${stars}` as never);
  $('win-level').textContent = `${t('level')} ${n}`;
  $('win-moves').textContent = `${moves} ${t('moves')} · ${t('par')} ${par}`;
  for (let i = 1; i <= 3; i++) {
    const el = $('win-star-' + i);
    el.classList.toggle('lit', i <= stars);
    el.classList.remove('pop');
  }
  $('win-gems').textContent = '◆ ' + t('gemsEarned', { n: gained });
  const x2 = $('win-x2');
  x2.classList.remove('hidden');
  const nextBtn = $('win-next');
  const hasNext = n < TOTAL_LEVELS;
  nextBtn.classList.toggle('hidden', !hasNext);
  showScreen('screen-win');
  // star pops
  for (let i = 1; i <= stars; i++) {
    setTimeout(() => {
      $('win-star-' + i).classList.add('pop');
      sfx.star(i);
    }, 350 * i);
  }
  spawnConfetti(stars); // v1.5: canvas confetti behind the win panel
  renderMainMenu();
}

/* ------------------------------------------------------------------ */
/* input: drag to shift                                                */

interface DragState {
  active: boolean;
  startX: number; startY: number;
  cellX: number; cellY: number; // grabbed cell (board coords)
  axis: 0 | 1 | null;
  lineIndex: number;
  dist: number; // accumulated px along axis
  pointerId: number;
}

const drag: DragState = {
  active: false, startX: 0, startY: 0, cellX: -1, cellY: -1,
  axis: null, lineIndex: -1, dist: 0, pointerId: -1,
};

function onPointerDown(e: PointerEvent): void {
  // v1.5: soft ripple wherever the player touches the board
  const rect0 = canvas.getBoundingClientRect();
  touchWaveAt(e.clientX - rect0.left, e.clientY - rect0.top);
  if (!session || session.won) return;
  if (drag.active) return; // second finger while dragging: ignore
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const cellPos = renderer.cellAtPoint(px, py, session.board);
  if (!cellPos) return;
  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.startX = px; drag.startY = py;
  drag.cellX = cellPos.x; drag.cellY = cellPos.y;
  drag.axis = null;
  drag.lineIndex = -1;
  drag.dist = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
}

function onPointerMove(e: PointerEvent): void {
  if (!drag.active || !session) return;
  if (e.pointerId !== drag.pointerId) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const dx = px - drag.startX;
  const dy = py - drag.startY;
  if (drag.axis === null) {
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    // pick the dominant axis; the OTHER coordinate fixes the line
    if (Math.abs(dx) > Math.abs(dy)) {
      drag.axis = 0; // horizontal drag → shift a row
      drag.lineIndex = drag.cellY;
    } else {
      drag.axis = 1;
      drag.lineIndex = drag.cellX;
    }
  }
  const dist = drag.axis === 0 ? dx : dy;
  drag.dist = dist;
  // live conveyor preview follows the finger
  session.dragTo(drag.axis, drag.lineIndex, dist);
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== drag.pointerId) return;
  if (!drag.active || !session) {
    drag.active = false;
    drag.pointerId = -1;
    return;
  }
  drag.active = false;
  drag.pointerId = -1;
  if (drag.axis === null || drag.lineIndex < 0) return;
  session.endDrag(drag.axis, drag.lineIndex, drag.dist);
}

function onPointerCancel(e: PointerEvent): void {
  if (e.pointerId !== drag.pointerId) return;
  drag.active = false;
  drag.pointerId = -1;
  if (session) session.cancelDrag();
}

/* ------------------------------------------------------------------ */
/* toast + simple modal helpers                                        */

function toast(msg: string, color = '#fff'): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  el.style.borderColor = color;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 20);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

function confirmDialog(msg: string): Promise<boolean> {
  return new Promise(resolve => {
    const ov = $('confirm-overlay');
    $('confirm-text').textContent = msg;
    ov.classList.add('show');
    const done = (v: boolean): void => {
      ov.classList.remove('show');
      $('confirm-yes').onclick = null;
      $('confirm-no').onclick = null;
      resolve(v);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

/* ------------------------------------------------------------------ */
/* shop                                                                */

function renderShop(): void {
  $('shop-gems').textContent = String(save.gems);
  $('shop-remove').classList.toggle('owned', save.adsRemoved);
  $('shop-note').textContent = platform.isNative() ? '' : t('webNote');
}

async function buyRemoveAds(): Promise<void> {
  if (save.adsRemoved) return;
  const ok = await platform.purchaseRemoveAds();
  if (ok) {
    save.adsRemoved = true;
    persistSave(save);
    sfx.gem();
    toast(t('shopRemoveAds') + ' ✓');
    renderShop();
  }
}

async function buyGems(pack: 1 | 2 | 3): Promise<void> {
  const granted = await platform.purchaseGems(pack);
  if (granted > 0) {
    save.gems += granted;
    persistSave(save);
    sfx.gem();
    toast(t('gemsEarned', { n: granted }));
    renderShop();
    renderMainMenu();
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */

function renderSettings(): void {
  $('set-music').classList.toggle('on', save.music);
  $('set-sfx').classList.toggle('on', save.sfx);
  $('set-haptics').classList.toggle('on', save.haptics);
  $('set-version').textContent = `v${VERSION}`;
  for (const m of LANGS) {
    const el = $('set-lang-' + m.code);
    if (el) el.classList.toggle('sel', save.lang === m.code);
  }
  $('set-lang-auto').classList.toggle('sel', save.lang === 'auto');
}

/* ------------------------------------------------------------------ */
/* map screen                                                          */

function renderMap(): void {
  const wrap = $('map-biomes');
  wrap.innerHTML = '';
  const unlocked = save.level;
  for (const b of BIOMES) {
    const div = document.createElement('div');
    const locked = unlocked < b.range[0];
    div.className = 'map-biome' + (locked ? ' locked' : '');
    div.style.setProperty('--b1', b.bg[0]);
    div.style.setProperty('--b2', b.bg[2]);
    const stars = biomeStars(b.range[0], b.range[1]);
    div.innerHTML = `
      <div class="map-biome-name">${locked ? '???' : t(b.nameKey as never)}</div>
      <div class="map-biome-range">${b.range[0]}–${b.range[1]}</div>
      <div class="map-biome-stars"><svg viewBox="0 0 24 24"><path d="M12 1.8 l3.1 6.9 7.1.8 -5.3 5 1.4 7.1 L12 17.9 5.7 21.6 7.1 14.5 1.8 9.5 8.9 8.7 Z"/></svg> ${stars.earned}/${stars.max}</div>
      <div class="map-biome-bar"><i style="width:${Math.round(100 * stars.earned / Math.max(1, stars.max))}%"></i></div>
    `;
    if (!locked) {
      div.onclick = () => {
        const target = Math.max(b.range[0], Math.min(b.range[1], unlocked));
        startLevel(target);
      };
    }
    wrap.appendChild(div);
  }
  const total = totalStars();
  $('map-progress').textContent = `${t('progress')}: ${Math.round(100 * (unlocked - 1) / (TOTAL_LEVELS - 1))}% · ★ ${total.earned}/${total.max}`;
}

function biomeStars(from: number, to: number): { earned: number; max: number } {
  let earned = 0;
  let max = 0;
  for (let i = from; i <= to; i++) {
    earned += save.stars[i] ?? 0;
    max += 3;
  }
  return { earned, max };
}

function totalStars(): { earned: number; max: number } {
  let earned = 0;
  for (const v of Object.values(save.stars)) earned += v;
  return { earned, max: TOTAL_LEVELS * 3 };
}

/* ------------------------------------------------------------------ */
/* daily gift                                                          */

function renderDaily(): void {
  const can = canClaimDaily(save, todayKey());
  ($('daily-btn') as HTMLButtonElement).disabled = !can;
  $('daily-state').textContent = can ? t('dailyAmount') : t('claimed');
}

function claimDaily(): void {
  if (!canClaimDaily(save, todayKey())) return;
  const got = applyDaily(save, todayKey());
  persistSave(save);
  sfx.gem();
  toast(t('gemsEarned', { n: got }));
  renderDaily();
  renderMainMenu();
}

/* ------------------------------------------------------------------ */
/* help screen                                                         */

function renderHelp(): void {
  const list = $('help-list');
  if (list.childElementCount === 0) {
    const devices: [string, string][] = [
      ['devSource', '#ff5566'], ['devSink', '#4d9dff'], ['devMirror', '#cfd8ea'],
      ['devSplitter', '#bfefff'], ['devFilter', '#2bd97b'], ['devPrism', '#d36bff'],
      ['devMixer', '#ffd23f'], ['devBlock', '#8892aa'],
    ];
    for (const [key, col] of devices) {
      const row = document.createElement('div');
      row.className = 'help-row';
      row.innerHTML = `<span class="help-dot" style="background:${col}"></span><span>${t(key as never)}</span>`;
      list.appendChild(row);
    }
    const note = document.createElement('div');
    note.className = 'help-note';
    note.textContent = t('colorsNote');
    list.appendChild(note);
  }
}

/* ------------------------------------------------------------------ */
/* tutorial overlay (levels 1-2)                                       */

function maybeShowTutorial(n: number): void {
  if (n > 2 || save.tutorialDone >= 2) return;
  const ov = $('tutorial-overlay');
  ov.classList.remove('hidden');
  $('tut-text').textContent = n === 1 ? t('tut1') : t('tut2');
  save.tutorialDone = n;
  persistSave(save);
  $('tut-ok').onclick = () => {
    ov.classList.add('hidden');
    sfx.tap();
  };
}

/* ------------------------------------------------------------------ */
/* hint / solve buttons                                                */

async function onHint(): Promise<void> {
  if (!session) return;
  // check BEFORE charging gems — a dead hint must never cost anything
  const kind = session.peekHint();
  if (kind === 'none') {
    toast(t('solveDesc'), '#ffd23f');
    return;
  }
  const spend = async (): Promise<boolean> => {
    if (save.gems >= HINT_COST) {
      save.gems -= HINT_COST;
      persistSave(save);
      updateHudGems();
      return true;
    }
    const ok = await platform.showRewarded();
    if (ok) return true;
    toast(t('solveDesc'), '#ffd23f');
    return false;
  };
  if (await spend()) session.showHint();
}

async function onSolve(): Promise<void> {
  if (!session || session.won) return;
  const useGems = save.gems >= SOLVE_COST;
  if (!useGems) {
    const ok = await platform.showRewarded();
    if (!ok) return;
  } else {
    save.gems -= SOLVE_COST;
    persistSave(save);
    updateHudGems();
  }
  session.usedSolve = true;
  // Lumo steps through the solution with a delay for visibility.
  // If the player diverged from the stored path (and greedy can't improve),
  // rewind the board to its start so the planned solution applies cleanly.
  const step = (): void => {
    if (!session || session.won) return;
    let more = session.applyPlannedStep();
    if (!more) {
      // diverged from the stored path: fall back to greedy improvement
      more = session.applyGreedyStep();
    }
    if (!more) {
      // stuck off-path with no single-step improvement: rewind and replay
      session.rewindToStart();
      more = session.applyPlannedStep();
    }
    if (more) setTimeout(step, 700);
  };
  step();
}

/* ------------------------------------------------------------------ */
/* v1.5: FX layer — win confetti + touch waves                          */

interface ConfettiPiece {
  x: number; y: number; vx: number; vy: number;
  rot: number; vrot: number;
  w: number; h: number;
  color: string;
  life: number; maxLife: number;
  sway: number;
}

interface TouchWave {
  x: number; y: number; r: number; life: number;
}

const FX_COLORS = ['#ff5566', '#ffd23f', '#2ee6d6', '#4d9dff', '#b78bff', '#ffe9a8'];
let fxCanvas: HTMLCanvasElement | null = null;
let fxCtx: CanvasRenderingContext2D | null = null;
let confetti: ConfettiPiece[] = [];
let touchWaves: TouchWave[] = [];

function layoutFx(): void {
  if (!fxCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const r = fxCanvas.getBoundingClientRect();
  fxCanvas.width = Math.round(r.width * dpr);
  fxCanvas.height = Math.round(r.height * dpr);
  fxCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnConfetti(stars: number): void {
  if (!fxCtx || !fxCanvas) return;
  // more stars -> more confetti; 3-star wins feel like a parade
  const n = 40 + stars * 22;
  const W = fxCanvas.clientWidth;
  for (let i = 0; i < n; i++) {
    confetti.push({
      x: Math.random() * W,
      y: -20 - Math.random() * 140,
      vx: (Math.random() - 0.5) * 60,
      vy: 120 + Math.random() * 160,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 9,
      w: 6 + Math.random() * 6,
      h: 9 + Math.random() * 8,
      color: FX_COLORS[Math.floor(Math.random() * FX_COLORS.length)],
      life: 2.6 + Math.random() * 1.2,
      maxLife: 3.8,
      sway: Math.random() * Math.PI * 2,
    });
  }
  if (confetti.length > 260) confetti.splice(0, confetti.length - 260);
}

function touchWaveAt(x: number, y: number): void {
  if (!fxCtx) return;
  touchWaves.push({ x, y, r: 8, life: 0.5 });
}

function stepFx(dt: number): void {
  const g = fxCtx;
  if (!g || !fxCanvas) return;
  const W = fxCanvas.clientWidth;
  const H = fxCanvas.clientHeight;
  g.clearRect(0, 0, W, H);

  // confetti
  for (const c of confetti) {
    c.life -= dt;
    c.x += (c.vx + Math.sin(c.sway + c.life * 3) * 34) * dt;
    c.y += c.vy * dt;
    c.rot += c.vrot * dt;
  }
  confetti = confetti.filter(c => c.life > 0 && c.y < H + 30);
  for (const c of confetti) {
    g.save();
    g.translate(c.x, c.y);
    g.rotate(c.rot);
    g.globalAlpha = Math.min(1, c.life / 0.7);
    g.fillStyle = c.color;
    g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h * (0.55 + 0.45 * Math.abs(Math.sin(c.rot * 1.7))));
    g.restore();
  }

  // touch waves
  for (const w of touchWaves) {
    w.life -= dt;
    w.r += 240 * dt;
  }
  touchWaves = touchWaves.filter(w => w.life > 0);
  for (const w of touchWaves) {
    const k = w.life / 0.5;
    g.globalAlpha = k * 0.35;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2 + k * 2;
    g.beginPath();
    g.arc(w.x, w.y, w.r, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* game loop                                                           */

function layoutCanvas(): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const box = canvas.parentElement as HTMLElement;
  const r = box.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  if (session) renderer.layout(session.board, dpr);
  layoutFx(); // v1.5
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  renderer.step(dt);
  stepFx(dt); // v1.5: confetti + touch waves
  if (session && $('screen-game').classList.contains('active')) {
    const sim = session.sim;
    renderer.draw(session.board, sim, session.biome, session.solvedSet);
    // Lumo idles near the board corner
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    renderer.drawLumo(W - 34, H - 30, lumoMood, 0.9);
    if (lumoMood === 'cheer' && Math.random() < 0.02) lumoMood = 'idle';
    if (lumoMood === 'think' && Math.random() < 0.01) lumoMood = 'idle';
  }
  raf = requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */

async function boot(): Promise<void> {
  save = loadSave();
  setLang(save.lang);
  if (save.lang === 'auto') setLang('auto');
  sfx.enabled = save.sfx;
  sfx.musicEnabled = save.music;
  setHapticsEnabled(save.haptics);

  canvas = $('game-canvas') as HTMLCanvasElement;
  renderer = new Renderer(canvas);
  fxCanvas = $('fx-canvas') as HTMLCanvasElement; // v1.5
  fxCtx = fxCanvas.getContext('2d');

  await loadLevels();

  // pointer input
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  // audio unlock on first interaction
  const unlock = (): void => {
    sfx.tap();
    sfx.ambient(BIOMES.indexOf(biomeFor(save.level)));
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);

  window.addEventListener('resize', layoutCanvas);

  /* language picker buttons must exist before any on() wiring below */
  buildLangPicker();

  /* --- buttons --- */
  const on = (id: string, fn: () => void): void => {
    $(id).addEventListener('click', () => {
      sfx.tap();
      fn();
    });
  };

  on('mm-play', () => { startLevel(save.level); maybeShowTutorial(save.level); });

  on('mm-settings', () => { renderSettings(); showScreen('screen-settings'); });
  on('mm-shop', () => { renderShop(); showScreen('screen-shop'); });
  on('mm-help', () => { renderHelp(); showScreen('screen-help'); });
  on('mm-daily', () => { renderDaily(); showScreen('screen-daily'); });

  on('set-back', () => { showScreen(returnScreen); if (returnScreen === 'screen-menu') renderMainMenu(); });
  on('shop-back', () => { renderMainMenu(); showScreen('screen-menu'); });
  on('help-back', () => { renderMainMenu(); showScreen('screen-menu'); });
  on('daily-back', () => { renderMainMenu(); showScreen('screen-menu'); });
  on('map-back', () => { showScreen(returnScreen); });

  on('set-music', () => {
    save.music = !save.music;
    sfx.musicEnabled = save.music;
    if (save.music) sfx.ambient(BIOMES.indexOf(biomeFor(save.level)));
    else sfx.stopAmbient();
    persistSave(save);
    renderSettings();
  });
  on('set-sfx', () => {
    save.sfx = !save.sfx;
    sfx.enabled = save.sfx;
    persistSave(save);
    renderSettings();
  });
  on('set-haptics', () => {
    save.haptics = !save.haptics;
    setHapticsEnabled(save.haptics);
    persistSave(save);
    renderSettings();
  });
  for (const m of LANGS) {
    on('set-lang-' + m.code, () => {
      save.lang = m.code;
      setLang(m.code);
      applyTextDirection();
      persistSave(save);
      renderSettings();
      renderMainMenu();
      retranslateStatics();
    });
  }
  on('set-lang-auto', () => {
    save.lang = 'auto';
    setLang('auto');
    applyTextDirection();
    persistSave(save);
    renderSettings();
    renderMainMenu();
    retranslateStatics();
  });
  on('set-reset', async () => {
    if (await confirmDialog(t('confirmReset'))) {
      localStorage.removeItem('chromalith.save.v1');
      save = loadSave();
      setLang(save.lang);
      toast(t('resetDone'));
      renderMainMenu();
    }
  });

  on('shop-remove', buyRemoveAds);
  on('shop-pack1', () => void buyGems(1));
  on('shop-pack2', () => void buyGems(2));
  on('shop-pack3', () => void buyGems(3));

  on('daily-btn', claimDaily);

  on('hud-map', () => { returnScreen = 'screen-game'; renderMap(); showScreen('screen-map'); });
  on('hud-pause', () => { showScreen('screen-pause'); });
  on('hud-undo', () => session?.undo());
  on('hud-restart', async () => {
    if (await confirmDialog(t('confirmRestart'))) session?.restart();
  });
  on('hud-hint', () => void onHint());
  on('hud-solve', () => void onSolve());

  on('pause-resume', () => showScreen('screen-game'));
  on('pause-restart', () => { session?.restart(); showScreen('screen-game'); });
  on('pause-map', () => { returnScreen = 'screen-pause'; renderMap(); showScreen('screen-map'); });
  on('pause-settings', () => { returnScreen = 'screen-pause'; renderSettings(); showScreen('screen-settings'); });

  on('win-next', () => {
    if (session) {
      const next = Math.min(TOTAL_LEVELS, session.levelNum + 1);
      startLevel(next);
      maybeShowTutorial(next);
    }
  });
  on('win-map', () => { returnScreen = 'screen-win'; renderMap(); showScreen('screen-map'); });
  on('win-x2', async () => {
    const ok = await platform.showRewarded();
    if (ok && session) {
      const stars = save.stars[session.levelNum] ?? 1;
      const gained = levelGems(stars, session.levelNum);
      save.gems += gained;
      persistSave(save);
      $('win-x2').classList.add('hidden');
      $('win-gems').textContent = t('gemsEarned', { n: gained * 2 });
      sfx.gem();
    }
  });

  // privacy link
  const privacy = document.querySelector('a[data-privacy]');
  privacy?.addEventListener('click', e => {
    e.preventDefault();
    window.open('privacy.html', '_blank');
  });

  retranslateStatics();
  renderMainMenu();
  syncSkyGradient();
  showScreen('screen-menu');
  layoutCanvas();
  lastT = performance.now();
  raf = requestAnimationFrame(loop);
}

/** Build the 18-language picker inside #lang-list (Auto button stays first). */
function buildLangPicker(): void {
  const list = document.getElementById('lang-list');
  if (!list) return;
  for (const m of LANGS) {
    const b = document.createElement('button');
    b.className = 'lang-btn';
    b.id = 'set-lang-' + m.code;
    b.title = m.english;
    b.textContent = m.native;
    b.setAttribute('lang', m.bcp47);
    list.appendChild(b);
  }
}

/** Set html dir + lang for RTL languages (Arabic, Urdu). */
function applyTextDirection(): void {
  document.documentElement.dir = isRTL() ? 'rtl' : 'ltr';
  document.documentElement.lang = langMeta(getLang()).bcp47;
}

/** translate static DOM labels that exist before any screen render */
function retranslateStatics(): void {
  applyTextDirection();
  document.documentElement.lang = langMeta(getLang()).bcp47;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    el.textContent = t(key as never);
  });
}

void simulate;
boot();

