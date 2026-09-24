/**
 * Boucle d'auto-cohérence (§11.6) : on collecte pendant l'auto-jeu les paires (probabilité attendue, issue réelle)
 * des passes (expectedP de la trajectoire ou valeur de l'événement `pass`) et des tirs (xG vs but),
 * puis on rapporte le score de Brier et le diagramme de fiabilité avant/après un recalibrage logistique
 * (Platt : p' = σ(a·logit(p) + b)) ajusté par Newton–Raphson avec ridge 1e-3.
 */
import type { Decision, MatchEvent, MatchState, PassModel, SimParams, TeamId, ThroughModel } from '../core/types';
import { mean } from '../core/stats';
import { dist } from '../core/vec2';
import { interceptionFeatures, interceptionModelOf, rescoreInterception, arrivalLogistic, type InterceptionFeatures, type InterceptionModel } from '../models/interception';
import { getPlayer, passLogit } from '../models/probability';
import { pressureAt } from '../models/fields';
import { timeToArrive } from '../models/motion';
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
 * Équipe du PASSEUR d'un événement d'issue de passe : le moteur attribue `pass_intercepted` à l'équipe de l'intercepteur
 * et met le frappeur dans `targetId` ; les autres issues portent l'équipe du passeur / receveur. Apparier les
 * interceptions par `o.team` mélangeait les issues des deux équipes (table de fiabilité plate, pente de Platt ≈ 0,05 :
 * bogue corrigé). `kickerTeam` (frappeur → équipe, connu des sources) tranche ; sans frappeur connu, `o.team` est gardé
 * (journaux synthétiques qui attribuent déjà l'interception au passeur).
 */
function passerTeamOf(o: MatchEvent, kickerTeam: ReadonlyMap<number, TeamId>): TeamId {
  if (o.kind === 'pass_intercepted' && o.targetId !== undefined) {
    const t = kickerTeam.get(o.targetId);
    if (t) return t;
  }
  return o.team;
}

/**
 * Extrait les paires (p, y) d'un résultat de match (journal d'événements et trajectoires requis :
 * option `collectEvents`). Les passes sont appariées avec l'issue suivante de l'équipe du passeur
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
    const sources: { team: TeamId; p: number; time: number; kickerId?: number }[] = flightsWithP.length
      ? flightsWithP.map((f) => ({ team: f.team, p: f.expectedP as number, time: f.startTime, kickerId: f.kickerId }))
      : events.filter((e) => e.kind === 'pass' && typeof e.value === 'number').map((e) => ({ team: e.team, p: e.value as number, time: e.time, kickerId: e.playerId }));
    const kickerTeam = new Map<number, TeamId>();
    for (const s of sources) if (s.kickerId !== undefined) kickerTeam.set(s.kickerId, s.team);
    const outcomes = events.filter((e) => PASS_OUTCOMES.has(e.kind)).sort((a, b) => a.time - b.time);
    const queue = [...sources].sort((a, b) => a.time - b.time);
    let qi = 0;
    for (const o of outcomes) {
      while (qi < queue.length && queue[qi].time <= o.time + 1e-9) { pending[queue[qi].team].push({ p: queue[qi].p, time: queue[qi].time }); qi++; }
      const list = pending[passerTeamOf(o, kickerTeam)];
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

// ---------------------------------------------------------------------------
// Calibration de l'interception (η, σ_T, w) sur les caractéristiques brutes des passes jouées (§11.6)
// ---------------------------------------------------------------------------
export type PassFlightKind = 'pass' | 'through' | 'lob';

/** Une passe exécutée, avec tout ce qu'il faut pour recalculer P_pass sous un autre modèle d'interception. */
export interface PassFeatureRecord {
  team: TeamId;
  kickerId: number;
  time: number;
  kind: PassFlightKind;
  distance: number;
  arrivalSpeed: number;
  /** Partie d'exécution σ(logit) de P (indépendante de η et σ_T) ; 0 si le receveur était hors-jeu (profondeur). */
  pExec: number;
  /** Caractéristiques du logit (§5.1 : d, excédent > 30 m, Π(b), Π(q_r), excédent de vitesse, attribut ; §5.2 : d, Π(b), attribut)
   * pour réajuster les coefficients (§11.6) ; `offside` : receveur hors-jeu (P = 0 quel que soit le modèle). */
  logitFeatures: { d: number; longExcess: number; piBall: number; piTarget: number; speedExcess: number; skill: number; lob: number; offside: number };
  /** Profondeur : avances (s) du receveur sur le premier défenseur (`lead`) et du ballon + δ_reach sur le receveur (`reachLead`). */
  lead?: number;
  reachLead?: number;
  features: InterceptionFeatures;
  /** Probabilité annoncée par la décision au moment de la frappe. */
  expectedP: number;
  /** Issue réalisée (1 = passe réussie) et sa nature (pass_complete / pass_intercepted / pass_failed / offside), attachées par `attachPassOutcomes`. */
  outcome?: 0 | 1;
  outcomeKind?: MatchEvent['kind'];
}

/** Indicateur « ballon pris par un adversaire » (interception au sens du moteur : toute prise adverse après la passe). */
export const intercepted = (r: PassFeatureRecord): 0 | 1 => (r.outcomeKind === 'pass_intercepted' ? 1 : 0);

/** Coefficients logistiques réajustables (§11.6) : passe au pied et passe en profondeur. */
export interface PassCoefficients { pass: PassModel; through: ThroughModel; attributeInfluence: number }

export const passCoefficientsOf = (params: SimParams): PassCoefficients => ({ pass: params.models.pass, through: params.models.through, attributeInfluence: params.models.attributeInfluence ?? 0.6 });

/** Partie d'exécution σ(logit) recalculée avec d'autres coefficients (mêmes formules que `passLogit` / §5.2). */
export function rescoreExecution(rec: PassFeatureRecord, coefs: PassCoefficients): number {
  const f = rec.logitFeatures;
  if (f.offside) return 0;
  if (rec.kind === 'through') {
    const c = coefs.through;
    return sigmoid(c.base + c.distance * f.d + c.passerPressure * f.piBall + coefs.attributeInfluence * f.skill);
  }
  const c = coefs.pass;
  const logit = c.base + c.distance * f.d + c.longDistance * f.longExcess + c.passerPressure * f.piBall + c.receiverPressure * f.piTarget
    + (c.arrivalSpeed ?? -0.1) * f.speedExcess + coefs.attributeInfluence * f.skill + (f.lob ? (c.lobPenalty ?? -1.5) : 0);
  return sigmoid(logit);
}

/**
 * P_pass recalculée pour un modèle d'interception donné (§5.1–5.2 : (1 − P_int)·[receveur en premier]·[au rendez-vous]·σ(logit)) ;
 * `coefs` remplace les coefficients logistiques (sinon la partie d'exécution enregistrée).
 */
export function rescorePassRecord(rec: PassFeatureRecord, model: InterceptionModel, coefs?: PassCoefficients): number {
  let p = (1 - rescoreInterception(rec.features, model)) * (coefs ? rescoreExecution(rec, coefs) : rec.pExec);
  if (rec.kind === 'through') {
    const inv = 1 / Math.max(1e-6, model.sigma);
    if (rec.lead !== undefined) p *= arrivalLogistic(rec.lead * inv);
    if (rec.reachLead !== undefined && Number.isFinite(rec.reachLead)) p *= arrivalLogistic(rec.reachLead * inv);
  }
  return Math.min(1, Math.max(0, p));
}

export interface PassFeatureCollector {
  /** Rappel à brancher sur `RunMatchOptions.onDecisions` (appelé après l'exécution des actions du cycle). */
  onDecisions: (decisions: Map<number, Decision>, state: MatchState) => void;
  records: PassFeatureRecord[];
}

/**
 * Collecteur des caractéristiques de chaque passe exécutée (auto-jeu, §11.6) : à chaque nouvelle trajectoire de passe
 * (pass / through / lob), la décision du frappeur donne la cible et la vitesse voulues ; les avances Δ_{j,m} et la partie
 * d'exécution sont recalculées sur l'état du cycle (un pas de 1/30 s après la frappe, joueurs quasi immobiles) depuis
 * l'origine réelle du ballon. Aucune dépendance au moteur au-delà de `MatchState`.
 */
export function createPassFeatureCollector(params: SimParams): PassFeatureCollector {
  const records: PassFeatureRecord[] = [];
  let lastStart = -Infinity;
  const onDecisions = (decisions: Map<number, Decision>, state: MatchState): void => {
    const f = state.ball.flight;
    if (!f || f.startTime === lastStart) return;
    if (f.kind !== 'pass' && f.kind !== 'through' && f.kind !== 'lob') return;
    lastStart = f.startTime;
    const decision = decisions.get(f.kickerId);
    if (!decision || decision.chosen.action.type !== 'pass' || !state.fields) return;
    const a = decision.chosen.action;
    const kicker = getPlayer(state, f.kickerId);
    const team = kicker.team;
    const origin = f.origin;
    const target = a.targetPoint;
    const ph = params.physics;
    const speed = a.speed > 0 ? a.speed : f.kind === 'through' ? ph.throughArrivalSpeed : ph.passArrivalSpeed;
    const features = interceptionFeatures(state, origin, target, f.kind, team, params, speed);
    const d = dist(origin, target);
    const rec: PassFeatureRecord = {
      team, kickerId: f.kickerId, time: f.startTime, kind: f.kind, distance: d, arrivalSpeed: speed,
      pExec: 0, features, expectedP: f.expectedP ?? decision.chosen.probability,
      logitFeatures: { d, longExcess: Math.max(0, d - 30), piBall: 0, piTarget: 0, speedExcess: 0, skill: kicker.attrs.passing - 0.5, lob: f.kind === 'lob' ? 1 : 0, offside: f.receiverOffside ? 1 : 0 },
    };
    if (f.kind === 'through') {
      const c = params.models.through;
      const m = params.models;
      const receiver = getPlayer(state, a.targetId);
      rec.logitFeatures.piBall = pressureAt(state, origin, team, params);
      const tReceiver = timeToArrive(receiver.pos, receiver.vel, target, receiver.maxSpeed, receiver.maxAccel, m);
      let tOpp = Infinity;
      for (const o of state.players) {
        if (o.team === team) continue;
        const t = timeToArrive(o.pos, o.vel, target, o.maxSpeed, o.maxAccel, m);
        if (t < tOpp) tOpp = t;
      }
      rec.lead = tOpp === Infinity ? 10 : tOpp - tReceiver;
      rec.reachLead = features.travelTime + (c.reachSlack ?? 0.6) - tReceiver;
    } else {
      const lg = passLogit(state, state.fields, kicker, origin, target, params, speed, f.kind === 'lob');
      const val = (key: string): number => lg.features.find((x) => x.key === key)?.value ?? 0;
      rec.logitFeatures.piBall = val('passerPressure');
      rec.logitFeatures.piTarget = val('receiverPressure');
      rec.logitFeatures.speedExcess = val('arrivalSpeed');
    }
    rec.pExec = rescoreExecution(rec, passCoefficientsOf(params));
    records.push(rec);
  };
  return { onDecisions, records };
}

/**
 * Attache à chaque enregistrement l'issue de la passe (FIFO par équipe sur le journal d'événements, comme
 * `collectCalibrationPairs`). Retourne les enregistrements appariés (les autres sont ignorés).
 */
export function attachPassOutcomes(records: readonly PassFeatureRecord[], events: readonly MatchEvent[]): PassFeatureRecord[] {
  const out: PassFeatureRecord[] = [];
  const pending: Record<TeamId, PassFeatureRecord[]> = { A: [], B: [] };
  const queue = [...records].sort((a, b) => a.time - b.time);
  const kickerTeam = new Map<number, TeamId>();
  for (const r of records) kickerTeam.set(r.kickerId, r.team);
  const outcomes = events.filter((e) => PASS_OUTCOMES.has(e.kind)).sort((a, b) => a.time - b.time);
  let qi = 0;
  for (const o of outcomes) {
    while (qi < queue.length && queue[qi].time <= o.time + 1e-9) { pending[queue[qi].team].push(queue[qi]); qi++; }
    const list = pending[passerTeamOf(o, kickerTeam)];
    if (!list.length) continue;
    const rec = list.shift()!;
    out.push({ ...rec, outcome: o.kind === 'pass_complete' ? 1 : 0, outcomeKind: o.kind });
  }
  return out;
}

export interface InterceptionGridPoint extends InterceptionModel {
  /** Brier de P_pass contre la réussite (objectif de la grille). */
  brier: number;
  ece: number;
  /** Brier de P_int seule contre l'indicateur « ballon pris par un adversaire » (critère §11.6, diagnostic). */
  brierIntercept: number;
}

export interface InterceptionCalibration {
  n: number;
  current: InterceptionGridPoint;
  best: InterceptionGridPoint;
  grid: InterceptionGridPoint[];
  /** Écart moyen |P annoncée − P recalculée (modèle courant)| : cohérence du recalcul avec la décision. */
  rescoreGap: number;
}

export const DEFAULT_ETA_GRID: readonly number[] = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];
export const DEFAULT_SIGMA_GRID: readonly number[] = [0.3, 0.4, 0.5, 0.7, 1.0];
export const DEFAULT_WINDOW_GRID: readonly number[] = [0, 1];

