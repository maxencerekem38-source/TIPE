/**
 * Indicateurs dérivés, agrégation statistique et mise en forme des résultats d'expériences.
 * Fonctions pures sur MatchResult / MatchStats (aucune dépendance vers le moteur).
 *
 * Statistiques (§11.5) : moyenne, écart-type, IC 95 % de Student, bootstrap apparié (2 000 rééchantillonnages
 * avec Rng à graine), test de Wilcoxon signé (exact pour n ≤ 20, sinon approximation normale avec correction
 * des ex æquo), δ de Cliff, correction de Holm, classement Elo.
 */
import type { MatchEvent, MatchStats, TeamId, TeamStats } from '../core/types';
import { otherTeam } from '../core/types';
import { PITCH } from '../core/pitch';
import { Rng } from '../core/rng';
import { confidenceInterval, mean, quantile, std } from '../core/stats';
import type { MatchResult } from './runner';

// ---------------------------------------------------------------------------
// Indicateurs par équipe
// ---------------------------------------------------------------------------
export interface TeamKpi {
  goals: number;
  goalsAgainst: number;
  xG: number;
  xGAgainst: number;
  /** ΔxG = xG pour − xG contre. */
  xGDiff: number;
  threatCreated: number;
  shots: number;
  /** Part de possession (0..1). */
  possessionShare: number;
  /** Taux de réussite des passes (0..1). */
  passCompletion: number;
  passes: number;
  /** Pertes de balle par 10 minutes. */
  turnoversPer10: number;
  /** Latence moyenne par décision (ms). */
  decisionLatencyMean: number;
  /** Regret moyen par décision. */
  regretPerDecision: number;
  /** PPDA (proxy) = passes adverses / (tacles + interceptions) — plus bas = pressing plus intense. */
  ppda: number;
}

const safeDiv = (a: number, b: number, fallback = 0): number => (b > 0 ? a / b : fallback);

export function teamKpis(stats: MatchStats, team: TeamId, durationSec: number): TeamKpi {
  const s: TeamStats = stats[team];
  const o: TeamStats = stats[otherTeam(team)];
  const possTotal = s.possessionTime + o.possessionTime;
  return {
    goals: s.goals,
    goalsAgainst: o.goals,
    xG: s.xG,
    xGAgainst: o.xG,
    xGDiff: s.xG - o.xG,
    threatCreated: s.threatCreated,
    shots: s.shots,
    possessionShare: possTotal > 0 ? s.possessionTime / possTotal : 0.5,
    passCompletion: safeDiv(s.passesCompleted, s.passes, 0),
    passes: s.passes,
    turnoversPer10: durationSec > 0 ? (s.turnovers * 600) / durationSec : 0,
    decisionLatencyMean: safeDiv(s.decisionMs, s.decisions, 0),
    regretPerDecision: safeDiv(s.regret, s.decisions, 0),
    ppda: safeDiv(o.passes, s.tackles + s.interceptions, o.passes),
  };
}

export const matchKpis = (r: MatchResult): Record<TeamId, TeamKpi> => ({
  A: teamKpis(r.stats, 'A', r.durationSec),
  B: teamKpis(r.stats, 'B', r.durationSec),
});

/**
 * « Danger des pertes » d'une équipe : Σ L(q⁻) sur les pertes. Utilise `event.value` si le moteur
 * le fournit, sinon un substitut géométrique décroissant avec la distance au propre but
 * (0,3·exp(−d/20), en unités de menace).
 */
