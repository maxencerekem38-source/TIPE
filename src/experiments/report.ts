/**
 * Mise en forme des rapports Markdown en français (résultats d'expériences, scénarios, courbes d'apprentissage).
 */
import type { TeamId } from '../core/types';
import type { MatchResult } from './runner';
import type { ScenarioBatchSummary } from './runner';
import type { PairedComparison, TournamentResult, PAIRED_METRIC_KEYS } from './tournament';
import { PAIRED_METRIC_LABELS } from './tournament';
import type { AblationResult } from './ablations';
import type { GenerationRecord } from './cem';
import type { Scenario } from './scenarios';
import { describeAcceptable, SCENARIO_CATEGORIES } from './scenarios';
import { fmt, fmtCi, fmtP, fmtPct, fmtSigned, mdTable, pairedRow, PAIRED_HEADERS, stars } from './metrics';

type MetricKey = (typeof PAIRED_METRIC_KEYS)[number];

/** Tableau des statistiques d'un match (deux colonnes). */
export function matchStatsTable(r: MatchResult, names: Record<TeamId, string> = { A: 'Équipe A', B: 'Équipe B' }): string {
  const s = r.stats, k = r.kpi;
  const rows: (string | number)[][] = [
    ['Buts', s.A.goals, s.B.goals],
    ['Tirs (cadrés)', `${s.A.shots} (${s.A.shotsOnTarget})`, `${s.B.shots} (${s.B.shotsOnTarget})`],
    ['xG', fmt(s.A.xG, 2), fmt(s.B.xG, 2)],
    ['Possession', k ? fmtPct(k.A.possessionShare, 0) : '—', k ? fmtPct(k.B.possessionShare, 0) : '—'],
    ['Passes réussies', `${s.A.passesCompleted}/${s.A.passes}${k ? ` (${fmtPct(k.A.passCompletion, 0)})` : ''}`, `${s.B.passesCompleted}/${s.B.passes}${k ? ` (${fmtPct(k.B.passCompletion, 0)})` : ''}`],
    ['Passes en profondeur', s.A.throughBalls, s.B.throughBalls],
    ['Dribbles réussis', `${s.A.dribblesWon}/${s.A.dribbles}`, `${s.B.dribblesWon}/${s.B.dribbles}`],
    ['Tacles / interceptions', `${s.A.tackles} / ${s.A.interceptions}`, `${s.B.tackles} / ${s.B.interceptions}`],
    ['Pertes de balle', s.A.turnovers, s.B.turnovers],
    ['Menace créée', fmt(s.A.threatCreated, 3), fmt(s.B.threatCreated, 3)],
    ['PPDA (proxy)', k ? fmt(k.A.ppda, 1) : '—', k ? fmt(k.B.ppda, 1) : '—'],
    ['Décisions (latence moyenne)', `${s.A.decisions} (${fmt(k?.A.decisionLatencyMean ?? 0, 3)} ms)`, `${s.B.decisions} (${fmt(k?.B.decisionLatencyMean ?? 0, 3)} ms)`],
    ['Regret cumulé', fmt(s.A.regret, 3), fmt(s.B.regret, 3)],
  ];
  if (r.stability) rows.push(['Changements d’intention / s (porteur)', fmt(r.stability.A.intentionChangeRate, 2), fmt(r.stability.B.intentionChangeRate, 2)], ['Changements de cible / joueur·s', fmt(r.stability.A.targetChangeRate, 3), fmt(r.stability.B.targetChangeRate, 3)]);
  if (r.structure) rows.push(['Étendue du bloc x × y (m)', `${fmt(r.structure.A.spanX, 0)} × ${fmt(r.structure.A.spanY, 0)}`, `${fmt(r.structure.B.spanX, 0)} × ${fmt(r.structure.B.spanY, 0)}`], ['Hauteur de ligne défensive (m)', fmt(r.structure.A.defensiveLineHeight, 1), fmt(r.structure.B.defensiveLineHeight, 1)], ['Longueur moyenne de passe (m)', fmt(r.structure.A.meanPassLength, 1), fmt(r.structure.B.meanPassLength, 1)], ['Appels en profondeur', r.structure.A.deepRuns, r.structure.B.deepRuns]);
  return mdTable(['Statistique', names.A, names.B], rows);
}

/** Tableau texte aligné (console) à partir de lignes de cellules. */
export function consoleTable(headers: string[], rows: (string | number)[][]): string {
  const cell = (c: string | number): string => (typeof c === 'number' ? (Number.isInteger(c) ? String(c) : fmt(c)) : c);
  const cells = [headers, ...rows.map((r) => r.map(cell))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => String(r[i] ?? '').length)));
  const line = (r: string[]): string => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => line(r.map(cell)))].join('\n');
}

