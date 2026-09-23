/**
 * Exécution headless de matchs et de scénarios ; collecte des métriques.
 *
 * - `runMatch` : joue un match complet et renvoie score, statistiques, KPI dérivés, latences de décision,
 *   indicateurs de stabilité (changements d'intention / de cible) et structurels (compacité, hauteur de ligne,
 *   longueur de passe, courses en profondeur) échantillonnés toutes les 5 s.
 * - `runScenario` : injecte un état de scénario dans une simulation, enregistre la PREMIÈRE décision du
 *   protagoniste et mesure les KPI après `horizonSec` secondes.
 * - `runMatchTask` : variante sérialisable (politiques désignées par nom) pour les worker_threads.
 */
import type { Action, Decision, MatchConfig, MatchEvent, MatchStats, MoveIntent, SimParams, TeamId, MatchState, Player } from '../core/types';
import { TEAMS, attackDir, otherTeam } from '../core/types';
import { dist } from '../core/vec2';
import type { Vec2 } from '../core/vec2';
import { emptyStats } from '../core/state-builder';
import { applyFlatParams } from '../core/params';
import type { PolicySet } from '../decision/policy';
import type { DecideFn, Simulation, StepOptions } from '../engine/loop';
import { createSimulation } from '../engine/loop';
import * as structureModule from '../models/structure';
import { latencyPercentiles, teamKpis, type TeamKpi } from './metrics';
import { actionClassOf, isAcceptable, type ActionClass, type Scenario } from './scenarios';
import { isNotImplemented, makeConfig, resolvePolicy, FULL_POLICY_NAME } from './cli';

// ---------------------------------------------------------------------------
// Types de résultats
// ---------------------------------------------------------------------------
export interface LatencyStats {
  /** Par décision individuelle (ms). */
  count: number; mean: number; p50: number; p95: number; p99: number; max: number;
  /** Par cycle de décision (somme des 22 décisions, ms). */
  cycles: number; cycleMean: number; cycleP50: number; cycleP95: number; cycleP99: number;
}

export interface StabilityKpi {
  /** Changements d'intention du porteur par seconde de possession. */
  intentionChangeRate: number;
  /** Changements de cible des joueurs sans ballon (attaque) par joueur·seconde. */
  targetChangeRate: number;
  intentionChanges: number;
  carrierSeconds: number;
  targetChanges: number;
  offBallPlayerSeconds: number;
}

export interface StructuralKpi {
  samples: number;
  /** Étendue moyenne du bloc (10 joueurs de champ) en x et en y (m) et aire moyenne de l'enveloppe convexe (m²). */
  spanX: number; spanY: number; hullArea: number;
  /** Hauteur moyenne de la ligne défensive (repère équipe, m ; plus grand = ligne plus haute), mesurée quand l'équipe défend. */
  defensiveLineHeight: number;
  /** Longueur moyenne des passes décidées (m) et nombre de passes. */
  meanPassLength: number; passCount: number;
  /** Nombre d'appels en profondeur (déplacements d'intention « run » déclenchés). */
  deepRuns: number;
}

export interface FlightRecord {
  kind: string; kickerId: number; targetId: number | null; team: TeamId; startTime: number; expectedP?: number;
}

export interface MatchResult {
  seed: number;
  score: Record<TeamId, number>;
  stats: MatchStats;
  durationSec: number;
  wallMs: number;
  /** Nombre d'événements observés. */
  events?: number;
  kpi?: Record<TeamId, TeamKpi>;
  latency?: LatencyStats;
  stability?: Record<TeamId, StabilityKpi>;
  structure?: Record<TeamId, StructuralKpi>;
  /** Journal complet des événements (option `collectEvents`). */
  eventLog?: MatchEvent[];
  /** Trajectoires de balle observées avec leur probabilité attendue (calibration). */
  flightLog?: FlightRecord[];
  /** Noms des politiques utilisées (si connus). */
  policies?: Record<TeamId, string>;
}

