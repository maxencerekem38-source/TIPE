/**
 * Générateur pseudo-aléatoire déterministe (Mulberry32) à graine explicite.
 * Indispensable pour la reproductibilité des expériences (même graine ⇒ même match).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Nombre uniforme dans [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniforme dans [lo, hi). */
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Entier uniforme dans [lo, hi] inclus. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Tirage de Bernoulli. */
  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  /** Loi normale (Box–Muller). */
  normal(mu = 0, sigma = 1): number {
    let u = 0, w = 0;
    while (u === 0) u = this.next();
    while (w === 0) w = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }

  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }

  /** Sous-générateur indépendant (pour isoler des composants). */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 4294967295));
  }

  getState(): number {
    return this.state;
  }
  setState(s: number): void {
    this.state = s >>> 0;
  }
}