export function turnoverDanger(events: readonly MatchEvent[], team: TeamId): number {
  let total = 0;
  for (const e of events) {
    if (e.team !== team || (e.kind !== 'turnover' && e.kind !== 'pass_intercepted' && e.kind !== 'dribble_failed')) continue;
    if (typeof e.value === 'number' && e.kind === 'turnover') { total += e.value; continue; }
    if (e.pos) {
      const ownGoalX = team === 'A' ? -PITCH.halfLength : PITCH.halfLength;
      const d = Math.hypot(e.pos.x - ownGoalX, e.pos.y);
      total += 0.3 * Math.exp(-d / 20);
    } else total += 0.03;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------
export interface Aggregate {
  n: number;
  mean: number;
  std: number;
  /** IC 95 % de Student. */
  ci: { low: number; high: number };
  /** IC 95 % par bootstrap percentile (2 000 rééchantillonnages). */
  bootstrap: { low: number; high: number };
  min: number;
  max: number;
}

/** Bootstrap percentile de la moyenne avec un Rng à graine (reproductible). */
export function bootstrapCi(xs: readonly number[], rng: Rng, resamples = 2000, level = 0.95): { low: number; high: number } {
  if (xs.length === 0) return { low: 0, high: 0 };
  const means = new Array<number>(resamples);
  const n = xs.length;
  for (let k = 0; k < resamples; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rng.next() * n)];
    means[k] = s / n;
  }
  return { low: quantile(means, (1 - level) / 2), high: quantile(means, 1 - (1 - level) / 2) };
}

export function aggregate(xs: readonly number[], rng: Rng = new Rng(12345), resamples = 2000): Aggregate {
  const arr = [...xs];
  const ci = confidenceInterval(arr);
  return {
    n: arr.length,
    mean: ci.mean,
    std: std(arr),
    ci: { low: ci.low, high: ci.high },
    bootstrap: bootstrapCi(arr, rng, resamples),
    min: arr.length ? Math.min(...arr) : 0,
    max: arr.length ? Math.max(...arr) : 0,
  };
}

/** Agrège plusieurs indicateurs (une série par clé). */
export function aggregateAll(series: Record<string, number[]>, seed = 12345): Record<string, Aggregate> {
  const out: Record<string, Aggregate> = {};
  for (const [k, xs] of Object.entries(series)) out[k] = aggregate(xs, new Rng(seed));
  return out;
}

// ---------------------------------------------------------------------------
// Comparaisons appariées
// ---------------------------------------------------------------------------
export interface WilcoxonResult {
  /** Somme des rangs positifs W⁺. */
  wPlus: number;
  wMinus: number;
  /** Effectif après suppression des différences nulles. */
  n: number;
  pValue: number;
  method: 'exact' | 'normal' | 'none';
  z?: number;
}