export interface RunMatchOptions {
  /** Conserver le journal des événements et des trajectoires (calibration). */
  collectEvents?: boolean;
  /** Période d'échantillonnage des indicateurs structurels (s). */
  structureEvery?: number;
  /** Rappel supplémentaire à chaque cycle de décision. */
  onDecisions?: StepOptions['onDecisions'];
  /** Étiquettes des politiques (pour le résultat). */
  policyNames?: Record<TeamId, string>;
  /** Fonction de décision injectée (tests, baselines factices) — remplace `decideAll`. */
  decide?: DecideFn;
}

// ---------------------------------------------------------------------------
// Collecte
// ---------------------------------------------------------------------------
const actionSignature = (a: Action): string => {
  switch (a.type) {
    case 'pass': return `pass:${a.targetId}:${a.kind}`;
    case 'dribble': return `dribble:${Math.round(Math.atan2(a.direction.y, a.direction.x) / (Math.PI / 4))}`;
    case 'shoot': return 'shoot';
    case 'hold': return 'hold';
    case 'clear': return 'clear';
    case 'move': return `move:${a.intent}`;
  }
};

/** Aire de l'enveloppe convexe (chaîne monotone d'Andrew). */
export function convexHullArea(points: readonly Vec2[]): number {
  if (points.length < 3) return 0;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let area = 0;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; area += a.x * b.y - b.x * a.y; }
  return Math.abs(area) / 2;
}

/** Compacité d'une équipe : modèle `structure.compactness` s'il est implémenté, sinon calcul local. */
export function teamCompactness(state: MatchState, team: TeamId): { hullArea: number; spanX: number; spanY: number } {
  try {
    return structureModule.compactness(state, team);
  } catch (err) {
    if (!isNotImplemented(err)) throw err;
    const pts = state.players.filter((p) => p.team === team && p.role !== 'GK').map((p) => p.pos);
    if (!pts.length) return { hullArea: 0, spanX: 0, spanY: 0 };
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { hullArea: convexHullArea(pts), spanX: Math.max(...xs) - Math.min(...xs), spanY: Math.max(...ys) - Math.min(...ys) };
  }
}

/** Hauteur de la ligne défensive (repère équipe) : moyenne des x' des défenseurs (rôle DF). */
export function defensiveLineHeight(state: MatchState, team: TeamId): number {
  const dir = attackDir(team);
  const dfs = state.players.filter((p) => p.team === team && p.role === 'DF');
  const pool = dfs.length ? dfs : state.players.filter((p) => p.team === team && p.role !== 'GK').sort((a, b) => dir * a.pos.x - dir * b.pos.x).slice(0, 4);
  return pool.length ? pool.reduce((s, p) => s + dir * p.pos.x, 0) / pool.length : 0;
}

interface TeamAccumulator {
  intentionChanges: number; carrierCycles: number; targetChanges: number; offBallPlayerCycles: number;
  spanX: number; spanY: number; hullArea: number; structSamples: number;
  lineHeight: number; lineSamples: number;
  passLength: number; passCount: number; deepRuns: number;
}

const newAccumulator = (): TeamAccumulator => ({
  intentionChanges: 0, carrierCycles: 0, targetChanges: 0, offBallPlayerCycles: 0,
  spanX: 0, spanY: 0, hullArea: 0, structSamples: 0, lineHeight: 0, lineSamples: 0, passLength: 0, passCount: 0, deepRuns: 0,
});

export interface MatchCollector {
  onDecisions: (decisions: Map<number, Decision>, state: MatchState) => void;
  /** Rattrape les événements produits après le dernier cycle. */
  flush: (state: MatchState) => void;
  finish: (state: MatchState, config: MatchConfig, wallMs: number) => MatchResult;
  readonly eventLog: MatchEvent[];
  readonly flightLog: FlightRecord[];
}

