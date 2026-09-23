/**
 * Optimisation hors-ligne des poids (§10) : méthode d'entropie croisée (CEM) générique, avec
 * recherche aléatoire et (1+1)-ES comme baselines d'optimisation, correspondance vecteur ⇄ paramètres,
 * et fitness par matchs contre un pool d'adversaires gelé (nombres aléatoires communs).
 */
import type { MatchConfig, SimParams, StyleId, TacticConfig, TeamId } from '../core/types';
import { STYLE_IDS } from '../core/types';
import { DEFAULT_PARAMS, applyFlatParams, flattenParams } from '../core/params';
import { Rng } from '../core/rng';
import { confidenceInterval, mean, std } from '../core/stats';
import { runBatch, type BatchOptions } from './worker-pool';
import { runMatchTask, type MatchTask, type RunMatchOptions } from './runner';
import { turnoverDanger } from './metrics';
import { NATURAL_FORMATION, naturalProfiles } from './tournament';
import { FULL_POLICY_NAME, makeConfig } from './cli';

// ---------------------------------------------------------------------------
// Vecteur ϑ ⇄ paramètres
// ---------------------------------------------------------------------------
export const DEFAULT_OPTIM_PATHS: string[] = [
  'decision.wProgress', 'decision.wSupport', 'decision.wLineBreaks', 'decision.wTime', 'decision.lambdaRisk', 'decision.gamma', 'decision.hysteresis',
  'offBall.wReceivable', 'offBall.wSpace', 'offBall.wTeamExposure', 'offBall.wSlot', 'offBall.wSeparation', 'offBall.wRun',
  'defence.muPriority', 'defence.nuShape', 'defence.xiHysteresis',
  'models.interceptEfficiency', 'models.arrivalSigma', 'models.controlBeta',
];

export function vectorToFlat(theta: ArrayLike<number>, paths: readonly string[] = DEFAULT_OPTIM_PATHS): Record<string, number> {
  const out: Record<string, number> = {};
  paths.forEach((p, i) => { out[p] = theta[i]; });
  return out;
}

export function flatToVector(flat: Record<string, number>, paths: readonly string[] = DEFAULT_OPTIM_PATHS): Float64Array {
  return Float64Array.from(paths, (p) => {
    const v = flat[p];
    if (v === undefined) throw new Error(`paramètre absent : ${p}`);
    return v;
  });
}

export const paramsToVector = (params: SimParams, paths: readonly string[] = DEFAULT_OPTIM_PATHS): Float64Array => flatToVector(flattenParams(params), paths);

export const vectorToParams = (theta: ArrayLike<number>, paths: readonly string[] = DEFAULT_OPTIM_PATHS, base: SimParams = DEFAULT_PARAMS): SimParams =>
  applyFlatParams(base, vectorToFlat(theta, paths));

/** Paramètres strictement positifs par défaut ⇒ optimisés en espace log. */
export const defaultLogSpace = (paths: readonly string[] = DEFAULT_OPTIM_PATHS, base: SimParams = DEFAULT_PARAMS): boolean[] => {
  const flat = flattenParams(base);
  return paths.map((p) => (flat[p] ?? 0) > 0);
};

/** σ₀ = `rel` × valeur par défaut (minimum `floor` pour les valeurs nulles). */
export const defaultSigma0 = (paths: readonly string[] = DEFAULT_OPTIM_PATHS, base: SimParams = DEFAULT_PARAMS, rel = 0.3, floor = 0.01): Float64Array => {
  const flat = flattenParams(base);
  return Float64Array.from(paths, (p) => Math.max(floor, rel * Math.abs(flat[p] ?? 0)));
};

// ---------------------------------------------------------------------------
// Optimiseurs
// ---------------------------------------------------------------------------
export type FitnessFn = (theta: Float64Array, generation: number, seeds: number[]) => number | Promise<number>;

export interface GenerationRecord {
  generation: number;
  meanFitness: number;
  bestFitness: number;
  /** IC 95 % (Student) de la fitness de la population. */
  ci: { low: number; high: number };
  mu: number[];
  sigma: number[];
  best: number[];
  evaluations: number;
  seeds: number[];
  wallMs: number;
}

