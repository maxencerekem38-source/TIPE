/**
 * Comparaisons appariées (mêmes graines, côtés échangés), tournoi tactique avec Elo et KPI structurels,
 * comparaison de l'algorithme complet aux baselines (§11.3–11.5).
 */
import type { MatchConfig, TacticConfig, TeamId } from '../core/types';
import { TEAMS, otherTeam } from '../core/types';
import { Rng } from '../core/rng';
import { mean } from '../core/stats';
import { makeTactic } from '../tactics/styles';
import type { FormationId, StyleId } from '../core/types';
import { runBatch, type BatchOptions } from './worker-pool';
import { runMatchTask, type MatchResult, type MatchTask, type RunMatchOptions } from './runner';
import { aggregate, eloRatings, holmCorrection, pairedSummaryFromDiffs, turnoverDanger, type Aggregate, type PairedSummary, type TournamentGame } from './metrics';
import { FULL_POLICY_NAME, makeConfig as defaultMakeConfig, tacticLabel } from './cli';

// ---------------------------------------------------------------------------
// Références de politiques (sérialisables)
// ---------------------------------------------------------------------------
export interface PolicyRef {
  /** Étiquette d'affichage. */
  label: string;
  /** Nom de politique (« full » ou une baseline). */
  policy?: string;
  /** Surcharges ϑ pour cette politique. */
  paramOverrides?: Record<string, number>;
}

export const FULL_REF: PolicyRef = { label: 'complet (B3)', policy: FULL_POLICY_NAME };

export interface PairedMetrics {
  xG: number; goals: number; threat: number; possession: number; turnovers: number; passCompletion: number; regret: number; turnoverDanger: number; shots: number;
}
export const PAIRED_METRIC_KEYS: (keyof PairedMetrics)[] = ['xG', 'goals', 'threat', 'possession', 'turnovers', 'passCompletion', 'regret', 'turnoverDanger', 'shots'];
export const PAIRED_METRIC_LABELS: Record<keyof PairedMetrics, string> = {
  xG: 'ΔxG', goals: 'Δ buts', threat: 'Δ menace créée', possession: 'Δ possession (part)', turnovers: 'Δ pertes / 10 min',
  passCompletion: 'Δ réussite des passes', regret: 'Δ regret / décision', turnoverDanger: 'Δ danger des pertes', shots: 'Δ tirs',
};

/** Indicateurs d'une équipe dans un match, relatifs à l'adversaire quand cela a un sens. */
export function sideMetrics(r: MatchResult, team: TeamId): PairedMetrics {
  const k = r.kpi![team];
  const o = r.kpi![otherTeam(team)];
  return {
    xG: k.xG - o.xG,
    goals: k.goals - o.goals,
    threat: k.threatCreated - o.threatCreated,
    possession: k.possessionShare,
    turnovers: k.turnoversPer10,
    passCompletion: k.passCompletion,
    regret: k.regretPerDecision,
    turnoverDanger: r.eventLog ? turnoverDanger(r.eventLog, team) : 0,
    shots: k.shots,
  };
}

const averageMetrics = (ms: PairedMetrics[]): PairedMetrics => {
  const out = {} as PairedMetrics;
  for (const key of PAIRED_METRIC_KEYS) out[key] = mean(ms.map((m) => m[key]));
  return out;
};
const diffMetrics = (x: PairedMetrics, y: PairedMetrics): PairedMetrics => {
  const out = {} as PairedMetrics;
  for (const key of PAIRED_METRIC_KEYS) out[key] = x[key] - y[key];
  return out;
};

// ---------------------------------------------------------------------------
// Comparaison appariée
// ---------------------------------------------------------------------------
export interface PairedComparison {
  label: string;
  x: PolicyRef;
  y: PolicyRef;
  seeds: number[];
  perSeed: { seed: number; x: PairedMetrics; y: PairedMetrics; diff: PairedMetrics }[];
  summary: Record<keyof PairedMetrics, PairedSummary>;
  /** Score cumulé (buts) X – Y sur tous les matchs. */
  goals: { x: number; y: number };
  matches: MatchResult[];
  wallMs: number;
}