/** Crée le collecteur de métriques branché sur `onDecisions`. */
export function createMatchCollector(options: RunMatchOptions = {}): MatchCollector {
  const structureEvery = options.structureEvery ?? 5;
  const collectEvents = options.collectEvents ?? false;
  const decisionMs: number[] = [];
  const cycleMs: number[] = [];
  const eventLog: MatchEvent[] = [];
  const flightLog: FlightRecord[] = [];
  let eventCount = 0;
  let lastEvent: MatchEvent | null = null;
  let lastEventTime = -Infinity;
  let lastFlightStart = -Infinity;
  let lastStructureTime = -Infinity;
  let lastCarrier: { id: number; sig: string } | null = null;
  const prevTargets = new Map<number, Vec2>();
  const prevIntent = new Map<number, MoveIntent | null>();
  const acc: Record<TeamId, TeamAccumulator> = { A: newAccumulator(), B: newAccumulator() };
  let cycleTime = 0; // s, durée d'un cycle (estimée par différence de temps entre cycles)
  let prevCycleTime = -Infinity;

  const scanEvents = (state: MatchState): void => {
    const evs = state.events;
    let start = 0;
    if (lastEvent) {
      const idx = evs.lastIndexOf(lastEvent);
      if (idx >= 0) start = idx + 1;
      else { // journal tronqué : on prend les événements strictement postérieurs
        start = 0;
        while (start < evs.length && evs[start].time <= lastEventTime) start++;
      }
    }
    for (let i = start; i < evs.length; i++) {
      const e = evs[i];
      eventCount++;
      if (collectEvents) eventLog.push({ ...e, pos: e.pos ? { ...e.pos } : undefined });
    }
    if (evs.length) { lastEvent = evs[evs.length - 1]; lastEventTime = lastEvent.time; }
  };

  const scanFlight = (state: MatchState): void => {
    const f = state.ball.flight;
    if (!f || f.startTime === lastFlightStart) return;
    lastFlightStart = f.startTime;
    if (!collectEvents) return;
    const kicker = state.players.find((p) => p.id === f.kickerId);
    flightLog.push({ kind: f.kind, kickerId: f.kickerId, targetId: f.targetId, team: kicker?.team ?? 'A', startTime: f.startTime, expectedP: f.expectedP });
  };

  const sampleStructure = (state: MatchState): void => {
    for (const team of TEAMS) {
      const c = teamCompactness(state, team);
      const a = acc[team];
      a.spanX += c.spanX; a.spanY += c.spanY; a.hullArea += c.hullArea; a.structSamples++;
      if (state.possession && state.possession !== team) { a.lineHeight += defensiveLineHeight(state, team); a.lineSamples++; }
    }
  };

  const onDecisions = (decisions: Map<number, Decision>, state: MatchState): void => {
    if (prevCycleTime > -Infinity && state.time > prevCycleTime) cycleTime = state.time - prevCycleTime;
    prevCycleTime = state.time;
    let cycle = 0;
    const byId = new Map<number, Player>();
    for (const p of state.players) byId.set(p.id, p);
    const carrierId = state.ball.ownerId;
    const possession = state.possession;
    for (const [id, d] of decisions) {
      const ms = Number.isFinite(d.computeMs) ? d.computeMs : 0;
      decisionMs.push(ms);
      cycle += ms;
      const player = byId.get(id);
      if (!player) continue;
      const a = acc[player.team];
      const action = d.chosen.action;
      if (id === carrierId && action.type !== 'move') {
        const sig = actionSignature(action);
        if (lastCarrier && lastCarrier.id === id && lastCarrier.sig !== sig) a.intentionChanges++;
        a.carrierCycles++;
        lastCarrier = { id, sig };
        if (action.type === 'pass') { a.passLength += dist(player.pos, action.targetPoint); a.passCount++; }
      } else if (action.type === 'move') {
        if (player.team === possession && id !== carrierId) {
          const prev = prevTargets.get(id);
          if (prev && dist(prev, action.target) > 2) a.targetChanges++;
          a.offBallPlayerCycles++;
        }
        prevTargets.set(id, { x: action.target.x, y: action.target.y });
        const pi = prevIntent.get(id) ?? null;
        if (action.intent === 'run' && pi !== 'run') a.deepRuns++;
        prevIntent.set(id, action.intent);
      }
    }
    if (carrierId === null || !decisions.has(carrierId)) lastCarrier = null;
    cycleMs.push(cycle);
    scanEvents(state);
    scanFlight(state);
    if (state.time - lastStructureTime >= structureEvery) { lastStructureTime = state.time; sampleStructure(state); }
    options.onDecisions?.(decisions, state);
  };

  const finish = (state: MatchState, config: MatchConfig, wallMs: number): MatchResult => {
    scanEvents(state);
    const period = cycleTime > 0 ? cycleTime : config.params.decisionPeriod;
    const lat = latencyPercentiles(decisionMs);
    const cyc = latencyPercentiles(cycleMs);
    const stability = {} as Record<TeamId, StabilityKpi>;
    const structure = {} as Record<TeamId, StructuralKpi>;
    for (const team of TEAMS) {
      const a = acc[team];
      const carrierSeconds = a.carrierCycles * period;
      const offBallPlayerSeconds = a.offBallPlayerCycles * period;
      stability[team] = {
        intentionChangeRate: carrierSeconds > 0 ? a.intentionChanges / carrierSeconds : 0,
        targetChangeRate: offBallPlayerSeconds > 0 ? a.targetChanges / offBallPlayerSeconds : 0,
        intentionChanges: a.intentionChanges, carrierSeconds, targetChanges: a.targetChanges, offBallPlayerSeconds,
      };
      const n = a.structSamples || 1;
      structure[team] = {
        samples: a.structSamples,
        spanX: a.spanX / n, spanY: a.spanY / n, hullArea: a.hullArea / n,
        defensiveLineHeight: a.lineSamples ? a.lineHeight / a.lineSamples : 0,
        meanPassLength: a.passCount ? a.passLength / a.passCount : 0, passCount: a.passCount,
        deepRuns: a.deepRuns,
      };
    }
    const stats: MatchStats = JSON.parse(JSON.stringify(state.stats));
    const result: MatchResult = {
      seed: config.seed,
      score: { A: state.score.A, B: state.score.B },
      stats,
      durationSec: config.durationSec,
      wallMs,
      events: eventCount,
      kpi: { A: teamKpis(stats, 'A', config.durationSec), B: teamKpis(stats, 'B', config.durationSec) },
      latency: { count: lat.count, mean: lat.mean, p50: lat.p50, p95: lat.p95, p99: lat.p99, max: lat.max, cycles: cyc.count, cycleMean: cyc.mean, cycleP50: cyc.p50, cycleP95: cyc.p95, cycleP99: cyc.p99 },
      stability,
      structure,
      policies: options.policyNames,
    };
    if (collectEvents) { result.eventLog = eventLog; result.flightLog = flightLog; }
    return result;
  };

  return { onDecisions, flush: scanEvents, finish, eventLog, flightLog };
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
/** Joue un match complet (durée `config.durationSec`) et renvoie le résultat enrichi. */
export function runMatch(config: MatchConfig, policies?: Record<TeamId, PolicySet>, options: RunMatchOptions = {}): MatchResult {
  const sim = createSimulation(config);
  const collector = createMatchCollector({
    ...options,
    policyNames: options.policyNames ?? (policies ? { A: policies.A.name, B: policies.B.name } : undefined),
  });
  const stepOptions: StepOptions = { policies, onDecisions: collector.onDecisions, ...(options.decide ? { decide: options.decide } : {}) };
  const t0 = performance.now();
  sim.advance(config.durationSec, stepOptions);
  const wallMs = performance.now() - t0;
  return collector.finish(sim.state, config, wallMs);
}

/** Politique dont les décisions utilisent un jeu de paramètres propre (candidat CEM vs adversaire gelé). */
export function withParams(policy: PolicySet, params: SimParams, name?: string): PolicySet {
  return {
    name: name ?? `${policy.name}+ϑ`,
    onBall: (input, playerId, previous) => policy.onBall({ ...input, params }, playerId, previous),
    offBall: (input, playerId, previous) => policy.offBall({ ...input, params }, playerId, previous),
    defence: (input, team, previous) => policy.defence({ ...input, params }, team, previous),
  };
}

/** Description sérialisable d'un match (worker_threads) : politiques par nom, surcharges de paramètres par équipe. */
export interface MatchTask {
  config: MatchConfig;
  policies?: Record<TeamId, string>;
  /** Surcharges ϑ (chemin → valeur) appliquées aux décisions de chaque équipe via `withParams`. */
  paramOverrides?: Partial<Record<TeamId, Record<string, number>>>;
  options?: Omit<RunMatchOptions, 'onDecisions'>;
}

/** Résout les politiques d'une tâche (noms → PolicySet, surcharges de paramètres). */
export function resolveTaskPolicies(task: MatchTask): Record<TeamId, PolicySet> | undefined {
  const names = task.policies ?? { A: FULL_POLICY_NAME, B: FULL_POLICY_NAME };
  const overrides = task.paramOverrides ?? {};
  if (!task.policies && !Object.keys(overrides).length) return undefined;
  const out = {} as Record<TeamId, PolicySet>;
  for (const team of TEAMS) {
    let p = resolvePolicy(names[team]);
    const ov = overrides[team];
    if (ov && Object.keys(ov).length) p = withParams(p, applyFlatParams(task.config.params, ov), `${names[team]}+ϑ`);
    out[team] = p;
  }
  return out;
}

export function runMatchTask(task: MatchTask): MatchResult {
  const policies = resolveTaskPolicies(task);
  const names = task.policies ?? { A: FULL_POLICY_NAME, B: FULL_POLICY_NAME };
  return runMatch(task.config, policies, { ...(task.options ?? {}), policyNames: names });
}

// ---------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------
/** Charge un état de scénario dans une simulation vivante (en place) et remet statistiques, score et événements à zéro. */
export function loadStateInto(sim: Simulation, state: MatchState): void {
  const live = sim.state;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const p of live.players) {
    const s = byId.get(p.id);
    if (!s) continue;
    p.pos = { ...s.pos }; p.vel = { ...s.vel };
    p.target = null; p.targetSpeed = 0; p.decision = null; p.lastDecisionTime = -1; p.lastKickTime = live.time - 10;
    p.role = s.role; p.slotIndex = s.slotIndex;
  }
  live.ball.pos = { ...state.ball.pos }; live.ball.vel = { ...state.ball.vel }; live.ball.z = 0; live.ball.vz = 0;
  live.ball.ownerId = state.ball.ownerId; live.ball.lastTouchId = state.ball.lastTouchId; live.ball.flight = null;
  live.possession = state.possession; live.possessionSince = live.time;
  live.phase = { ...state.phase }; live.phaseSince = { A: live.time, B: live.time };
  live.restart = null;
  live.tactics = JSON.parse(JSON.stringify(state.tactics));
  live.fields = null;
  live.stats = emptyStats();
  live.score = { A: 0, B: 0 };
  live.events.length = 0;
  sim.decisions.clear();
}