export interface OptimizerOptions {
  dims: number;
  mu0: ArrayLike<number>;
  sigma0: ArrayLike<number>;
  population?: number;
  elites?: number;
  generations: number;
  minSigma?: number;
  /** Dimensions optimisées en espace log (paramètres positifs). */
  logSpace?: boolean[];
  fitness: FitnessFn;
  rng: Rng;
  /** Nombre de graines (nombres aléatoires communs) tirées par génération. */
  seedsPerGeneration?: number;
  onGeneration?: (record: GenerationRecord) => void;
  lower?: ArrayLike<number>;
  upper?: ArrayLike<number>;
  /** Évaluer la population en parallèle (Promise.all) — utile avec un pool de workers. */
  concurrent?: boolean;
}

export interface OptimizerResult {
  best: Float64Array;
  bestFitness: number;
  mu: Float64Array;
  sigma: Float64Array;
  history: GenerationRecord[];
  evaluations: number;
}

interface Space {
  encode(theta: ArrayLike<number>): Float64Array;
  decode(z: ArrayLike<number>): Float64Array;
  sigmaToZ(sigma: ArrayLike<number>, mu: ArrayLike<number>): Float64Array;
}

function makeSpace(opts: OptimizerOptions): Space {
  const log = opts.logSpace ?? new Array(opts.dims).fill(false);
  const lower = opts.lower, upper = opts.upper;
  const clip = (i: number, v: number): number => {
    if (lower && v < lower[i]) v = lower[i];
    if (upper && v > upper[i]) v = upper[i];
    if (log[i] && v <= 0) v = 1e-6;
    return v;
  };
  return {
    encode: (theta) => Float64Array.from({ length: opts.dims }, (_, i) => (log[i] ? Math.log(Math.max(1e-9, theta[i])) : theta[i])),
    decode: (z) => Float64Array.from({ length: opts.dims }, (_, i) => clip(i, log[i] ? Math.exp(z[i]) : z[i])),
    sigmaToZ: (sigma, mu) => Float64Array.from({ length: opts.dims }, (_, i) => (log[i] ? sigma[i] / Math.max(1e-9, Math.abs(mu[i])) : sigma[i])),
  };
}

const drawSeeds = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.int(1, 2 ** 31 - 1));

async function evaluateAll(fitness: FitnessFn, thetas: Float64Array[], generation: number, seeds: number[], concurrent: boolean): Promise<number[]> {
  if (concurrent) return Promise.all(thetas.map((t) => fitness(t, generation, seeds)));
  const out: number[] = [];
  for (const t of thetas) out.push(await fitness(t, generation, seeds));
  return out;
}

const record = (generation: number, fits: number[], mu: Float64Array, sigma: Float64Array, best: Float64Array, evaluations: number, seeds: number[], wallMs: number): GenerationRecord => {
  const ci = confidenceInterval(fits);
  return { generation, meanFitness: mean(fits), bestFitness: fits.length ? Math.max(...fits) : -Infinity, ci: { low: ci.low, high: ci.high }, mu: Array.from(mu), sigma: Array.from(sigma), best: Array.from(best), evaluations, seeds, wallMs };
};

/**
 * Méthode d'entropie croisée : ϑ ~ N(μ, diag σ²) (en espace log pour les dimensions `logSpace`),
 * μ ← moyenne des élites, σ ← max(écart-type des élites, minSigma). Graines communes par génération.
 */