const pairsUnder = (records: readonly PassFeatureRecord[], model: InterceptionModel): CalibrationPair[] =>
  records.map((r) => ({ p: clampP(rescorePassRecord(r, model)), y: r.outcome ?? 0, kind: 'pass' as const }));
const interceptPairsUnder = (records: readonly PassFeatureRecord[], model: InterceptionModel): CalibrationPair[] =>
  records.map((r) => ({ p: clampP(rescoreInterception(r.features, model)), y: intercepted(r), kind: 'pass' as const }));

/**
 * Grille (η × σ_T × w) minimisant le Brier de P_pass sur les passes jouées (issue réelle) ; η_land est gardé. Le point
 * courant est `interceptionModelOf(params)`.
 */
export function calibrateInterception(records: readonly PassFeatureRecord[], params: SimParams, etas = DEFAULT_ETA_GRID, sigmas = DEFAULT_SIGMA_GRID, windows = DEFAULT_WINDOW_GRID): InterceptionCalibration {
  const current = interceptionModelOf(params);
  const evaluate = (model: InterceptionModel): InterceptionGridPoint => {
    const pairs = pairsUnder(records, model);
    return { ...model, brier: brierScore(pairs), ece: expectedCalibrationError(reliabilityTable(pairs)), brierIntercept: brierScore(interceptPairsUnder(records, model)) };
  };
  const grid: InterceptionGridPoint[] = [];
  for (const window of windows) for (const sigma of sigmas) for (const eta of etas) grid.push(evaluate({ eta, etaLand: current.etaLand, sigma, window }));
  const cur = evaluate(current);
  let best = cur;
  for (const g of grid) if (g.brier < best.brier - 1e-12) best = g;
  const gap = records.length ? mean(records.map((r) => Math.abs(r.expectedP - rescorePassRecord(r, current)))) : NaN;
  return { n: records.length, current: cur, best, grid, rescoreGap: gap };
}