/** Adaptateur pour le panneau « scénarios » de l'interface : { id, name, description, apply(sim) }. */
export const toSimScenario = (s: Scenario): { id: string; name: string; description: string; apply: (sim: Simulation) => void } => ({
  id: s.id, name: s.name, description: s.description, apply: (sim) => loadStateInto(sim, s.build()),
});

export interface ScenarioKpis {
  xg: number;
  threat: number;
  possessionKept: boolean;
  /** Part du temps de possession de l'équipe du protagoniste pendant l'horizon. */
  possessionShare: number;
  goal: boolean;
  turnovers: number;
  /** Valeur du KPI désigné par le scénario (xg | threat | possession ∈ {0,1}). */
  value: number;
}

export interface ScenarioRunResult {
  scenarioId: string;
  seed: number;
  policy: string;
  /** Première décision « avec ballon » du protagoniste (null si aucune pendant l'horizon). */
  decision: Decision | null;
  actionClass: ActionClass | null;
  /** Résumé lisible de l'action (« passe → 8 »). */
  actionLabel: string;
  acceptable: boolean;
  /** candidates[0].score − chosen.score (0 si la décision est le meilleur candidat). */
  regret: number;
  decisionTime: number;
  computeMs: number;
  kpis: ScenarioKpis;
}