const MAIN_METRICS: MetricKey[] = ['xG', 'goals', 'threat', 'possession', 'turnovers', 'passCompletion', 'regret'];

/** Section Markdown d'une comparaison appariée. */
export function pairedComparisonMarkdown(c: PairedComparison, metrics: MetricKey[] = MAIN_METRICS): string {
  const rows = metrics.map((m) => pairedRow(PAIRED_METRIC_LABELS[m], c.summary[m], m === 'goals' ? 2 : 3));
  return [
    `### ${c.label}`, '',
    `${c.seeds.length} graines appariées × 2 orientations = ${c.matches.length} matchs ; buts cumulés ${c.x.label} ${c.goals.x} – ${c.goals.y} ${c.y.label}. Différences = ${c.x.label} − ${c.y.label}.`, '',
    mdTable(PAIRED_HEADERS, rows), '',
  ].join('\n');
}

/** Tableau récapitulatif de plusieurs comparaisons (une ligne par comparaison, ΔxG et Δ regret). */
export function comparisonsSummaryMarkdown(cs: readonly PairedComparison[], pHolm?: number[]): string {
  const rows = cs.map((c, i) => [
    c.label, fmtSigned(c.summary.xG.meanDiff, 3), fmtCi(c.summary.xG.bootstrap, 3),
    `${fmtP(c.summary.xG.wilcoxon.pValue)} ${stars(c.summary.xG.wilcoxon.pValue)}`.trim(),
    pHolm ? fmtP(pHolm[i]) : '—', fmt(c.summary.xG.cliffsDelta, 2),
    fmtSigned(c.summary.threat.meanDiff, 3), fmtSigned(c.summary.regret.meanDiff, 4), fmtPct(c.summary.xG.winRate, 0),
  ]);
  return mdTable(['Comparaison', 'ΔxG', 'IC 95 % (bootstrap)', 'p (Wilcoxon)', 'p (Holm)', 'δ Cliff', 'Δ menace', 'Δ regret', 'Victoires xG'], rows);
}

export function tournamentMarkdown(t: TournamentResult): string {
  const lines: string[] = [];
  lines.push(`${t.profiles.length} profils, ${t.seeds.length} graines, matchs de ${t.minutes} min, ${t.matches} matchs joués.`, '');
  const order = t.profiles.map((_, i) => i).sort((a, b) => t.elo[t.profiles[b]] - t.elo[t.profiles[a]]);
  lines.push('#### Classement', '');
  lines.push(mdTable(
    ['Profil', 'Elo (buts)', 'Elo (xG)', 'Points', 'xG pour', 'xG contre', 'Buts', 'Exploitabilité (ΔxG vs pire adversaire)'],
    order.map((i) => {
      const p = t.profiles[i], k = t.kpis[p], e = t.exploitability[p];
      return [p, fmt(t.elo[p], 0), fmt(t.eloXg[p], 0), t.points[i], fmt(k.xGFor.mean, 2), fmt(k.xGAgainst.mean, 2), `${k.goalsFor}–${k.goalsAgainst}`, `${fmtSigned(e.value, 2)} (${e.opponent})`];
    }),
  ), '');
  lines.push('#### Matrice ΔxG (ligne contre colonne)', '');
  lines.push(mdTable(['', ...t.profiles], t.profiles.map((p, i) => [p, ...t.xgMatrix[i].map((v, j) => (i === j ? '—' : fmtSigned(v, 2)))])), '');
  lines.push('#### Indicateurs structurels par profil (moyenne ± demi-largeur de l’IC 95 %)', '');
  lines.push(mdTable(
    ['Profil', 'Possession', 'Réussite passes', 'PPDA', 'Pertes / 10 min', 'Bloc x × y (m)', 'Ligne défensive (m)', 'Long. passe (m)', 'Appels', 'Chg. intention / s', 'Chg. cible / j·s'],
    t.profiles.map((p) => {
      const k = t.kpis[p];
      const pm = (a: { mean: number; ci: { low: number; high: number } }, d = 2): string => `${fmt(a.mean, d)} ± ${fmt((a.ci.high - a.ci.low) / 2, d)}`;
      return [p, fmtPct(k.possession.mean, 0), fmtPct(k.passCompletion.mean, 0), fmt(k.ppda.mean, 1), fmt(k.turnoversPer10.mean, 1), `${fmt(k.spanX.mean, 0)} × ${fmt(k.spanY.mean, 0)}`, pm(k.defensiveLineHeight, 1), pm(k.meanPassLength, 1), fmt(k.deepRuns.mean, 1), fmt(k.intentionChangeRate.mean, 2), fmt(k.targetChangeRate.mean, 3)];
    }),
  ), '');
  lines.push('#### Paires (ΔxG par graine, Wilcoxon, correction de Holm)', '');
  lines.push(mdTable(['Paire', 'ΔxG', 'IC 95 % (bootstrap)', 'p', 'p (Holm)', 'δ Cliff'], t.pairwise.map((q) => [
    `${t.profiles[q.i]} vs ${t.profiles[q.j]}`, fmtSigned(q.summary.meanDiff, 3), fmtCi(q.summary.bootstrap, 3), fmtP(q.summary.wilcoxon.pValue), `${fmtP(q.pHolm)} ${stars(q.pHolm)}`.trim(), fmt(q.summary.cliffsDelta, 2),
  ])), '');
  return lines.join('\n');
}