export interface CoefficientFit {
  before: PassCoefficients;
  after: PassCoefficients;
  brierBefore: number;
  brierAfter: number;
  /** Ancrages §5.1 après réajustement (sans interception) : 15 m libre, 35 m sous pression Π(b) = 1 ; §5.2 : 20 m libre. */
  anchors: { pass15Free: number; pass35Pressed: number; through20Free: number };
}

/**
 * Réajustement contraint des coefficients logistiques (§11.6) sur les passes jouées, le modèle d'interception étant fixé :
 * grille par coordonnées sur (pass.base, pass.distance, pass.longDistance) et (through.base, through.distance), les autres
 * coefficients (pressions, vitesse, attribut, lob) inchangés ; objectif = Brier de P_pass. Trois balayages suffisent
 * (objectif lisse, 5 coordonnées). Les coefficients de pression ne sont pas réajustés : leur signal (pression subie au
 * moment de la passe) est confondu avec la sélection des passes par la politique elle-même.
 */
export function fitPassCoefficients(records: readonly PassFeatureRecord[], params: SimParams, model: InterceptionModel): CoefficientFit {
  const before = passCoefficientsOf(params);
  const objective = (c: PassCoefficients): number => (records.length ? mean(records.map((r) => (rescorePassRecord(r, model, c) - (r.outcome ?? 0)) ** 2)) : NaN);
  let cur: PassCoefficients = { pass: { ...before.pass }, through: { ...before.through }, attributeInfluence: before.attributeInfluence };
  let best = objective(cur);
  const grids: { get: (c: PassCoefficients) => number; set: (c: PassCoefficients, v: number) => void; values: number[] }[] = [
    { get: (c) => c.pass.base, set: (c, v) => { c.pass.base = v; }, values: range(1.0, 3.6, 0.1) },
    { get: (c) => c.pass.distance, set: (c, v) => { c.pass.distance = v; }, values: range(-0.06, 0, 0.005) },
    { get: (c) => c.pass.longDistance, set: (c, v) => { c.pass.longDistance = v; }, values: range(-0.06, 0, 0.01) },
    { get: (c) => c.through.base, set: (c, v) => { c.through.base = v; }, values: range(0.6, 3.6, 0.1) },
    { get: (c) => c.through.distance, set: (c, v) => { c.through.distance = v; }, values: range(-0.06, 0, 0.005) },
  ];
  if (records.length) {
    for (let sweep = 0; sweep < 3; sweep++) {
      for (const g of grids) {
        let bestV = g.get(cur);
        for (const v of g.values) {
          const trial: PassCoefficients = { pass: { ...cur.pass }, through: { ...cur.through }, attributeInfluence: cur.attributeInfluence };
          g.set(trial, v);
          const o = objective(trial);
          if (o < best - 1e-12) { best = o; bestV = v; }
        }
        g.set(cur, bestV);
      }
    }
  }
  cur = { pass: { ...cur.pass, base: round3(cur.pass.base), distance: round3(cur.pass.distance), longDistance: round3(cur.pass.longDistance) }, through: { ...cur.through, base: round3(cur.through.base), distance: round3(cur.through.distance) }, attributeInfluence: cur.attributeInfluence };
  const anchor = (c: PassCoefficients, d: number, pi: number): number => sigmoid(c.pass.base + c.pass.distance * d + c.pass.longDistance * Math.max(0, d - 30) + c.pass.passerPressure * pi);
  return {
    before, after: cur, brierBefore: objective(before), brierAfter: objective(cur),
    anchors: { pass15Free: anchor(cur, 15, 0), pass35Pressed: anchor(cur, 35, 1), through20Free: sigmoid(cur.through.base + cur.through.distance * 20) },
  };
}

