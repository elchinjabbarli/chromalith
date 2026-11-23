/**
 * Deterministic RNG (mulberry32) — same seed ⇒ same level on every device,
 * so level packs are fully reproducible and verifiable.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** float in [0,1) */
  f(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [0,n) */
  i(n: number): number {
    return Math.floor(this.f() * n);
  }
  /** integer in [min,max] inclusive */
  range(min: number, max: number): number {
    return min + this.i(max - min + 1);
  }
  /** true with probability p */
  chance(p: number): boolean {
    return this.f() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.i(arr.length)];
  }
  /** Fisher–Yates, in place */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.i(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
