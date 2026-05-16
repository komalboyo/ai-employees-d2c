/** Mulberry32 — small, fast, deterministic seeded RNG. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min: number, maxExcl: number): number {
      return Math.floor(this.next() * (maxExcl - min)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.int(0, arr.length)];
    },
    weighted<T>(arr: readonly { v: T; w: number }[]): T {
      const total = arr.reduce((s, e) => s + e.w, 0);
      let r = this.next() * total;
      for (const e of arr) {
        if (r < e.w) return e.v;
        r -= e.w;
      }
      return arr[arr.length - 1].v;
    },
  };
}
