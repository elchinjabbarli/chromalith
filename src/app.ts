/**
 * App shell — screens, navigation, DOM UI wiring, game loop.
 */

import { Board, makeCell } from './core/grid';
import { simulate, sinkStats } from './core/sim';
import { BIOMES, biomeFor, TOTAL_LEVELS } from './core/difficulty';
import { Renderer } from './render/renderer';
import { drawWinFx } from './render/fx';
import { drawMenuLogo } from './render/logo';
import { Session, Shift } from './session';
import { loadSave, persistSave, SaveState, todayKey } from './systems/save';
import { setLang, getLang, t, Lang } from './systems/i18n';
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
  const nextBiome = BIOMES.find(b => b.range[0] > unlocked);
  const cur = biomeFor(unlocked);
  $('mm-title').textContent = t('title');
  $('mm-tagline').textContent = t('tagline');
  $('mm-play-label').textContent = unlocked > 1 ? t('continue') : t('play');
  $('mm-level-badge').textContent = `${t('level')} ${unlocked} / ${TOTAL_LEVELS}`;
  $('mm-biome').textContent = t(cur.nameKey as never);
  $('mm-gems').textContent = String(save.gems);
  $('mm-version').textContent = `v${VERSION}`;
  $('mm-badge-1000').textContent = t('levelPackBadge');
  void nextBiome;
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
  });
}

function updateHud(ok: number, total: number): void {
  $('hud-sinks').textContent = `${ok}/${total}`;
  const s = session;
  if (s) $('hud-moves').textContent = `${s.moves} ${t('moves')}`;
  $('hud-gems').textContent = String(save.gems);
}

/* ------------------------------------------------------------------ */
/* win flow                                                            */

async function onLevelWon(n: number, moves: number, par: number): Promise<void> {
  const stars = starsFor(moves, par);
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
  $('win-gems').textContent = t('gemsEarned', { n: gained });
  drawWinFx($('win-canvas') as HTMLCanvasElement);
  const x2 = $('win-x2');
  x2.classList.remove('hidden');
  const nextBtn = $('win-next');
  nextBtn.classList.toggle('hidden', n >= TOTAL_LEVELS);
  showScreen('screen-win');
  // star pops
  for (let i = 1; i <= stars; i++) {
    setTimeout(() => {
      $('win-star-' + i).classList.add('pop');
      sfx.star(i);
    }, 350 * i);
  }
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
}

const drag: DragState = {
  active: false, startX: 0, startY: 0, cellX: -1, cellY: -1,
  axis: null, lineIndex: -1, dist: 0,
};

function onPointerDown(e: PointerEvent): void {
  if (!session || session.won) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const cellPos = renderer.cellAtPoint(px, py, session.board);
  if (!cellPos) return;
  drag.active = true;
  drag.startX = px; drag.startY = py;
  drag.cellX = cellPos.x; drag.cellY = cellPos.y;
  drag.axis = null;
  drag.lineIndex = -1;
  drag.dist = 0;
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!drag.active || !session) return;
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
  drag.dist = drag.axis === 0 ? dx : dy;
  // live preview: offset the row/col visually
  previewLine(drag.axis, drag.lineIndex, drag.dist);
}

function onPointerUp(): void {
  if (!drag.active || !session) {
    drag.active = false;
    return;
  }
  drag.active = false;
  clearPreview();
  if (drag.axis === null || drag.lineIndex < 0) return;
  const cell = renderer.cell;
  const steps = Math.round(drag.dist / cell);
  if (steps !== 0) {
    session.shift(drag.axis, drag.lineIndex, steps);
  }
}

/** temporary visual offset of the dragged line */
function previewLine(axis: 0 | 1, index: number, dist: number): void {
  if (!session) return;
  const r = renderer;
  const b = session.board;
  const len = axis === 0 ? b.w : b.h;
  const map = new Map<number, { dx: number; dy: number }>();
  for (let i = 0; i < len; i++) {
    const idx = axis === 0 ? index * b.w + i : i * b.w + index;
    if (b.cells[idx].fixed) continue;
    map.set(idx, axis === 0 ? { dx: dist, dy: 0 } : { dx: 0, dy: dist });
  }
  r.previewOffsets = map;
}

function clearPreview(): void {
  renderer.previewOffsets = null;
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
  for (const l of ['en', 'tr', 'az'] as const) {
    $('set-lang-' + l).classList.toggle('sel', save.lang === l);
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
      <div class="map-biome-stars">★ ${stars.earned}/${stars.max}</div>
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
  if (save.gems >= HINT_COST) {
    save.gems -= HINT_COST;
    persistSave(save);
    if (!session.showHint()) {
      toast(t('solveDesc'), '#ffd23f');
    }
    updateHud(0, 0);
    const st = sinkStats(session.board);
    updateHud(st.ok, st.total);
  } else {
    const ok = await platform.showRewarded();
    if (ok && session.showHint()) sfx.gem();
  }
}

async function onSolve(): Promise<void> {
  if (!session) return;
  const useGems = save.gems >= SOLVE_COST;
  if (!useGems) {
    const ok = await platform.showRewarded();
    if (!ok) return;
  } else {
    save.gems -= SOLVE_COST;
    persistSave(save);
  }
  // Lumo steps through the solution with a delay for visibility
  const step = (): void => {
    if (!session || session.won) return;
    const more = session.applySolutionStep();
    const st = sinkStats(session.board);
    updateHud(st.ok, st.total);
    if (more) setTimeout(step, 700);
  };
  step();
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
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  renderer.step(dt);
  if (session && $('screen-game').classList.contains('active')) {
    const sim = session.sim;
    renderer.draw(session.board, sim, session.biome, session.anim, session.solvedSet);
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

  await loadLevels();

  // pointer input
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // audio unlock on first interaction
  const unlock = (): void => {
    sfx.tap();
    sfx.ambient(BIOMES.indexOf(biomeFor(save.level)));
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);

  window.addEventListener('resize', layoutCanvas);

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
  for (const l of ['en', 'tr', 'az'] as const) {
    on('set-lang-' + l, () => {
      save.lang = l;
      setLang(l);
      persistSave(save);
      renderSettings();
      renderMainMenu();
      retranslateStatics();
    });
  }
  on('set-lang-auto', () => {
    save.lang = 'auto';
    setLang('auto');
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
  on('pause-map', () => { returnScreen = 'screen-game'; renderMap(); showScreen('screen-map'); });
  on('pause-settings', () => { returnScreen = 'screen-pause'; renderSettings(); showScreen('screen-settings'); });

  on('win-next', () => {
    if (session) startLevel(Math.min(TOTAL_LEVELS, session.levelNum + 1));
  });
  on('win-map', () => { renderMap(); showScreen('screen-map'); });
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
  drawMenuLogo($('mm-logo') as HTMLCanvasElement);
  showScreen('screen-menu');
  layoutCanvas();
  lastT = performance.now();
  raf = requestAnimationFrame(loop);
}

/** translate static DOM labels that exist before any screen render */
function retranslateStatics(): void {
  document.documentElement.lang = getLang();
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    el.textContent = t(key as never);
  });
}

void simulate;
boot();