const range = (lo: number, hi: number, step: number): number[] => { const out: number[] = []; for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000); return out; };
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function coefficientFitMarkdown(fit: CoefficientFit): string {
  const c = (x: PassCoefficients): string => `passe : base ${fmt(x.pass.base, 2)}, distance ${fmt(x.pass.distance, 3)}, > 30 m ${fmt(x.pass.longDistance, 3)} ; profondeur : base ${fmt(x.through.base, 2)}, distance ${fmt(x.through.distance, 3)}`;
  return [
    '### Coefficients logistiques (réajustement contraint, §11.6)', '',
    `- Avant : ${c(fit.before)} — Brier ${fmt(fit.brierBefore, 4)}`,
    `- Après : ${c(fit.after)} — Brier ${fmt(fit.brierAfter, 4)}`,
    `- Ancrages après (sans interception) : 15 m libre ${fmt(fit.anchors.pass15Free, 3)} ; 35 m sous pression Π(b) = 1 : ${fmt(fit.anchors.pass35Pressed, 3)} ; profondeur 20 m libre ${fmt(fit.anchors.through20Free, 3)}`, '',
  ].join('\n');
}

export const DISTANCE_BINS: readonly [number, number][] = [[0, 10], [10, 20], [20, 30], [30, Infinity]];

