/**
 * Boucle d'auto-cohérence (§11.6) : on collecte pendant l'auto-jeu les paires (probabilité attendue, issue réelle)
 * des passes (expectedP de la trajectoire ou valeur de l'événement `pass`) et des tirs (xG vs but),
 * puis on rapporte le score de Brier et le diagramme de fiabilité avant/après un recalibrage logistique
 * (Platt : p' = σ(a·logit(p) + b)) ajusté par Newton–Raphson avec ridge 1e-3.
 */
import type { MatchEvent, TeamId } from '../core/types';
import { mean } from '../core/stats';
import { fmt, fmtPct, mdTable } from './metrics';
import type { MatchResult } from './runner';

export interface CalibrationPair {
  /** Probabilité prédite. */
  p: number;
  /** Issue réalisée (1 = succès). */
  y: 0 | 1;
  kind: 'pass' | 'shot';
}

export interface CalibrationSamples {
  passes: CalibrationPair[];
  shots: CalibrationPair[];
}

const PASS_OUTCOMES = new Set(['pass_complete', 'pass_intercepted', 'pass_failed', 'offside']);

/**
 * Extrait les paires (p, y) d'un résultat de match (journal d'événements et trajectoires requis :
 * option `collectEvents`). Les passes sont appariées avec l'issue suivante de la même équipe
 * (FIFO), les tirs avec un but de la même équipe dans les 3 s.
 */
export function collectCalibrationPairs(results: readonly MatchResult[]): CalibrationSamples {
  const passes: CalibrationPair[] = [];
  const shots: CalibrationPair[] = [];
  for (const r of results) {
    const events = r.eventLog ?? [];
    // Passes : sources de probabilité attendue (trajectoires avec expectedP, sinon événements `pass` avec value).
    const flightsWithP = (r.flightLog ?? []).filter((f) => typeof f.expectedP === 'number' && (f.kind === 'pass' || f.kind === 'through' || f.kind === 'lob'));
    const pending: Record<TeamId, { p: number; time: number }[]> = { A: [], B: [] };
    const sources: { team: TeamId; p: number; time: number }[] = flightsWithP.length
      ? flightsWithP.map((f) => ({ team: f.team, p: f.expectedP as number, time: f.startTime }))
      : events.filter((e) => e.kind === 'pass' && typeof e.value === 'number').map((e) => ({ team: e.team, p: e.value as number, time: e.time }));
    const outcomes = events.filter((e) => PASS_OUTCOMES.has(e.kind)).sort((a, b) => a.time - b.time);
    const queue = [...sources].sort((a, b) => a.time - b.time);
    let qi = 0;
    for (const o of outcomes) {
      while (qi < queue.length && queue[qi].time <= o.time + 1e-9) { pending[queue[qi].team].push({ p: queue[qi].p, time: queue[qi].time }); qi++; }
      const list = pending[o.team];
      if (!list.length) continue;
      const src = list.shift()!;
      passes.push({ p: clampP(src.p), y: o.kind === 'pass_complete' ? 1 : 0, kind: 'pass' });
    }
    // Tirs.
    const shotEvents = events.filter((e) => e.kind === 'shot' && typeof e.value === 'number');
    const goals = events.filter((e) => e.kind === 'goal');
    for (const s of shotEvents) {
      const scored = goals.some((g) => g.team === s.team && g.time >= s.time - 1e-9 && g.time <= s.time + 3);
      shots.push({ p: clampP(s.value as number), y: scored ? 1 : 0, kind: 'shot' });
    }
  }
  return { passes, shots };
}

const clampP = (p: number): number => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Score de Brier = moyenne de (p − y)². */
export const brierScore = (pairs: readonly CalibrationPair[]): number => (pairs.length ? mean(pairs.map((q) => (q.p - q.y) ** 2)) : NaN);

export interface ReliabilityBin { low: number; high: number; count: number; meanPredicted: number; observed: number }

/** Table de fiabilité (10 classes de probabilité prédite par défaut). */
export function reliabilityTable(pairs: readonly CalibrationPair[], bins = 10): ReliabilityBin[] {
  const table: ReliabilityBin[] = Array.from({ length: bins }, (_, i) => ({ low: i / bins, high: (i + 1) / bins, count: 0, meanPredicted: 0, observed: 0 }));
  for (const q of pairs) {
    const b = Math.min(bins - 1, Math.floor(q.p * bins));
    table[b].count++; table[b].meanPredicted += q.p; table[b].observed += q.y;
  }
  for (const b of table) if (b.count) { b.meanPredicted /= b.count; b.observed /= b.count; }
  return table;
}

/** Erreur de calibration attendue (ECE) pondérée par les effectifs. */
export function expectedCalibrationError(table: readonly ReliabilityBin[]): number {
  const n = table.reduce((s, b) => s + b.count, 0);
  return n ? table.reduce((s, b) => s + (b.count / n) * Math.abs(b.meanPredicted - b.observed), 0) : NaN;
}