export async function cem(opts: OptimizerOptions): Promise<OptimizerResult> {
  const population = opts.population ?? 32, elites = opts.elites ?? 8, minSigma = opts.minSigma ?? 0.02;
  const nSeeds = opts.seedsPerGeneration ?? 8;
  const space = makeSpace(opts);
  let mu = space.encode(opts.mu0);
  let sigma = space.sigmaToZ(opts.sigma0, opts.mu0);
  let best = space.decode(mu), bestFitness = -Infinity, evaluations = 0;
  const history: GenerationRecord[] = [];
  for (let g = 0; g < opts.generations; g++) {
    const t0 = performance.now();
    const seeds = drawSeeds(opts.rng, nSeeds);
    const zs = Array.from({ length: population }, () => Float64Array.from(mu, (m, i) => m + sigma[i] * opts.rng.normal()));
    const thetas = zs.map((z) => space.decode(z));
    const fits = await evaluateAll(opts.fitness, thetas, g, seeds, opts.concurrent ?? false);
    evaluations += population;
    const order = fits.map((f, i) => i).sort((a, b) => fits[b] - fits[a]);
    const eliteIdx = order.slice(0, Math.min(elites, population));
    if (fits[order[0]] > bestFitness || g === 0) { bestFitness = fits[order[0]]; best = thetas[order[0]]; }
    // On ré-encode les élites (après bornage) pour la mise à jour.
    const eliteZ = eliteIdx.map((i) => space.encode(thetas[i]));
    mu = Float64Array.from({ length: opts.dims }, (_, d) => mean(eliteZ.map((z) => z[d])));
    sigma = Float64Array.from({ length: opts.dims }, (_, d) => Math.max(minSigma, std(eliteZ.map((z) => z[d]))));
    const rec = record(g, fits, space.decode(mu), sigma, best, evaluations, seeds, performance.now() - t0);
    history.push(rec);
    opts.onGeneration?.(rec);
  }
  return { best, bestFitness, mu: space.decode(mu), sigma, history, evaluations };
}

/** Recherche aléatoire : `population` tirages par génération autour de (μ₀, σ₀), sans mise à jour. */
export async function randomSearch(opts: OptimizerOptions): Promise<OptimizerResult> {
  const population = opts.population ?? 32;
  const nSeeds = opts.seedsPerGeneration ?? 8;
  const space = makeSpace(opts);
  const mu = space.encode(opts.mu0);
  const sigma = space.sigmaToZ(opts.sigma0, opts.mu0);
  let best = space.decode(mu), bestFitness = -Infinity, evaluations = 0;
  const history: GenerationRecord[] = [];
  for (let g = 0; g < opts.generations; g++) {
    const t0 = performance.now();
    const seeds = drawSeeds(opts.rng, nSeeds);
    const thetas = Array.from({ length: population }, () => space.decode(Float64Array.from(mu, (m, i) => m + sigma[i] * opts.rng.normal())));
    const fits = await evaluateAll(opts.fitness, thetas, g, seeds, opts.concurrent ?? false);
    evaluations += population;
    fits.forEach((f, i) => { if (f > bestFitness) { bestFitness = f; best = thetas[i]; } });
    const rec = record(g, fits, space.decode(mu), sigma, best, evaluations, seeds, performance.now() - t0);
    history.push(rec);
    opts.onGeneration?.(rec);
  }
  return { best, bestFitness, mu: space.decode(mu), sigma, history, evaluations };
}

/**
 * (1+1)-ES avec règle du 1/5 : une mutation par itération, `population` itérations par génération ;
 * le parent est ré-évalué à chaque génération avec les nouvelles graines communes.
 */
export async function onePlusOneEs(opts: OptimizerOptions): Promise<OptimizerResult> {
  const population = opts.population ?? 32, minSigma = opts.minSigma ?? 0.02;
  const nSeeds = opts.seedsPerGeneration ?? 8;
  const space = makeSpace(opts);
  let parentZ = space.encode(opts.mu0);
  let sigma = space.sigmaToZ(opts.sigma0, opts.mu0);
  let parentFit = -Infinity, evaluations = 0;
  const history: GenerationRecord[] = [];
  const up = 1.5, down = Math.pow(1.5, -0.25);
  for (let g = 0; g < opts.generations; g++) {
    const t0 = performance.now();
    const seeds = drawSeeds(opts.rng, nSeeds);
    parentFit = await opts.fitness(space.decode(parentZ), g, seeds);
    evaluations++;
    const fits: number[] = [];
    for (let k = 0; k < population; k++) {
      const childZ = Float64Array.from(parentZ, (z, i) => z + sigma[i] * opts.rng.normal());
      const child = space.decode(childZ);
      const f = await opts.fitness(child, g, seeds);
      evaluations++;
      fits.push(f);
      if (f >= parentFit) { parentFit = f; parentZ = space.encode(child); sigma = sigma.map((s) => s * up); }
      else sigma = sigma.map((s) => Math.max(minSigma, s * down));
    }
    const rec = record(g, fits, space.decode(parentZ), sigma, space.decode(parentZ), evaluations, seeds, performance.now() - t0);
    rec.bestFitness = parentFit;
    history.push(rec);
    opts.onGeneration?.(rec);
  }
  return { best: space.decode(parentZ), bestFitness: parentFit, mu: space.decode(parentZ), sigma, history, evaluations };
}