/** Résumé court d'une action (identifiants). */
export function shortActionLabel(action: Action | null): string {
  if (!action) return '—';
  switch (action.type) {
    case 'pass': return `${action.kind === 'through' ? 'profondeur' : action.kind === 'lob' ? 'lob' : 'passe'} → ${action.targetId}`;
    case 'dribble': return `dribble (${Math.round(action.distance)} m)`;
    case 'shoot': return `tir${action.xg !== undefined ? ` (xG ${action.xg.toFixed(2)})` : ''}`;
    case 'hold': return 'conservation';
    case 'clear': return 'dégagement';
    case 'move': return `déplacement (${action.intent})`;
  }
}

export interface RunScenarioOptions {
  params?: SimParams;
  /** Politique de l'équipe adverse (défaut : algorithme complet, sinon la même politique). */
  opponentPolicy?: PolicySet;
  /** Fonction de décision injectée (tests) — remplace `decideAll`. */
  decide?: DecideFn;
}

/**
 * Joue un scénario pendant `horizonSec` secondes avec `policy` pour l'équipe du protagoniste.
 * Déterministe pour une graine donnée.
 */
export function runScenario(scenario: Scenario, policy: PolicySet | undefined, seed: number, horizonSec = 6, options: RunScenarioOptions = {}): ScenarioRunResult {
  const state = scenario.build();
  const team = scenario.team, opp = otherTeam(team);
  const config = makeConfig({ seed, durationSec: horizonSec + 1, tacticA: state.tactics.A, tacticB: state.tactics.B, params: options.params });
  const sim = createSimulation(config);
  loadStateInto(sim, state);
  let policies: Record<TeamId, PolicySet> | undefined;
  if (policy) {
    let other = options.opponentPolicy;
    if (!other) { try { other = resolvePolicy(FULL_POLICY_NAME); } catch { other = policy; } }
    policies = { [team]: policy, [opp]: other } as Record<TeamId, PolicySet>;
  }
  const capture: { decision: Decision | null } = { decision: null };
  let possessionTicks = 0, totalTicks = 0;
  const onDecisions = (decisions: Map<number, Decision>, s: MatchState): void => {
    totalTicks++;
    if (s.possession === team) possessionTicks++;
    if (capture.decision) return;
    const d = decisions.get(scenario.protagonistId);
    if (d && d.chosen.action.type !== 'move' && s.ball.ownerId === scenario.protagonistId) capture.decision = d;
  };
  const t0 = performance.now();
  sim.advance(horizonSec, { policies, onDecisions, ...(options.decide ? { decide: options.decide } : {}) });
  const wall = performance.now() - t0;
  const live = sim.state;
  const protagonist = live.players.find((p) => p.id === scenario.protagonistId)!;
  const decision: Decision | null = capture.decision;
  const action = decision ? decision.chosen.action : null;
  const cls = action ? actionClassOf(action) : null;
  const acceptable = action ? isAcceptable(scenario.acceptable, action, { pos: state.players.find((p) => p.id === scenario.protagonistId)!.pos, team: protagonist.team }) : false;
  const best = decision && decision.candidates.length ? decision.candidates[0].score : decision?.chosen.score ?? 0;
  const regret = decision ? Math.max(0, best - decision.chosen.score) : 0;
  const ownerTeam = live.ball.ownerId !== null ? live.players.find((p) => p.id === live.ball.ownerId)?.team ?? null : live.possession;
  const possessionKept = ownerTeam === team || (live.ball.ownerId === null && live.possession === team);
  const ts = live.stats[team];
  const kpis: ScenarioKpis = {
    xg: ts.xG,
    threat: ts.threatCreated,
    possessionKept,
    possessionShare: totalTicks ? possessionTicks / totalTicks : 0,
    goal: live.score[team] > 0,
    turnovers: ts.turnovers,
    value: 0,
  };
  kpis.value = scenario.kpi === 'xg' ? kpis.xg : scenario.kpi === 'threat' ? kpis.threat : possessionKept ? 1 : 0;
  return {
    scenarioId: scenario.id,
    seed,
    policy: policy?.name ?? FULL_POLICY_NAME,
    decision,
    actionClass: cls,
    actionLabel: shortActionLabel(action),
    acceptable,
    regret,
    decisionTime: decision?.time ?? -1,
    computeMs: decision?.computeMs ?? wall,
    kpis,
  };
}

