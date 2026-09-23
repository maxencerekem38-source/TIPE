import { describe, it, expect } from 'vitest';
import { hungarian } from '@/core/hungarian';
import { Rng } from '@/core/rng';
import { ScalarField } from '@/core/grid';
import { confidenceInterval, welchTest, mean, std, normalQuantile, tQuantile } from '@/core/stats';
import { goalAngle, PITCH, distToGoal, isInPenaltyArea } from '@/core/pitch';
import { projectOnSegment, normalize, len, angleBetween } from '@/core/vec2';

describe('hungarian', () => {
  it('trouve l’affectation optimale sur une matrice carrée', () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const r = hungarian(cost);
    expect(r.assignment).toEqual([1, 0, 2]);
    expect(r.totalCost).toBe(5);
  });
  it('gère les matrices rectangulaires (plus d’agents que de tâches)', () => {
    const cost = [
      [10, 1],
      [1, 10],
      [5, 5],
    ];
    const r = hungarian(cost);
    expect(r.assignment[0]).toBe(1);
    expect(r.assignment[1]).toBe(0);
    expect(r.assignment[2]).toBe(-1);
    expect(r.totalCost).toBe(2);
  });
  it('gère les matrices rectangulaires (plus de tâches que d’agents)', () => {
    const r = hungarian([[3, 1, 2]]);
    expect(r.assignment).toEqual([1]);
  });
  it('est optimal face à la force brute sur des matrices aléatoires', () => {
    const rng = new Rng(7);
    for (let trial = 0; trial < 30; trial++) {
      const n = rng.int(1, 5);
      const cost = Array.from({ length: n }, () => Array.from({ length: n }, () => rng.int(0, 20)));
      const r = hungarian(cost);
      // Force brute
      const perms = (arr: number[]): number[][] => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
      let best = Infinity;
      for (const p of perms([...Array(n).keys()])) best = Math.min(best, p.reduce((s, j, i) => s + cost[i][j], 0));
      expect(r.totalCost).toBe(best);
    }
  });
});

describe('rng', () => {
  it('est déterministe à graine fixée', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('produit des valeurs dans [0,1) de moyenne ≈ 0,5', () => {
    const r = new Rng(3);
    const xs = Array.from({ length: 20000 }, () => r.next());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(Math.abs(mean(xs) - 0.5)).toBeLessThan(0.01);
  });
  it('normal() a une moyenne et un écart-type corrects', () => {
    const r = new Rng(9);
    const xs = Array.from({ length: 20000 }, () => r.normal(2, 3));
    expect(Math.abs(mean(xs) - 2)).toBeLessThan(0.1);
    expect(Math.abs(std(xs) - 3)).toBeLessThan(0.1);
  });
});

describe('grid', () => {
  it('interpole bilinéairement un champ affine exactement', () => {
    const f = new ScalarField(2).fill((x, y) => 3 * x + 2 * y + 1);
    expect(f.sample({ x: 10.3, y: -7.7 })).toBeCloseTo(3 * 10.3 + 2 * -7.7 + 1, 4);
    expect(f.sample({ x: -52.5, y: -34 })).toBeCloseTo(3 * -52.5 + 2 * -34 + 1, 4);
  });
  it('argmax retourne la bonne cellule', () => {
    const f = new ScalarField(2).fill((x, y) => -((x - 10) ** 2) - (y + 4) ** 2);
    const m = f.argmax();
    expect(Math.abs(m.pos.x - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.pos.y + 4)).toBeLessThanOrEqual(1);
  });
});

describe('stats', () => {
  it('quantiles normaux et de Student', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 3);
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228, 2);
    expect(tQuantile(0.975, 30)).toBeCloseTo(2.042, 2);
  });
  it('intervalle de confiance et test de Welch', () => {
    const rng = new Rng(11);
    const xs = Array.from({ length: 40 }, () => rng.normal(0, 1));
    const ys = Array.from({ length: 40 }, () => rng.normal(1, 1));
    const ci = confidenceInterval(xs);
    expect(ci.low).toBeLessThan(ci.mean);
    expect(ci.high).toBeGreaterThan(ci.mean);
    const w = welchTest(xs, ys);
    expect(w.pValue).toBeLessThan(0.01);
    const w2 = welchTest(xs, xs);
    expect(w2.pValue).toBeCloseTo(1, 5);
  });
});

describe('pitch', () => {
  it('angle de tir maximal face au but, décroissant en s’éloignant', () => {
    const a1 = goalAngle({ x: 41.5, y: 0 }, 1);
    const a2 = goalAngle({ x: 30, y: 0 }, 1);
    const a3 = goalAngle({ x: 41.5, y: 15 }, 1);
    expect(a1).toBeGreaterThan(a2);
    expect(a1).toBeGreaterThan(a3);
    expect(a1).toBeCloseTo(2 * Math.atan(PITCH.goalHalfWidth / 11), 6);
  });
  it('distance et surfaces', () => {
    expect(distToGoal({ x: 41.5, y: 0 }, 1)).toBeCloseTo(11, 6);
    expect(isInPenaltyArea({ x: 45, y: 10 }, 1)).toBe(true);
    expect(isInPenaltyArea({ x: 30, y: 10 }, 1)).toBe(false);
    expect(isInPenaltyArea({ x: -45, y: 10 }, -1)).toBe(true);
  });
});

describe('vec2', () => {
  it('projection sur segment', () => {
    const r = projectOnSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.t).toBeCloseTo(0.5);
    expect(r.distance).toBeCloseTo(3);
    const r2 = projectOnSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r2.t).toBe(1);
    expect(r2.distance).toBeCloseTo(5);
  });
  it('normalisation et angles', () => {
    expect(len(normalize({ x: 3, y: 4 }))).toBeCloseTo(1);
    expect(angleBetween({ x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
  });
});