/** Fonction de répartition de la loi normale centrée réduite. */
export function normalCdf(z: number): number {
  // Φ(z) = ½(1 + erf(z/√2)), erf par Abramowitz–Stegun 7.1.26 (erreur < 1,5e-7)
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/** Rangs moyens (ex æquo partagés) de valeurs positives. */
function averageRanks(values: number[]): number[] {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const r = (i + j + 2) / 2; // rangs 1-indexés, moyenne du bloc
    for (let k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  return ranks;
}

/**
 * Test de Wilcoxon signé (bilatéral) sur des différences appariées.
 * Exact (énumération par programmation dynamique de la loi de W⁺ sous H₀) pour n ≤ 20,
 * sinon approximation normale avec correction des ex æquo et correction de continuité.
 */
export function wilcoxonSignedRank(diffs: readonly number[], exactMax = 20): WilcoxonResult {
  const nz = diffs.filter((d) => d !== 0 && Number.isFinite(d));
  const n = nz.length;
  if (n === 0) return { wPlus: 0, wMinus: 0, n: 0, pValue: 1, method: 'none' };
  const ranks = averageRanks(nz.map(Math.abs));
  let wPlus = 0, wMinus = 0;
  for (let i = 0; i < n; i++) if (nz[i] > 0) wPlus += ranks[i]; else wMinus += ranks[i];
  if (n <= exactMax) {
    // Rangs doublés pour rester entiers avec les rangs moyens (x,5).
    const r2 = ranks.map((r) => Math.round(2 * r));
    const total = r2.reduce((a, b) => a + b, 0);
    const counts = new Float64Array(total + 1);
    counts[0] = 1;
    for (const r of r2) for (let s = total; s >= r; s--) counts[s] += counts[s - r];
    const nConf = 2 ** n;
    const w2 = Math.round(2 * Math.min(wPlus, wMinus));
    let cum = 0;
    for (let s = 0; s <= w2; s++) cum += counts[s];
    const pValue = Math.min(1, (2 * cum) / nConf);
    return { wPlus, wMinus, n, pValue, method: 'exact' };
  }
  // Approximation normale avec correction des ex æquo.
  const groups = new Map<number, number>();
  for (const r of ranks) groups.set(r, (groups.get(r) ?? 0) + 1);
  let tieCorr = 0;
  for (const t of groups.values()) tieCorr += t ** 3 - t;
  const meanW = (n * (n + 1)) / 4;
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorr / 48;
  const w = Math.min(wPlus, wMinus);
  const z = varW > 0 ? (w - meanW + 0.5) / Math.sqrt(varW) : 0;
  const pValue = Math.min(1, 2 * normalCdf(z));
  return { wPlus, wMinus, n, pValue, method: 'normal', z };
}

/** δ de Cliff entre deux échantillons : P(x > y) − P(x < y) ∈ [−1, 1]. */
export function cliffsDelta(xs: readonly number[], ys: readonly number[]): number {
  if (!xs.length || !ys.length) return 0;
  let s = 0;
  for (const x of xs) for (const y of ys) s += x > y ? 1 : x < y ? -1 : 0;
  return s / (xs.length * ys.length);
}

/** Interprétation usuelle de |δ| (Romano et al. 2006). */
export function cliffsDeltaLabel(delta: number): string {
  const a = Math.abs(delta);
  if (a < 0.147) return 'négligeable';
  if (a < 0.33) return 'faible';
  if (a < 0.474) return 'moyen';
  return 'grand';
}

export interface PairedSummary {
  n: number;
  meanDiff: number;
  stdDiff: number;
  ci: { low: number; high: number };
  bootstrap: { low: number; high: number };
  wilcoxon: WilcoxonResult;
  cliffsDelta: number;
  /** Proportion de paires où x > y. */
  winRate: number;
}

/** Résumé d'une comparaison appariée x vs y (mêmes graines). */
export function pairedSummary(xs: readonly number[], ys: readonly number[], rng: Rng = new Rng(777), resamples = 2000): PairedSummary {
  const n = Math.min(xs.length, ys.length);
  const diffs = Array.from({ length: n }, (_, i) => xs[i] - ys[i]);
  return pairedSummaryFromDiffs(diffs, xs.slice(0, n), ys.slice(0, n), rng, resamples);
}

export function pairedSummaryFromDiffs(diffs: readonly number[], xs: readonly number[] = [], ys: readonly number[] = [], rng: Rng = new Rng(777), resamples = 2000): PairedSummary {
  const arr = [...diffs];
  const ci = confidenceInterval(arr);
  const wins = arr.filter((d) => d > 0).length;
  return {
    n: arr.length,
    meanDiff: ci.mean,
    stdDiff: std(arr),
    ci: { low: ci.low, high: ci.high },
    bootstrap: bootstrapCi(arr, rng, resamples),
    wilcoxon: wilcoxonSignedRank(arr),
    cliffsDelta: xs.length && ys.length ? cliffsDelta(xs, ys) : cliffsDelta(arr, arr.map(() => 0)),
    winRate: arr.length ? wins / arr.length : 0,
  };
}

/** Correction de Holm–Bonferroni : p-values ajustées (même ordre que l'entrée). */
export function holmCorrection(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => i).sort((a, b) => pValues[a] - pValues[b]);
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach((idx, rank) => {
    const adj = Math.min(1, (m - rank) * pValues[idx]);
    running = Math.max(running, adj);
    adjusted[idx] = running;
  });
  return adjusted;
}

// ---------------------------------------------------------------------------
// Elo
// ---------------------------------------------------------------------------
export interface TournamentGame {
  a: string;
  b: string;
  /** Score (buts ou xG) de a et de b ; le résultat s = 1 / 0,5 / 0 est déduit du signe de la différence. */
  scoreA: number;
  scoreB: number;
}

/**
 * Classement Elo séquentiel (K = 20, départ 1 500) sur une liste de matchs, en `passes` passages
 * (plusieurs passages lissent l'effet d'ordre). Somme des ratings conservée.
 */
export function eloRatings(games: readonly TournamentGame[], options: { k?: number; passes?: number; initial?: number } = {}): Record<string, number> {
  const k = options.k ?? 20, passes = options.passes ?? 1, initial = options.initial ?? 1500;
  const ratings: Record<string, number> = {};
  for (const g of games) { ratings[g.a] ??= initial; ratings[g.b] ??= initial; }
  for (let pass = 0; pass < passes; pass++) {
    for (const g of games) {
      const ra = ratings[g.a], rb = ratings[g.b];
      const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
      const sa = g.scoreA > g.scoreB ? 1 : g.scoreA < g.scoreB ? 0 : 0.5;
      const delta = k * (sa - ea);
      ratings[g.a] = ra + delta;
      ratings[g.b] = rb - delta;
    }
  }
  return ratings;
}

// ---------------------------------------------------------------------------
// Mise en forme (Markdown, format français)
// ---------------------------------------------------------------------------
/** Nombre au format français (virgule décimale). */
export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const s = x.toFixed(digits).replace('.', ',');
  return s === `-${(0).toFixed(digits).replace('.', ',')}` ? s.slice(1) : s;
}
export const fmtPct = (x: number, digits = 1): string => `${fmt(100 * x, digits)} %`;
export const fmtSigned = (x: number, digits = 2): string => (x > 0 ? `+${fmt(x, digits)}` : fmt(x, digits));
export const fmtCi = (ci: { low: number; high: number }, digits = 2): string => `[${fmt(ci.low, digits)} ; ${fmt(ci.high, digits)}]`;
export const fmtMeanCi = (a: Aggregate, digits = 2): string => `${fmt(a.mean, digits)} ± ${fmt((a.ci.high - a.ci.low) / 2, digits)}`;
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.001) return '< 0,001';
  return fmt(p, 3);
}
/** Étoiles de significativité. */
export const stars = (p: number): string => (p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '');