export interface BinReport { label: string; n: number; observed: number; interceptedRate: number; meanBefore: number; brierBefore: number; meanAfter: number; brierAfter: number }

/** Brier et fréquences par classe (distance, type, vitesse d'arrivée) sous deux modèles (interception, et coefficients optionnels « après »). */
export function binReports(records: readonly PassFeatureRecord[], before: InterceptionModel, after: InterceptionModel, key: (r: PassFeatureRecord) => string, order: readonly string[], coefsAfter?: PassCoefficients): BinReport[] {
  const groups = new Map<string, PassFeatureRecord[]>();
  for (const r of records) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const labels = [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k))];
  return labels.map((label) => {
    const rs = groups.get(label)!;
    const pb = pairsUnder(rs, before), pa = coefsAfter ? rs.map((r) => ({ p: clampP(rescorePassRecord(r, after, coefsAfter)), y: r.outcome ?? 0, kind: 'pass' as const })) : pairsUnder(rs, after);
    return { label, n: rs.length, observed: mean(rs.map((r) => r.outcome ?? 0)), interceptedRate: mean(rs.map(intercepted)), meanBefore: mean(pb.map((q) => q.p)), brierBefore: brierScore(pb), meanAfter: mean(pa.map((q) => q.p)), brierAfter: brierScore(pa) };
  });
}

