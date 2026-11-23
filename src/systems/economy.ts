/** In-game economy: gems, daily gift, star awards, ad cadence. */

import { SaveState } from './save';

export const HINT_COST = 25;
export const SOLVE_COST = 90;

/** gem reward for finishing a level, by stars */
export function levelGems(stars: 0 | 1 | 2 | 3, level: number): number {
  const base = 8 + Math.min(12, Math.floor(level / 50)); // 8..20
  return base * stars;
}

/** stars for a solve, by moves vs par */
export function starsFor(moves: number, par: number): 0 | 1 | 2 | 3 {
  if (moves <= par) return 3;
  if (moves <= par + 3) return 2;
  return 1;
}

/** after how many level-completions an interstitial shows (min gap) */
export function interstitialEvery(s: SaveState): number {
  if (s.adsRemoved) return Infinity;
  return 3; // every 3rd completed level
}

export function canClaimDaily(s: SaveState, today: string): boolean {
  return s.lastDaily !== today;
}

export function applyDaily(s: SaveState, today: string): number {
  s.lastDaily = today;
  s.gems += 50;
  return 50;
}