export interface PairedOptions {
  makeConfig?: (seed: number) => MatchConfig;
  batch?: BatchOptions;
  matchOptions?: Omit<RunMatchOptions, 'onDecisions'>;
  label?: string;
}

/** Construit les deux tâches (côtés échangés) d'une graine. */
export function pairedTasks(config: MatchConfig, x: PolicyRef, y: PolicyRef, matchOptions?: Omit<RunMatchOptions, 'onDecisions'>): [MatchTask, MatchTask] {
  const mk = (a: PolicyRef, b: PolicyRef): MatchTask => ({
    config,
    policies: { A: a.policy ?? FULL_POLICY_NAME, B: b.policy ?? FULL_POLICY_NAME },
    paramOverrides: { A: a.paramOverrides ?? {}, B: b.paramOverrides ?? {} },
    options: matchOptions,
  });
  return [mk(x, y), mk(y, x)];
}

/**
 * Compare X et Y sur des graines appariées : pour chaque graine, X joue en A puis en B
 * (suppression du biais de côté) ; la différence par graine est la moyenne des deux orientations.
 */
export async function runPairedComparison(x: PolicyRef, y: PolicyRef, seeds: readonly number[], options: PairedOptions = {}): Promise<PairedComparison> {
  const mk = options.makeConfig ?? ((seed: number) => defaultMakeConfig({ seed, minutes: 10 }));
  const tasks: MatchTask[] = [];
  for (const seed of seeds) tasks.push(...pairedTasks(mk(seed), x, y, options.matchOptions));
  const t0 = performance.now();
  const results = await runBatch(tasks, runMatchTask, { ...options.batch, workerTask: 'match' });
  const wallMs = performance.now() - t0;
  const perSeed: PairedComparison['perSeed'] = [];
  let gx = 0, gy = 0;
  seeds.forEach((seed, i) => {
    const r1 = results[2 * i], r2 = results[2 * i + 1];
    const xm = averageMetrics([sideMetrics(r1, 'A'), sideMetrics(r2, 'B')]);
    const ym = averageMetrics([sideMetrics(r1, 'B'), sideMetrics(r2, 'A')]);
    gx += r1.score.A + r2.score.B; gy += r1.score.B + r2.score.A;
    perSeed.push({ seed, x: xm, y: ym, diff: diffMetrics(xm, ym) });
  });
  const summary = {} as Record<keyof PairedMetrics, PairedSummary>;
  for (const key of PAIRED_METRIC_KEYS) {
    const xs = perSeed.map((p) => p.x[key]), ys = perSeed.map((p) => p.y[key]);
    summary[key] = pairedSummaryFromDiffs(perSeed.map((p) => p.diff[key]), xs, ys, new Rng(1000 + PAIRED_METRIC_KEYS.indexOf(key)));
  }
  return { label: options.label ?? `${x.label} vs ${y.label}`, x, y, seeds: [...seeds], perSeed, summary, goals: { x: gx, y: gy }, matches: results, wallMs };
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
export const BASELINE_LABELS: Record<string, string> = {
  random: 'B0 aléatoire',
  greedy_progress: 'B1 glouton (progression)',
  greedy_safe: 'B1′ glouton (sécurité)',
  no_lookahead: 'B2 sans anticipation',
  no_risk: 'B4 sans terme de risque',
  no_tactic: 'B7 sans modulation tactique',
  nearest_man: 'B6 défense « homme le plus proche »',
};

export const baselineRef = (name: string): PolicyRef => ({ label: BASELINE_LABELS[name] ?? name, policy: name });

/** Algorithme complet contre chaque baseline, en graines appariées. */
export async function runBaselineComparison(baselineNames: readonly string[], seeds: readonly number[], options: PairedOptions = {}): Promise<PairedComparison[]> {
  const out: PairedComparison[] = [];
  for (const name of baselineNames) out.push(await runPairedComparison(FULL_REF, baselineRef(name), seeds, { ...options, label: `complet vs ${BASELINE_LABELS[name] ?? name}` }));
  return out;
}

// ---------------------------------------------------------------------------
// Tournoi tactique
// ---------------------------------------------------------------------------
/** Formation « naturelle » de chaque style. */
export const NATURAL_FORMATION: Record<StyleId, FormationId> = {
  balanced: '4-3-3', possession: '4-3-3', counter: '4-4-2', high_press: '4-2-3-1', low_block: '4-4-2', wide: '3-4-3', direct: '3-5-2',
};

export const naturalProfiles = (styles: readonly StyleId[]): TacticConfig[] => styles.map((s) => makeTactic(NATURAL_FORMATION[s], s));

export interface ProfileKpis {
  matches: number;
  xGFor: Aggregate; xGAgainst: Aggregate; goalsFor: number; goalsAgainst: number;
  possession: Aggregate; passCompletion: Aggregate; ppda: Aggregate; turnoversPer10: Aggregate;
  spanX: Aggregate; spanY: Aggregate; hullArea: Aggregate; defensiveLineHeight: Aggregate; meanPassLength: Aggregate; deepRuns: Aggregate;
  intentionChangeRate: Aggregate; targetChangeRate: Aggregate;
}

export interface TournamentResult {
  profiles: string[];
  seeds: number[];
  minutes: number;
  /** Matrice ΔxG moyen (ligne i contre colonne j, du point de vue de i). */
  xgMatrix: number[][];
  /** Points (3/1/0) cumulés par profil. */
  points: number[];
  elo: Record<string, number>;
  eloXg: Record<string, number>;
  kpis: Record<string, ProfileKpis>;
  /** Exploitabilité : pire ΔxG moyen d'un profil face à son meilleur adversaire (et cet adversaire). */
  exploitability: Record<string, { value: number; opponent: string }>;
  pairwise: { i: number; j: number; summary: PairedSummary; pHolm: number }[];
  games: TournamentGame[];
  matches: number;
  wallMs: number;
}

export interface TournamentOptions {
  batch?: BatchOptions;
  paramsOf?: (seed: number) => MatchConfig['params'];
  policy?: string;
  matchOptions?: Omit<RunMatchOptions, 'onDecisions'>;
}

/** Tournoi toutes rondes : chaque paire de profils joue chaque graine dans les deux sens. */
export async function runTournament(profiles: readonly TacticConfig[], seeds: readonly number[], minutes: number, options: TournamentOptions = {}): Promise<TournamentResult> {
  const labels = profiles.map(tacticLabel);
  const tasks: MatchTask[] = [];
  const meta: { i: number; j: number; seed: number }[] = [];
  for (let i = 0; i < profiles.length; i++)
    for (let j = i + 1; j < profiles.length; j++)
      for (const seed of seeds) {
        const params = options.paramsOf?.(seed);
        const policy = options.policy ?? FULL_POLICY_NAME;
        tasks.push({ config: defaultMakeConfig({ seed, minutes, tacticA: profiles[i], tacticB: profiles[j], params }), policies: { A: policy, B: policy }, options: options.matchOptions });
        meta.push({ i, j, seed });
        tasks.push({ config: defaultMakeConfig({ seed, minutes, tacticA: profiles[j], tacticB: profiles[i], params }), policies: { A: policy, B: policy }, options: options.matchOptions });
        meta.push({ i: j, j: i, seed });
      }
  const t0 = performance.now();
  const results = await runBatch(tasks, runMatchTask, { ...options.batch, workerTask: 'match' });
  const wallMs = performance.now() - t0;

  const n = profiles.length;
  const diffs: number[][][] = Array.from({ length: n }, () => Array.from({ length: n }, () => []));
  const points = new Array<number>(n).fill(0);
  const games: TournamentGame[] = [];
  const gamesXg: TournamentGame[] = [];
  const byProfile: Record<string, { r: MatchResult; team: TeamId }[]> = Object.fromEntries(labels.map((l) => [l, []]));
  results.forEach((r, k) => {
    const { i, j } = meta[k]; // i joue en A, j en B
    const d = r.kpi!.A.xG - r.kpi!.B.xG;
    diffs[i][j].push(d); diffs[j][i].push(-d);
    if (r.score.A > r.score.B) points[i] += 3; else if (r.score.A < r.score.B) points[j] += 3; else { points[i] += 1; points[j] += 1; }
    games.push({ a: labels[i], b: labels[j], scoreA: r.score.A, scoreB: r.score.B });
    gamesXg.push({ a: labels[i], b: labels[j], scoreA: r.kpi!.A.xG, scoreB: r.kpi!.B.xG });
    byProfile[labels[i]].push({ r, team: 'A' });
    byProfile[labels[j]].push({ r, team: 'B' });
  });
  const xgMatrix = diffs.map((row) => row.map((xs) => (xs.length ? mean(xs) : 0)));
  const pairwise: TournamentResult['pairwise'] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    // Différence appariée par graine : moyenne des deux orientations.
    const perSeed = seeds.map((_, s) => (diffs[i][j][2 * s] + diffs[i][j][2 * s + 1]) / 2);
    pairwise.push({ i, j, summary: pairedSummaryFromDiffs(perSeed, [], [], new Rng(500 + i * 31 + j)), pHolm: 1 });
  }
  const adj = holmCorrection(pairwise.map((p) => p.summary.wilcoxon.pValue));
  pairwise.forEach((p, k) => { p.pHolm = adj[k]; });

  const kpis: Record<string, ProfileKpis> = {};
  labels.forEach((label) => {
    const rs = byProfile[label];
    const pick = (f: (r: MatchResult, t: TeamId) => number): Aggregate => aggregate(rs.map(({ r, team }) => f(r, team)), new Rng(42));
    kpis[label] = {
      matches: rs.length,
      xGFor: pick((r, t) => r.kpi![t].xG), xGAgainst: pick((r, t) => r.kpi![t].xGAgainst),
      goalsFor: rs.reduce((s, { r, team }) => s + r.score[team], 0), goalsAgainst: rs.reduce((s, { r, team }) => s + r.score[otherTeam(team)], 0),
      possession: pick((r, t) => r.kpi![t].possessionShare), passCompletion: pick((r, t) => r.kpi![t].passCompletion),
      ppda: pick((r, t) => r.kpi![t].ppda), turnoversPer10: pick((r, t) => r.kpi![t].turnoversPer10),
      spanX: pick((r, t) => r.structure?.[t].spanX ?? 0), spanY: pick((r, t) => r.structure?.[t].spanY ?? 0), hullArea: pick((r, t) => r.structure?.[t].hullArea ?? 0),
      defensiveLineHeight: pick((r, t) => r.structure?.[t].defensiveLineHeight ?? 0), meanPassLength: pick((r, t) => r.structure?.[t].meanPassLength ?? 0), deepRuns: pick((r, t) => r.structure?.[t].deepRuns ?? 0),
      intentionChangeRate: pick((r, t) => r.stability?.[t].intentionChangeRate ?? 0), targetChangeRate: pick((r, t) => r.stability?.[t].targetChangeRate ?? 0),
    };
  });
  const exploitability: TournamentResult['exploitability'] = {};
  labels.forEach((label, i) => {
    let worst = Infinity, opp = '';
    for (let j = 0; j < n; j++) if (j !== i && xgMatrix[i][j] < worst) { worst = xgMatrix[i][j]; opp = labels[j]; }
    exploitability[label] = { value: Number.isFinite(worst) ? worst : 0, opponent: opp };
  });
  return {
    profiles: labels, seeds: [...seeds], minutes, xgMatrix, points,
    elo: eloRatings(games, { passes: 3 }), eloXg: eloRatings(gamesXg, { passes: 3 }),
    kpis, exploitability, pairwise, games, matches: results.length, wallMs,
  };
}

export { TEAMS };
