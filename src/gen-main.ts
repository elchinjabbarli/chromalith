/**
 * Node-side entry for level generation (bundled by scripts/gen-levels.mjs).
 * Re-exports everything the offline script needs from src/core.
 */
export { Rng } from './core/rng';
export { paramsFor, seedFor, TOTAL_LEVELS, BIOMES } from './core/difficulty';
export { generateLevel } from './core/generator';
export { simulate, sinkStats, isSolved } from './core/sim';
export { shiftLine, cloneBoard, makeCell } from './core/grid';