export type OptimizerName = 'cem' | 'random' | 'es';
export const OPTIMIZERS: Record<OptimizerName, (opts: OptimizerOptions) => Promise<OptimizerResult>> = { cem, random: randomSearch, es: onePlusOneEs };

// ---------------------------------------------------------------------------
// Fitness par matchs (§10)
// ---------------------------------------------------------------------------
/** Pool gelé d'adversaires : paramètres par défaut + les 3 dernières élites. */
export class OpponentPool {
  entries: Record<string, number>[] = [{}];
  constructor(public readonly keep = 3) {}
  add(flat: Record<string, number>): void {
    this.entries.push({ ...flat });
    while (this.entries.length > 1 + this.keep) this.entries.splice(1, 1);
  }
  pick(i: number): Record<string, number> { return this.entries[i % this.entries.length]; }
}

export interface MatchFitnessOptions {
  paths?: readonly string[];
  /** Matchs par évaluation (défaut 8) et durée (défaut 5 min). */
  matches?: number;
  minutes?: number;
  base?: SimParams;
  profiles?: TacticConfig[];
  pool?: OpponentPool;
  batch?: BatchOptions;
  /** Coefficients F = w.xg·E[ΔxG] + w.threat·E[Δmenace] − w.danger·E[danger des pertes]. */
  weights?: { xg: number; threat: number; danger: number };
  /** Pénalité appliquée par match dégénéré. */
  degeneratePenalty?: number;
  /** Seuils de dégénérescence : tirs/match, longueur moyenne de passe (m), part de possession. */
  guards?: { minShots: number; maxPassLength: number; minPossession: number };
  /** Options de match supplémentaires (tests : fonction de décision injectée). */
  matchOptions?: Omit<RunMatchOptions, 'onDecisions' | 'collectEvents'>;
}

export interface FitnessBreakdown {
  fitness: number; dxG: number; dThreat: number; danger: number; degenerate: number; matches: number;
}

export interface MatchFitness {
  fitness: FitnessFn;
  /** Détail de la dernière évaluation (débogage). */
  last: FitnessBreakdown | null;
  pool: OpponentPool;
  /** À appeler en fin de génération pour geler la meilleure élite dans le pool. */
  onGeneration: (record: GenerationRecord) => void;
  /** Construit les tâches d'une évaluation (exposé pour les tests). */
  tasks: (theta: ArrayLike<number>, seeds: number[]) => MatchTask[];
}

/** Choisit les tactiques d'un match de fitness de façon reproductible à partir de la graine. */
export function fitnessTactics(seed: number, profiles: readonly TacticConfig[]): [TacticConfig, TacticConfig] {
  const rng = new Rng(seed ^ 0x5bd1e995);
  return [rng.pick(profiles), rng.pick(profiles)];
}