export const distanceBinLabel = (d: number): string => {
  for (const [lo, hi] of DISTANCE_BINS) if (d >= lo && d < hi) return hi === Infinity ? `${lo}+ m` : `${lo}–${hi} m`;
  return '?';
};
export const DISTANCE_BIN_ORDER: readonly string[] = DISTANCE_BINS.map(([lo, hi]) => (hi === Infinity ? `${lo}+ m` : `${lo}–${hi} m`));

const modelLabel = (m: InterceptionModel): string => `η = ${fmt(m.eta, 2)}, σ_T = ${fmt(m.sigma, 2)} s, w = ${m.window}`;

/**
 * Section Markdown de la calibration de l'interception : grille, tables de fiabilité avant/après, Brier par classe.
 * `fit` : les colonnes « après » utilisent aussi les coefficients réajustés.
 */
export function interceptionCalibrationMarkdown(cal: InterceptionCalibration, records: readonly PassFeatureRecord[], fit?: CoefficientFit): string {
  const coefsAfter = fit?.after;
  const afterPairs = coefsAfter ? records.map((r) => ({ p: clampP(rescorePassRecord(r, cal.best, coefsAfter)), y: r.outcome ?? 0, kind: 'pass' as const })) : pairsUnder(records, cal.best);
  const lines: string[] = ['### Interception (η, σ_T, w) — une chance par défenseur (§4.6, §11.6)', ''];
  if (!cal.n) { lines.push('_Aucune passe enregistrée._', ''); return lines.join('\n'); }
  lines.push(`- Effectif : ${cal.n} passes jouées (réussite observée ${fmtPct(mean(records.map((r) => r.outcome ?? 0)))}) ; écart moyen entre P annoncée et P recalculée sous le modèle courant : ${fmt(cal.rescoreGap, 3)}`);
  lines.push(`- Modèle courant (${modelLabel(cal.current)}) : Brier ${fmt(cal.current.brier, 4)}, ECE ${fmt(cal.current.ece, 3)} ; Brier de P_int seule contre « ballon pris par un adversaire » ${fmt(cal.current.brierIntercept, 4)}`);
  lines.push(`- Meilleur point de la grille (${modelLabel(cal.best)}) : Brier ${fmt(cal.best.brier, 4)}, ECE ${fmt(cal.best.ece, 3)} ; Brier de P_int ${fmt(cal.best.brierIntercept, 4)}`, '');
  // Grille condensée : Brier par (σ_T, w) en fonction de η.
  const etas = [...new Set(cal.grid.map((g) => g.eta))].sort((a, b) => a - b);
  const combos = [...new Set(cal.grid.map((g) => `${g.sigma}|${g.window}`))];
  const rows = combos.map((c) => {
    const [sigma, window] = c.split('|').map(Number);
    return [`σ_T = ${fmt(sigma, 1)}, w = ${window}`, ...etas.map((eta) => { const g = cal.grid.find((x) => x.eta === eta && x.sigma === sigma && x.window === window)!; return fmt(g.brier, 4); })];
  });
  lines.push(mdTable(['Brier \\ η', ...etas.map((e) => fmt(e, 2))], rows), '');
  const tb = reliabilityTable(pairsUnder(records, cal.current)), ta = reliabilityTable(afterPairs);
  lines.push(`Fiabilité de P_pass avant (modèle courant) / après (meilleur point${coefsAfter ? ' + coefficients réajustés' : ''}) : Brier ${fmt(brierScore(pairsUnder(records, cal.current)), 4)} → ${fmt(brierScore(afterPairs), 4)}, ECE ${fmt(expectedCalibrationError(tb), 3)} → ${fmt(expectedCalibrationError(ta), 3)}`, '');
  lines.push(mdTable(['Classe', 'n (avant)', 'p̄ prédit', 'fréq. observée', 'n (après)', 'p̄ prédit', 'fréq. observée'], tb.map((b, i) => {
    const a = ta[i];
    return [`[${fmt(b.low, 1)} ; ${fmt(b.high, 1)})`, b.count, b.count ? fmt(b.meanPredicted, 3) : '—', b.count ? fmt(b.observed, 3) : '—', a.count, a.count ? fmt(a.meanPredicted, 3) : '—', a.count ? fmt(a.observed, 3) : '—'];
  })), '');
  const binTable = (title: string, reps: BinReport[]): void => {
    lines.push(title, '');
    lines.push(mdTable(['Classe', 'n', 'réussite observée', 'prise adverse', 'p̄ avant', 'Brier avant', 'p̄ après', 'Brier après'], reps.map((b) => [b.label, b.n, fmtPct(b.observed), fmtPct(b.interceptedRate), fmt(b.meanBefore, 3), fmt(b.brierBefore, 4), fmt(b.meanAfter, 3), fmt(b.brierAfter, 4)])), '');
  };
  binTable('Par distance :', binReports(records, cal.current, cal.best, (r) => distanceBinLabel(r.distance), DISTANCE_BIN_ORDER, coefsAfter));
  binTable('Par type de passe :', binReports(records, cal.current, cal.best, (r) => r.kind, ['pass', 'through', 'lob'], coefsAfter));
  binTable('Par vitesse d’arrivée (passes au sol) :', binReports(records.filter((r) => r.kind === 'pass'), cal.current, cal.best, (r) => `${fmt(r.arrivalSpeed, 0)} m/s`, ['4 m/s', '6 m/s', '9 m/s', '10 m/s'], coefsAfter));
  if (fit) lines.push(coefficientFitMarkdown(fit));
  return lines.join('\n');
}