export function ablationsMarkdown(abs: readonly AblationResult[]): string {
  const lines: string[] = [];
  lines.push('Chaque variante joue contre le réglage par défaut (même algorithme), graines appariées, côtés échangés. Δ = variante − défaut.', '');
  lines.push(mdTable(
    ['Ablation', 'Isole', 'ΔxG', 'IC 95 % (bootstrap)', 'p (Wilcoxon)', 'δ Cliff', 'Δ regret', 'Δ chg. intention / s'],
    abs.map(({ ablation, comparison: c }) => {
      const stab = c.matches.length ? c.matches.reduce((s, m, k) => s + ((m.stability?.[k % 2 === 0 ? 'A' : 'B'].intentionChangeRate ?? 0) - (m.stability?.[k % 2 === 0 ? 'B' : 'A'].intentionChangeRate ?? 0)), 0) / c.matches.length : 0;
      return [ablation.label, ablation.isolates ?? '', fmtSigned(c.summary.xG.meanDiff, 3), fmtCi(c.summary.xG.bootstrap, 3), `${fmtP(c.summary.xG.wilcoxon.pValue)} ${stars(c.summary.xG.wilcoxon.pValue)}`.trim(), fmt(c.summary.xG.cliffsDelta, 2), fmtSigned(c.summary.regret.meanDiff, 4), fmtSigned(stab, 3)];
    }),
  ), '');
  return lines.join('\n');
}

export function scenarioSummaryMarkdown(summary: ScenarioBatchSummary, scenarios: readonly Scenario[]): string {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const rows = summary.perScenario.map((p) => {
    const sc = byId.get(p.id);
    const top = Object.entries(p.actions).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a, n]) => `${a} (${n})`).join(', ');
    return [p.reserved ? `${p.name} †` : p.name, sc ? SCENARIO_CATEGORIES[sc.category] : '', sc ? describeAcceptable(sc.acceptable) : '', fmtPct(p.acceptableRate, 0), fmt(p.meanRegret, 4), `${p.kpi} = ${fmt(p.meanKpi, 3)}`, top];
  });
  return [
    `Politique **${summary.policy}** : ${summary.runs} exécutions, accord top-1 = **${fmtPct(summary.top1Agreement, 1)}**, regret moyen = ${fmt(summary.meanRegret, 4)} ; KPI moyens : xG ${fmt(summary.meanKpi.xg, 3)}, menace ${fmt(summary.meanKpi.threat, 3)}, possession conservée ${fmtPct(summary.meanKpi.possession, 0)}.`, '',
    mdTable(['Scénario', 'Catégorie', 'Actions acceptables', 'Acceptable', 'Regret', 'KPI', 'Actions les plus fréquentes'], rows), '',
    '† scénario réservé (jamais utilisé pour l’optimisation).', '',
  ].join('\n');
}

export function learningCurveMarkdown(history: readonly GenerationRecord[], paths: readonly string[], defaultFlat: Record<string, number>, bestFlat: Record<string, number>, header: string): string {
  const lines: string[] = [];
  lines.push('## Courbe d’apprentissage (CEM)', '', header, '');
  lines.push(mdTable(['Génération', 'Fitness moyenne', 'IC 95 %', 'Meilleure fitness', 'σ moyen', 'Évaluations', 'Durée'], history.map((h) => [
    h.generation + 1, fmt(h.meanFitness, 4), fmtCi(h.ci, 4), fmt(h.bestFitness, 4), fmt(h.sigma.reduce((a, b) => a + b, 0) / Math.max(1, h.sigma.length), 3), h.evaluations, `${fmt(h.wallMs / 1000, 1)} s`,
  ])), '');
  lines.push('### Paramètres', '');
  lines.push(mdTable(['Paramètre', 'Défaut', 'Optimisé', 'Rapport'], paths.map((p) => [p, fmt(defaultFlat[p], 4), fmt(bestFlat[p], 4), defaultFlat[p] ? fmt(bestFlat[p] / defaultFlat[p], 2) : '—'])), '');
  return lines.join('\n');
}