/** Tableau Markdown ; `align` : 'l' | 'r' | 'c' par colonne (droite par défaut sauf la première). */
export function mdTable(headers: string[], rows: (string | number)[][], align?: string[]): string {
  const al = headers.map((_, i) => align?.[i] ?? (i === 0 ? 'l' : 'r'));
  const sep = al.map((a) => (a === 'l' ? ':---' : a === 'c' ? ':---:' : '---:'));
  const cell = (c: string | number): string => (typeof c === 'number' ? (Number.isInteger(c) ? String(c) : fmt(c)) : c);
  return [`| ${headers.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Ligne de tableau pour une comparaison appariée. */
export function pairedRow(label: string, s: PairedSummary, digits = 3): (string | number)[] {
  return [label, fmtSigned(s.meanDiff, digits), fmtCi(s.ci, digits), fmtCi(s.bootstrap, digits), `${fmtP(s.wilcoxon.pValue)} ${stars(s.wilcoxon.pValue)}`.trim(), `${fmt(s.cliffsDelta, 2)} (${cliffsDeltaLabel(s.cliffsDelta)})`, fmtPct(s.winRate, 0)];
}

export const PAIRED_HEADERS = ['Indicateur', 'Δ moyen', 'IC 95 % (Student)', 'IC 95 % (bootstrap)', 'p (Wilcoxon)', 'δ de Cliff', 'Victoires'];

/** Statistiques descriptives d'un tableau de latences (ms). */
export function latencyPercentiles(xs: readonly number[]): { count: number; mean: number; p50: number; p95: number; p99: number; max: number } {
  const arr = [...xs];
  return {
    count: arr.length,
    mean: mean(arr),
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
    p99: quantile(arr, 0.99),
    max: arr.length ? Math.max(...arr) : 0,
  };
}