export interface ScenarioBatchSummary {
  policy: string;
  runs: number;
  /** Accord top-1 : proportion de premières décisions acceptables. */
  top1Agreement: number;
  meanRegret: number;
  meanKpi: Record<'xg' | 'threat' | 'possession', number>;
  perScenario: { id: string; name: string; acceptableRate: number; meanRegret: number; meanKpi: number; kpi: string; actions: Record<string, number>; reserved: boolean }[];
}

/** Joue chaque scénario sur toutes les graines et agrège. */
export function runScenarioBatch(scenarios: readonly Scenario[], policy: PolicySet | undefined, seeds: readonly number[], horizonSec = 6, options: RunScenarioOptions = {}): { results: ScenarioRunResult[]; summary: ScenarioBatchSummary } {
  const results: ScenarioRunResult[] = [];
  for (const sc of scenarios) for (const seed of seeds) results.push(runScenario(sc, policy, seed, horizonSec, options));
  return { results, summary: summarizeScenarioRuns(scenarios, results, policy?.name ?? FULL_POLICY_NAME) };
}

export function summarizeScenarioRuns(scenarios: readonly Scenario[], results: readonly ScenarioRunResult[], policy: string): ScenarioBatchSummary {
  const perScenario = scenarios.map((sc) => {
    const rs = results.filter((r) => r.scenarioId === sc.id);
    const actions: Record<string, number> = {};
    for (const r of rs) actions[r.actionLabel] = (actions[r.actionLabel] ?? 0) + 1;
    const n = rs.length || 1;
    return {
      id: sc.id, name: sc.name, kpi: sc.kpi, reserved: !!sc.reserved,
      acceptableRate: rs.filter((r) => r.acceptable).length / n,
      meanRegret: rs.reduce((s, r) => s + r.regret, 0) / n,
      meanKpi: rs.reduce((s, r) => s + r.kpis.value, 0) / n,
      actions,
    };
  });
  const n = results.length || 1;
  const meanOf = (k: 'xg' | 'threat' | 'possession'): number => {
    const rs = results.filter((r) => scenarios.find((s) => s.id === r.scenarioId)?.kpi === k);
    return rs.length ? rs.reduce((s, r) => s + r.kpis.value, 0) / rs.length : 0;
  };
  return {
    policy,
    runs: results.length,
    top1Agreement: results.filter((r) => r.acceptable).length / n,
    meanRegret: results.reduce((s, r) => s + r.regret, 0) / n,
    meanKpi: { xg: meanOf('xg'), threat: meanOf('threat'), possession: meanOf('possession') },
    perScenario,
  };
}