export interface PlattModel { a: number; b: number; iterations: number; apply: (p: number) => number }

/**
 * Recalibrage de Platt : p' = σ(a·logit(p) + b), maximum de vraisemblance pénalisé (ridge λ/2·‖w‖²),
 * Newton–Raphson (20 itérations par défaut).
 */
export function fitPlattScaling(pairs: readonly CalibrationPair[], ridge = 1e-3, iterations = 20): PlattModel {
  let a = 1, b = 0;
  if (pairs.length < 2) return { a, b, iterations: 0, apply: (p) => sigmoid(a * logit(clampP(p)) + b) };
  const xs = pairs.map((q) => logit(clampP(q.p)));
  let it = 0;
  for (; it < iterations; it++) {
    // Gradient et hessienne de la log-vraisemblance négative pénalisée.
    let g0 = ridge * a, g1 = ridge * b, h00 = ridge, h01 = 0, h11 = ridge;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const q = sigmoid(a * x + b);
      const r = q - pairs[i].y;
      g0 += r * x; g1 += r;
      const wgt = q * (1 - q);
      h00 += wgt * x * x; h01 += wgt * x; h11 += wgt;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (-h01 * g0 + h00 * g1) / det;
    a -= da; b -= db;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) { it++; break; }
  }
  const fa = a, fb = b;
  return { a: fa, b: fb, iterations: it, apply: (p) => sigmoid(fa * logit(clampP(p)) + fb) };
}

export interface CalibrationReport {
  label: string;
  n: number;
  baseRate: number;
  before: { brier: number; ece: number; table: ReliabilityBin[] };
  after: { brier: number; ece: number; table: ReliabilityBin[] };
  platt: { a: number; b: number };
  markdown: string;
}

/** Rapport avant/après recalibrage pour une famille de paires. */
export function calibrationReport(pairs: readonly CalibrationPair[], label: string, bins = 10): CalibrationReport {
  const model = fitPlattScaling(pairs);
  const after = pairs.map((q) => ({ ...q, p: model.apply(q.p) }));
  const tb = reliabilityTable(pairs, bins), ta = reliabilityTable(after, bins);
  const rep: CalibrationReport = {
    label, n: pairs.length, baseRate: pairs.length ? mean(pairs.map((q) => q.y)) : NaN,
    before: { brier: brierScore(pairs), ece: expectedCalibrationError(tb), table: tb },
    after: { brier: brierScore(after), ece: expectedCalibrationError(ta), table: ta },
    platt: { a: model.a, b: model.b },
    markdown: '',
  };
  rep.markdown = calibrationMarkdown(rep);
  return rep;
}

export function calibrationMarkdown(rep: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`### ${rep.label}`, '');
  if (!rep.n) { lines.push('_Aucune paire (probabilité attendue, issue) observée._', ''); return lines.join('\n'); }
  lines.push(`- Effectif : ${rep.n} ; taux de réussite observé : ${fmtPct(rep.baseRate)}`);
  lines.push(`- Brier avant : ${fmt(rep.before.brier, 4)} ; après recalibrage : ${fmt(rep.after.brier, 4)} (ECE ${fmt(rep.before.ece, 3)} → ${fmt(rep.after.ece, 3)})`);
  lines.push(`- Platt : p′ = σ(${fmt(rep.platt.a, 3)}·logit(p) ${rep.platt.b >= 0 ? '+' : '−'} ${fmt(Math.abs(rep.platt.b), 3)})`, '');
  const rows = rep.before.table.map((b, i) => {
    const a = rep.after.table[i];
    return [`[${fmt(b.low, 1)} ; ${fmt(b.high, 1)})`, b.count, b.count ? fmt(b.meanPredicted, 3) : '—', b.count ? fmt(b.observed, 3) : '—', a.count, a.count ? fmt(a.meanPredicted, 3) : '—', a.count ? fmt(a.observed, 3) : '—'];
  });
  lines.push(mdTable(['Classe', 'n (avant)', 'p̄ prédit', 'fréq. observée', 'n (après)', 'p̄ prédit', 'fréq. observée'], rows), '');
  return lines.join('\n');
}

/** Rapport complet (passes + tirs) en Markdown. */
export function fullCalibrationMarkdown(samples: CalibrationSamples, header: string): string {
  const passes = calibrationReport(samples.passes, 'Passes (P_pass vs réussite)');
  const shots = calibrationReport(samples.shots, 'Tirs (xG vs but)');
  return [`## Calibration des modèles probabilistes`, '', header, '', passes.markdown, shots.markdown].join('\n');
}

export const eventKindsForCalibration: readonly MatchEvent['kind'][] = ['pass', 'pass_complete', 'pass_intercepted', 'pass_failed', 'shot', 'goal'];