export function makeMatchFitness(options: MatchFitnessOptions = {}): MatchFitness {
  const paths = options.paths ?? DEFAULT_OPTIM_PATHS;
  const matches = options.matches ?? 8, minutes = options.minutes ?? 5;
  const base = options.base ?? DEFAULT_PARAMS;
  const profiles = options.profiles ?? naturalProfiles(STYLE_IDS.filter((s) => s !== 'balanced') as StyleId[]);
  const pool = options.pool ?? new OpponentPool(3);
  const w = options.weights ?? { xg: 1, threat: 0.3, danger: 0.2 };
  const penalty = options.degeneratePenalty ?? 5;
  const guards = options.guards ?? { minShots: 0.5, maxPassLength: 40, minPossession: 0.2 };

  const tasks = (theta: ArrayLike<number>, seeds: number[]): MatchTask[] => {
    const candidate = vectorToFlat(theta, paths);
    const out: MatchTask[] = [];
    for (let i = 0; i < matches; i++) {
      const seed = seeds[i % seeds.length] + Math.floor(i / seeds.length) * 1000003;
      const [tA, tB] = fitnessTactics(seed, profiles);
      const candidateSide: TeamId = i % 2 === 0 ? 'A' : 'B';
      const oppSide: TeamId = candidateSide === 'A' ? 'B' : 'A';
      const config: MatchConfig = makeConfig({ seed, minutes, tacticA: tA, tacticB: tB, params: base });
      out.push({
        config,
        policies: { A: FULL_POLICY_NAME, B: FULL_POLICY_NAME },
        paramOverrides: { [candidateSide]: candidate, [oppSide]: pool.pick(i) } as MatchTask['paramOverrides'],
        options: { ...(options.matchOptions ?? {}), collectEvents: true },
      });
    }
    return out;
  };

  const self: MatchFitness = {
    pool,
    last: null,
    tasks,
    fitness: async (theta, _generation, seeds) => {
      const ts = tasks(theta, seeds);
      const results = await runBatch(ts, runMatchTask, { ...options.batch, workerTask: 'match' });
      let dxG = 0, dThreat = 0, danger = 0, degenerate = 0;
      results.forEach((r, i) => {
        const c: TeamId = i % 2 === 0 ? 'A' : 'B';
        const o: TeamId = c === 'A' ? 'B' : 'A';
        const kc = r.kpi![c], ko = r.kpi![o];
        dxG += kc.xG - ko.xG;
        dThreat += kc.threatCreated - ko.threatCreated;
        danger += r.eventLog ? turnoverDanger(r.eventLog, c) : 0;
        const passLen = r.structure?.[c].meanPassLength ?? 0;
        if (kc.shots < guards.minShots || passLen > guards.maxPassLength || kc.possessionShare < guards.minPossession) degenerate++;
      });
      const n = Math.max(1, results.length);
      const fitness = (w.xg * dxG + w.threat * dThreat - w.danger * danger) / n - penalty * (degenerate / n);
      self.last = { fitness, dxG: dxG / n, dThreat: dThreat / n, danger: danger / n, degenerate, matches: results.length };
      return fitness;
    },
    onGeneration: (rec) => pool.add(vectorToFlat(rec.best, paths)),
  };
  return self;
}

// ---------------------------------------------------------------------------
// Pilote complet
// ---------------------------------------------------------------------------
export interface OptimizeParamsOptions {
  optimizer?: OptimizerName;
  paths?: readonly string[];
  generations?: number;
  population?: number;
  elites?: number;
  matches?: number;
  minutes?: number;
  seed?: number;
  base?: SimParams;
  batch?: BatchOptions;
  onGeneration?: (record: GenerationRecord) => void;
  matchOptions?: MatchFitnessOptions['matchOptions'];
  minSigma?: number;
}

export interface OptimizeParamsResult {
  result: OptimizerResult;
  paths: string[];
  bestFlat: Record<string, number>;
  bestParams: SimParams;
  defaultFlat: Record<string, number>;
}

/** Optimise les poids par défaut avec la fitness par matchs et renvoie ϑ* et les paramètres correspondants. */
export async function optimizeParams(options: OptimizeParamsOptions = {}): Promise<OptimizeParamsResult> {
  const paths = [...(options.paths ?? DEFAULT_OPTIM_PATHS)];
  const base = options.base ?? DEFAULT_PARAMS;
  const fit = makeMatchFitness({ paths, matches: options.matches, minutes: options.minutes, base, batch: options.batch, matchOptions: options.matchOptions });
  const optimizer = OPTIMIZERS[options.optimizer ?? 'cem'];
  const result = await optimizer({
    dims: paths.length,
    mu0: paramsToVector(base, paths),
    sigma0: defaultSigma0(paths, base),
    logSpace: defaultLogSpace(paths, base),
    population: options.population ?? 32,
    elites: options.elites ?? 8,
    generations: options.generations ?? 25,
    minSigma: options.minSigma ?? 0.02,
    fitness: fit.fitness,
    rng: new Rng(options.seed ?? 2024),
    seedsPerGeneration: Math.min(8, options.matches ?? 8),
    concurrent: true,
    onGeneration: (rec) => { fit.onGeneration(rec); options.onGeneration?.(rec); },
  });
  const bestFlat = vectorToFlat(result.best, paths);
  return { result, paths, bestFlat, bestParams: applyFlatParams(base, bestFlat), defaultFlat: vectorToFlat(paramsToVector(base, paths), paths) };
}

export { NATURAL_FORMATION };
