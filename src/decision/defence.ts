/**
 * Décision défensive coordonnée (docs/CONCEPTION.md §8) pour l'équipe sans ballon :
 *  1. génération des tâches : pressing (1 ou 2 presseurs selon pressIntensity, déclencheur §8.2) ou « contain »
 *     (2 m côté but du porteur), marquage des n_mark attaquants les plus dangereux (danger = xT(p_k + v_k)·P_pass(b→p_k)),
 *     couverture des cellules de plus grand danger adverse (≤ maxZoneTasks), interception d'une passe en cours,
 *     course au ballon libre, repli au poste (complément à 10) ;
 *  2. matrice de coûts (secondes) : C_jt = T_j(q_t) − μ_prio·π_t + ν_shape·‖q_t − s_j‖/L + ξ·1[t ≠ tâche précédente] + pénalités de rôle ;
 *  3. affectation optimale par l'algorithme hongrois (ou gloutonne pour la baseline « homme le plus proche »),
 *     hystérésis globale (nouvelle affectation adoptée seulement si le coût total baisse de ΔC_min) ;
 *  4. conversion en actions `move` (press / mark / cover / zone / recover / intercept / chase), candidats = 3 meilleures
 *     tâches du défenseur, explication en français ; gardien via decideKeeper.
 * Vitesses de consigne (réalisme) : press / intercept / chase au sprint, contain 0,7 v_max, marquage 0,45 + 0,3·priorité,
 * zone 0,3, repli 0,25 + 0,3·recoverPriority (`defence.taskSpeed`), zone et repli accélérant vers le sprint entre 6 et
 * 20 m de leur point ; une zone ou un repli à moins de `standDistance` m est tenu sur place. « Contain » se fait à containOffset + containSlack·(1 − pressIntensity) m (un bloc bas contient de
 * plus loin, un pressing haut colle au porteur).
 * Tenue de la ligne (§8.4) : les points de marquage et de zone ne descendent pas à plus de `lineHoldSlack` m derrière la
 * ligne du bloc (poste le plus bas des joueurs de champ, §9.2 : x_line suit `defensiveLine` et le ballon) — un attaquant
 * plus profond que la ligne est laissé au hors-jeu, la hauteur du bloc suit ainsi la tactique.
 * Contre-pressing : en `transition_defence` pendant counterPressWindow s, les 3 défenseurs les plus proches du ballon
 * reçoivent des tâches press/cover à priorité renforcée (règle des 5 secondes).
 * Repère : coordonnées terrain, direction d'attaque `dir` explicite (symétrie miroir A/B).
 */
import type { Vec2 } from '../core/vec2';
import { dist, dist2, normalize, sub } from '../core/vec2';
import { PITCH, ownGoalCentre } from '../core/pitch';
import { hungarian } from '../core/hungarian';
import type { Candidate, Decision, MatchState, MoveIntent, Player, ScoreComponent, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { pressureAt, threatFor } from '../models/fields';
import { analyseInterception } from '../models/interception';
import { timeToArrive } from '../models/motion';
import { getPlayer } from '../models/probability';
import { quickPassProbability } from './offball';
import { localSuperiority } from '../models/structure';
import { FORMATIONS } from '../tactics/formations';
import { fmtFr, fmtPoint } from './explain';
import { decideKeeper } from './keeper';
import { ballStopPoint, component, decisionContext, makeDecision, moveCandidate, TARGET_MARGIN, teamSlot } from './loose';
import type { DecisionInput } from './policy';

// ---------------------------------------------------------------------------
// Constantes (§8, §13.3)
// ---------------------------------------------------------------------------
/** Coût « infini » (tâche inaccessible) — fini pour rester compatible avec l'algorithme hongrois. */
export const INFEASIBLE_COST = 1e3;
/** Seuil de pressIntensity au-delà duquel 2 presseurs sont engagés (§13.3). */
const TWO_PRESSERS_INTENSITY = 0.7;
/** τ_trig = TAU_TRIG_BASE + TAU_TRIG_GAIN·pressIntensity (§13.3). */
const TAU_TRIG_BASE = 0.8;
const TAU_TRIG_GAIN = 1.2;
/** μ_prio ← μ_prio·(MU_BASE + pressIntensity) (§13.3). */
const MU_BASE = 0.5;
/** Seuil de probabilité de passe maximale sous lequel le porteur est « sans solution » (§8.2). */
const NO_OPTION_PASS = 0.6;
/** Pression sur le porteur à partir de laquelle il est « sous pression » (déclencheur). */
const CARRIER_PRESSURE = 1.0;
/** Itérations du point fixe du point de poursuite, horizon maximal (s). */
const PURSUIT_ITERATIONS = 3;
const PURSUIT_MAX_TIME = 2;
/** Décalage (m) du second presseur vers son propre but (ferme la ligne derrière le premier). */
const SECOND_PRESSER_OFFSET = 2;
/** Priorité de la tâche « contenir » (§8.1). */
const CONTAIN_PRIORITY = 0.5;
/** Anticipation (s) de la position d'un attaquant pour le danger et le point de marquage (§8.1). */
const DANGER_HORIZON = 1.0;
const MARK_HORIZON = 0.5;
/** Décalage supplémentaire côté but en marquage zonal : δ·(1 + ZONAL_GAIN·(1 − markingTightness)). */
const ZONAL_GAIN = 2;
/** Marquage zonal (markingTightness ≤ 0,5) : décalage de 1 m vers le ballon (§8.1). */
const ZONAL_BALL_SHIFT = 1;
const MAN_MARKING_THRESHOLD = 0.5;
/** n_mark = MARK_BASE + ⌊MARK_GAIN·markingTightness⌋ (§13.3), borné par maxMarkTasks. */
const MARK_BASE = 2;
const MARK_GAIN = 4;
/** Zones : cellules à plus de ZONE_CLEAR m d'un attaquant marqué et du ballon, séparées de ZONE_SPACING m, dans la moitié défensive + ZONE_MAX_X m. */
const ZONE_CLEAR = 6;
const ZONE_SPACING = 8;
const ZONE_MAX_X = 10;
const ZONE_PRIORITY = 0.7;
/** Taille du vivier de cellules candidates aux zones (× maxZoneTasks) avant application de l'espacement. */
const ZONE_POOL_FACTOR = 4;
/** Tolérance (s) pour qu'un défenseur puisse encore intercepter au point d'échantillonnage. */
const INTERCEPT_SLACK = 0.2;
const MAX_INTERCEPT_TASKS = 2;
/** Zone « haute » pour un défenseur central (pénalité de rôle) : x' > 0 ; marquage « profond » pour un attaquant : x' < −L/6. */
const DEEP_MARK_X = -PITCH.length / 6;
/** Pénalités de rôle en unités de muRole : DF pressant haut (×4/3 = 2 s par défaut), FW marquant bas (×2/3 = 1 s). */
const DF_PRESS_ROLE = 4 / 3;
const FW_MARK_ROLE = 2 / 3;
/** Contre-pressing : nombre de défenseurs les plus proches du ballon concernés, bonus de priorité. */
const COUNTER_PRESS_PLAYERS = 3;
const COUNTER_PRESS_BOOST = 0.5;
const COUNTER_PRESS_RADIUS = 15;
/** Vitesses de consigne (fractions de v_max) par défaut (`defence.taskSpeed`), distance de maintien sur place (m), marge de contain (m). */
const DEFAULT_TASK_SPEED: NonNullable<SimParams['defence']['taskSpeed']> = { contain: 0.7, zone: 0.3, markBase: 0.45, markGain: 0.3, recoverBase: 0.25, recoverGain: 0.3 };
const DEFAULT_STAND_DISTANCE = 3;
const DEFAULT_CONTAIN_SLACK = 6;
/** Tenue de la ligne : marge (m) derrière la ligne du bloc tolérée pour les points de marquage et de zone (défaut). */
const DEFAULT_LINE_HOLD_SLACK = 1;
/** Nombre de candidats (tâches) conservés par défenseur. */
const KEPT_CANDIDATES = 3;
/** Repli / zone : au-delà de RAMP_START m la vitesse croît linéairement jusqu'au sprint à RAMP_FULL m. */
const RAMP_START = 6;
const RAMP_FULL = 20;
/** Granularité (m) des clés de zone (hystérésis). */
const ZONE_KEY_CELL = 4;

export type TaskKind = 'press' | 'contain' | 'mark' | 'zone' | 'intercept' | 'chase' | 'recover';

export interface DefenceTask {
  kind: TaskKind;
  point: Vec2;
  /** Priorité π_t ∈ [0, 1]. */
  priority: number;
  markId?: number;
  /** Tâche « recover » : défenseur propriétaire du poste. */
  ownerId?: number;
  /** Tâche « intercept » : instant où le ballon passe au point. */
  ballTime?: number;
  /** Clé stable (hystérésis : « même tâche » d'un cycle à l'autre). */
  key: string;
  /** Libellé français. */
  label: string;
}

export interface PressingInfo {
  pressing: boolean;
  counterPress: boolean;
  nPress: number;
  triggerCount: number;
  triggersActive: string[];
  required: number;
  tauP: number;
  tauTrig: number;
  carrierId: number | null;
}

export interface DefenceOptions {
  /** Affectation gloutonne (baseline « homme le plus proche ») au lieu de l'algorithme hongrois. */
  greedy?: boolean;
}

const INTENT_OF: Record<TaskKind, MoveIntent> = {
  press: 'press', contain: 'cover', mark: 'mark', zone: 'zone', intercept: 'intercept', chase: 'chase', recover: 'recover',
};

const zoneKey = (q: Vec2): string => `zone:${Math.round(q.x / ZONE_KEY_CELL)},${Math.round(q.y / ZONE_KEY_CELL)}`;

/** Clé de la tâche précédente d'un défenseur (à partir de sa dernière décision). */
export function previousTaskKey(previous: Decision | undefined, playerId: number): string | null {
  if (!previous || previous.chosen.action.type !== 'move') return null;
  const a = previous.chosen.action;
  switch (a.intent) {
    case 'press': return 'press';
    case 'cover': return 'contain';
    case 'mark': return a.markId !== undefined ? `mark:${a.markId}` : null;
    // Zone : clé du point de la tâche (`successPoint`), la cible d'action pouvant être la position tenue sur place.
    case 'zone': return zoneKey(previous.chosen.successPoint ?? a.target);
    case 'recover': return `recover:${playerId}`;
    case 'intercept': return 'intercept';
    case 'chase': return 'chase';
    default: return null;
  }
}

/** Point de poursuite du porteur : q = p_h + v_h·T résolu par point fixe T = min_j T_j(q) (3 itérations, §8.1). */
export function pursuitPoint(carrierPos: Vec2, carrierVel: Vec2, defenders: readonly Player[], input: DecisionInput): Vec2 {
  const m = input.params.models;
  let q = { x: carrierPos.x, y: carrierPos.y };
  for (let it = 0; it < PURSUIT_ITERATIONS; it++) {
    let T = Infinity;
    for (const d of defenders) {
      const t = timeToArrive(d.pos, d.vel, q, d.maxSpeed, d.maxAccel, m);
      if (t < T) T = t;
    }
    if (!Number.isFinite(T)) break;
    const h = Math.min(T, PURSUIT_MAX_TIME);
    q = { x: carrierPos.x + carrierVel.x * h, y: carrierPos.y + carrierVel.y * h };
  }
  return q;
}

/** Déclencheur de pressing (§8.2, adapté §13.3) et nombre de presseurs. */
export function pressingTrigger(input: DecisionInput, team: TeamId, defenders: readonly Player[], maxPass: number | null): PressingInfo {
  const { state, params, tactic } = input;
  const tp = tactic.params;
  const dir = attackDir(team);
  const opp = otherTeam(team);
  const ball = state.ball;
  const carrierId = ball.ownerId !== null && getPlayer(state, ball.ownerId).team === opp ? ball.ownerId : null;
  let tauP = Infinity;
  for (const d of defenders) {
    const t = timeToArrive(d.pos, d.vel, ball.pos, d.maxSpeed, d.maxAccel, params.models);
    if (t < tauP) tauP = t;
  }
  const tauTrig = TAU_TRIG_BASE + TAU_TRIG_GAIN * tp.pressIntensity;
  const active: string[] = [];
  if (tauP < tauTrig) active.push('porteur à portée');
  if (maxPass !== null && maxPass < NO_OPTION_PASS) active.push('porteur sans solution de passe');
  if (dir * ball.pos.x <= tp.pressLine) active.push('ballon dans la zone de pressing');
  if (localSuperiority(state, ball.pos, team, params) >= 0) active.push('supériorité locale');
  if (carrierId !== null && pressureAt(state, ball.pos, opp, params) >= CARRIER_PRESSURE) active.push('porteur sous pression');
  const counterPress = state.phase[team] === 'transition_defence' && state.time - state.phaseSince[team] < tp.counterPressWindow;
  const required = Math.max(1, Math.round(tp.pressTriggerCount));
  const pressing = counterPress || active.length >= required;
  let nPress = pressing ? 1 + (tp.pressIntensity > TWO_PRESSERS_INTENSITY ? 1 : 0) : 0;
  if (counterPress) nPress = Math.max(nPress, 2);
  return { pressing, counterPress, nPress, triggerCount: active.length, triggersActive: active, required, tauP, tauTrig, carrierId };
}

/**
 * Génère les tâches défensives du cycle (§8.1). Retourne aussi l'information de pressing et le passeur adverse
 * (porteur ou adversaire le plus proche du ballon) utilisé pour les probabilités de passe.
 */
export function generateTasks(input: DecisionInput, team: TeamId, defenders: readonly Player[]): { tasks: DefenceTask[]; info: PressingInfo; nearestToBall: number[] } {
  const { state, fields, params, tactic } = input;
  const tp = tactic.params;
  const dw = params.defence;
  const dir = attackDir(team);
  const opp = otherTeam(team);
  const ball = state.ball;
  const ownGoal = ownGoalCentre(dir);
  const tasks: DefenceTask[] = [];

  // Postes instanciés des défenseurs (une fois) et ligne du bloc (repère équipe) : plancher des points de marquage et de zone.
  const slots = new Map<number, Vec2>();
  let lineX = Infinity;
  for (const d of defenders) {
    const s = teamSlot(state, d);
    slots.set(d.id, s);
    if (dir * s.x < lineX) lineX = dir * s.x;
  }
  const holdFloor = lineX - (dw.lineHoldSlack ?? DEFAULT_LINE_HOLD_SLACK);
  const holdLine = (point: Vec2): Vec2 => (dir * point.x < holdFloor ? { x: dir * holdFloor, y: point.y } : point);

  // Passeur adverse : porteur, sinon adversaire de champ le plus proche du ballon.
  let passer: Player | null = ball.ownerId !== null ? getPlayer(state, ball.ownerId) : null;
  if (passer && passer.team !== opp) passer = null;
  if (!passer) {
    let bestD = Infinity;
    for (const p of state.players) {
      if (p.team !== opp) continue;
      const d = dist2(p.pos, ball.pos);
      if (d < bestD) { bestD = d; passer = p; }
    }
  }

  // --- Marquage : danger = xT(p_k + v_k·1 s) · P_pass(b → p_k) ---
  const opponents = state.players.filter((p) => p.team === opp && p.role !== 'GK' && p.id !== ball.ownerId);
  const dangers = opponents.map((p) => {
    const ahead = { x: p.pos.x + p.vel.x * DANGER_HORIZON, y: p.pos.y + p.vel.y * DANGER_HORIZON };
    const pPass = passer && passer.id !== p.id ? quickPassProbability(state, fields, passer.id === ball.ownerId ? ball.pos : passer.pos, p.pos, opp, params).p : 0;
    return { p, pPass, danger: threatFor(fields, ahead, opp) * pPass };
  });
  dangers.sort((a, b) => b.danger - a.danger || a.p.id - b.p.id);
  const maxPass = dangers.length ? Math.max(...dangers.map((d) => d.pPass)) : null;
  const dangerMax = dangers.length ? Math.max(1e-9, dangers[0].danger) : 1;
  const nMark = Math.min(dw.maxMarkTasks, MARK_BASE + Math.floor(MARK_GAIN * tp.markingTightness));
  const man = tp.markingTightness > MAN_MARKING_THRESHOLD;
  const delta = dw.markGoalSideOffset * (1 + ZONAL_GAIN * (1 - tp.markingTightness));
  const marked: Vec2[] = [];
  for (const d of dangers.slice(0, nMark)) {
    if (d.danger <= 0) break;
    const p = d.p;
    const ahead = { x: p.pos.x + p.vel.x * MARK_HORIZON, y: p.pos.y + p.vel.y * MARK_HORIZON };
    const u = normalize(sub(ownGoal, ahead));
    let point = { x: ahead.x + delta * u.x, y: ahead.y + delta * u.y };
    if (!man) {
      const toBall = normalize(sub(ball.pos, ahead));
      point = { x: point.x + ZONAL_BALL_SHIFT * toBall.x, y: point.y + ZONAL_BALL_SHIFT * toBall.y };
    }
    // Tenue de la ligne : un attaquant plus profond que le bloc est marqué sur la ligne (il est hors-jeu derrière elle).
    point = holdLine(point);
    marked.push(p.pos);
    tasks.push({ kind: 'mark', point, priority: d.danger / dangerMax, markId: p.id, key: `mark:${p.id}`, label: `marquer ${p.name}` });
  }

  // --- Pressing / contain / interception / course au ballon ---
  const info = pressingTrigger(input, team, defenders, maxPass);
  const carrier = info.carrierId !== null ? getPlayer(state, info.carrierId) : null;
  if (carrier) {
    if (info.pressing) {
      const q = pursuitPoint(ball.pos, carrier.vel, defenders, input);
      tasks.push({ kind: 'press', point: q, priority: 1, key: 'press', label: `presser le porteur ${carrier.name}` });
      if (info.nPress >= 2) {
        const u = normalize(sub(ownGoal, q));
        tasks.push({ kind: 'press', point: { x: q.x + SECOND_PRESSER_OFFSET * u.x, y: q.y + SECOND_PRESSER_OFFSET * u.y }, priority: 1, key: 'press', label: `presser le porteur ${carrier.name} (second presseur)` });
      }
      if (info.counterPress) {
        const u = normalize(sub(ownGoal, ball.pos));
        tasks.push({ kind: 'contain', point: { x: ball.pos.x + 2 * dw.containOffset * u.x, y: ball.pos.y + 2 * dw.containOffset * u.y }, priority: 1, key: 'contain', label: `couvrir derrière les presseurs (contre-pressing)` });
      }
    } else {
      const u = normalize(sub(ownGoal, ball.pos));
      const off = containDistance(dw, tp.pressIntensity);
      tasks.push({ kind: 'contain', point: { x: ball.pos.x + off * u.x, y: ball.pos.y + off * u.y }, priority: CONTAIN_PRIORITY, key: 'contain', label: `contenir le porteur ${carrier.name}` });
    }
  } else if (ball.ownerId === null) {
    const flight = ball.flight;
    if (flight && (flight.kind === 'pass' || flight.kind === 'through' || flight.kind === 'lob') && getPlayer(state, flight.kickerId).team === opp) {
      // Trajectoire en cours : analyse depuis l'origine de la frappe avec la vitesse réellement imprimée et le temps écoulé
      // (les temps balle sont mesurés depuis maintenant, les points déjà dépassés ne sont plus interceptables).
      const inter = analyseInterception(state, flight.origin, flight.targetPoint, flight.kind, opp, params, undefined,
        { elapsed: state.time - flight.startTime, initialSpeed: flight.initialSpeed });
      let n = 0;
      for (const s of inter.samples) {
        if (s.opponentTime <= s.ballTime + INTERCEPT_SLACK && s.ballTime > 0) {
          tasks.push({ kind: 'intercept', point: s.point, priority: 1, ballTime: s.ballTime, key: 'intercept', label: `intercepter la passe en ${fmtPoint(s.point)}` });
          if (++n >= MAX_INTERCEPT_TASKS) break;
        }
      }
    }
    const stop = ballStopPoint(ball, params.physics);
    tasks.push({ kind: 'chase', point: stop.point, priority: 1, key: 'chase', label: `aller au ballon libre (arrêt prévu en ${fmtPoint(stop.point)})` });
  }

  // --- Zones : cellules de plus grand danger adverse, hors voisinage des attaquants marqués et du ballon ---
  // Sélection bornée (liste des ZONE_POOL meilleures cellules maintenue par insertion : pas de tri global de la grille).
  if (dw.maxZoneTasks > 0) {
    const field = opp === 'A' ? fields.dangerA : fields.dangerB;
    const src = field ?? fields.controlA;
    const pool = Math.max(dw.maxZoneTasks, ZONE_POOL_FACTOR * dw.maxZoneTasks);
    const bestX = new Float64Array(pool), bestY = new Float64Array(pool), bestD = new Float64Array(pool);
    let nBest = 0;
    const clear2 = ZONE_CLEAR * ZONE_CLEAR;
    const cs = src.cellSize;
    const iLo = dir > 0 ? 0 : Math.max(0, Math.ceil((-ZONE_MAX_X + PITCH.halfLength) / cs));
    const iHi = dir > 0 ? Math.min(src.cols - 1, Math.floor((ZONE_MAX_X + PITCH.halfLength) / cs)) : src.cols - 1;
    for (let j = 0; j < src.rows; j++) {
      const y = src.yOf(j);
      if (Math.abs(y) > PITCH.halfWidth - TARGET_MARGIN) continue;
      for (let i = iLo; i <= iHi; i++) {
        const idx = j * src.cols + i;
        const d = field ? field.data[idx] : src.data[idx];
        if (d <= 0 || (nBest === pool && d <= bestD[nBest - 1])) continue;
        // Tenue de la ligne : une cellule plus profonde que le bloc est couverte depuis la ligne (même y).
        const x = dir * src.xOf(i) < holdFloor ? dir * holdFloor : src.xOf(i);
        if (Math.abs(x) > PITCH.halfLength - TARGET_MARGIN) continue;
        const bdx = x - ball.pos.x, bdy = y - ball.pos.y;
        if (bdx * bdx + bdy * bdy < clear2) continue;
        let near = false;
        for (const mpos of marked) { const mx = x - mpos.x, my = y - mpos.y; if (mx * mx + my * my < clear2) { near = true; break; } }
        if (near) continue;
        let k = nBest < pool ? nBest : pool - 1;
        while (k > 0 && bestD[k - 1] < d) { bestX[k] = bestX[k - 1]; bestY[k] = bestY[k - 1]; bestD[k] = bestD[k - 1]; k--; }
        bestX[k] = x; bestY[k] = y; bestD[k] = d;
        if (nBest < pool) nBest++;
      }
    }
    const dMax = nBest ? bestD[0] : 1;
    const chosen: { x: number; y: number }[] = [];
    for (let k = 0; k < nBest && chosen.length < dw.maxZoneTasks; k++) {
      const c = { x: bestX[k], y: bestY[k] };
      let ok = true;
      for (const z of chosen) if (dist2(z, c) < ZONE_SPACING * ZONE_SPACING) { ok = false; break; }
      if (!ok) continue;
      chosen.push(c);
      tasks.push({ kind: 'zone', point: c, priority: ZONE_PRIORITY * (bestD[k] / dMax), key: zoneKey(c), label: `couvrir la zone ${fmtPoint(c)}` });
    }
  }

  // --- Repli : un poste par défenseur ---
  for (const d of defenders) {
    tasks.push({ kind: 'recover', point: slots.get(d.id)!, priority: 0, ownerId: d.id, key: `recover:${d.id}`, label: 'se replier à son poste' });
  }

  // Défenseurs les plus proches du ballon (contre-pressing).
  const nearestToBall = [...defenders]
    .map((d) => ({ id: d.id, t: timeToArrive(d.pos, d.vel, ball.pos, d.maxSpeed, d.maxAccel, params.models) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, COUNTER_PRESS_PLAYERS)
    .map((d) => d.id);
  return { tasks, info, nearestToBall };
}

/** Décomposition d'un coût (secondes) ; les composantes nommées ne sont construites que pour les candidats conservés. */
interface CostBreakdown { cost: number; arrival: number; priority: number; shape: number; nu: number; changed: number; role: number; counter: number; infeasible: number; muPrio: number }

/** Coût C_jt (§8.3) d'un défenseur pour une tâche, avec sa décomposition (score du candidat = −coût). */
/** Données par défenseur, calculées une fois par cycle (poste, poids de structure, clé de la tâche précédente, contre-pressing). */
export interface DefenderInfo { slot: Vec2; nu: number; prevKey: string | null; counterEligible: boolean }

/** Prépare `DefenderInfo` : ν_shape ×2 pour un milieu défensif (§9.1) et ×2 pour un joueur devant le ballon en repli (§8.5). */
export function defenderInfo(input: DecisionInput, team: TeamId, defender: Player, previous: Map<number, Decision>, info: PressingInfo, nearestToBall: readonly number[]): DefenderInfo {
  const { state, params, tactic } = input;
  const dir = attackDir(team);
  const formationSlot = FORMATIONS[tactic.formation].slots[defender.slotIndex];
  const isDM = !!formationSlot && /DM$/.test(formationSlot.label);
  const retreat = state.phase[team] === 'transition_defence' && dir * defender.pos.x > dir * state.ball.pos.x;
  return {
    slot: teamSlot(state, defender),
    nu: params.defence.nuShape * (isDM ? 2 : 1) * (retreat ? 2 : 1),
    prevKey: previousTaskKey(previous.get(defender.id), defender.id),
    counterEligible: info.counterPress && nearestToBall.includes(defender.id),
  };
}

export function taskCost(input: DecisionInput, team: TeamId, defender: Player, di: DefenderInfo, task: DefenceTask): CostBreakdown {
  const { state, params, tactic } = input;
  const dw = params.defence;
  const dir = attackDir(team);
  const T = timeToArrive(defender.pos, defender.vel, task.point, defender.maxSpeed, defender.maxAccel, params.models);
  const infeasible = (task.kind === 'recover' && task.ownerId !== defender.id)
    || (task.kind !== 'recover' && T > dw.maxTaskTime)
    || (task.kind === 'intercept' && task.ballTime !== undefined && T > task.ballTime + INTERCEPT_SLACK) ? 1 : 0;
  const muPrio = dw.muPriority * (MU_BASE + tactic.params.pressIntensity);
  const shape = dist(task.point, di.slot) / PITCH.length;
  const changed = di.prevKey !== task.key ? 1 : 0;
  let role = 0;
  if (defender.role === 'DF' && (task.kind === 'press' || task.kind === 'contain') && dir * task.point.x > 0) role = DF_PRESS_ROLE;
  if (defender.role === 'FW' && task.kind === 'mark' && dir * task.point.x < DEEP_MARK_X) role = FW_MARK_ROLE;
  const counter = di.counterEligible
    && (task.kind === 'press' || task.kind === 'contain' || (task.kind === 'zone' && dist(task.point, state.ball.pos) < COUNTER_PRESS_RADIUS)) ? 1 : 0;
  const cost = T - muPrio * task.priority + di.nu * shape + dw.xiHysteresis * changed + dw.muRole * role - muPrio * COUNTER_PRESS_BOOST * counter + INFEASIBLE_COST * infeasible;
  return { cost, arrival: T, priority: task.priority, shape, nu: di.nu, changed, role, counter, infeasible, muPrio };
}

/** Composantes nommées d'un coût (Σ contributions = −coût). */
export function costComponents(b: CostBreakdown, dw: SimParams['defence']): ScoreComponent[] {
  const components: ScoreComponent[] = [
    component('arrival', 'Temps d’arrivée', b.arrival, -1, 's'),
    component('priority', 'Priorité de la tâche', b.priority, b.muPrio, 's'),
    component('shape', 'Écart au poste (structure)', b.shape, -b.nu),
    component('hysteresis', 'Changement de tâche', b.changed, -dw.xiHysteresis),
    component('role', 'Tâche hors du rôle naturel', b.role, -dw.muRole),
    component('counterPress', 'Contre-pressing (règle des 5 s)', b.counter, b.muPrio * COUNTER_PRESS_BOOST),
  ];
  if (b.infeasible) components.push(component('infeasible', 'Tâche inaccessible', 1, -INFEASIBLE_COST));
  return components;
}

/** Affectation gloutonne (baseline B6) : chaque tâche, par priorité décroissante, au défenseur libre le moins coûteux. */
function greedyAssignment(cost: number[][], tasks: readonly DefenceTask[]): number[] {
  const n = cost.length;
  const assignment = new Array<number>(n).fill(-1);
  const order = tasks.map((t, i) => ({ t, i })).filter((x) => x.t.kind !== 'recover').sort((a, b) => b.t.priority - a.t.priority || a.i - b.i);
  const usedTask = new Set<number>();
  for (const { i } of order) {
    let best = -1, bestC = INFEASIBLE_COST;
    for (let j = 0; j < n; j++) if (assignment[j] < 0 && cost[j][i] < bestC) { bestC = cost[j][i]; best = j; }
    if (best >= 0) { assignment[best] = i; usedTask.add(i); }
  }
  for (let j = 0; j < n; j++) {
    if (assignment[j] >= 0) continue;
    let best = -1, bestC = Infinity;
    for (let i = 0; i < tasks.length; i++) if (!usedTask.has(i) && cost[j][i] < bestC) { bestC = cost[j][i]; best = i; }
    assignment[j] = best;
    usedTask.add(best);
  }
  return assignment;
}

/** Affectation précédente exprimée dans les tâches courantes (null si un défenseur n'a plus de tâche correspondante). */
function previousAssignment(prevKeys: readonly (string | null)[], tasks: readonly DefenceTask[]): number[] | null {
  const used = new Set<number>();
  const out: number[] = [];
  for (const key of prevKeys) {
    if (key === null) return null;
    let found = -1;
    for (let i = 0; i < tasks.length; i++) if (!used.has(i) && tasks[i].key === key) { found = i; break; }
    if (found < 0) return null;
    used.add(found);
    out.push(found);
  }
  return out;
}

export function decideDefence(input: DecisionInput, team: TeamId, previous: Map<number, Decision>, options: DefenceOptions = {}): Map<number, Decision> {
  const t0 = performance.now();
  const { state, params, tactic } = input;
  const dw = params.defence;
  const tp = tactic.params;
  const out = new Map<number, Decision>();
  const defenders = state.players.filter((p) => p.team === team && p.role !== 'GK');
  const keeper = state.players.find((p) => p.team === team && p.role === 'GK');

  if (defenders.length > 0) {
    const { tasks, info, nearestToBall } = generateTasks(input, team, defenders);
    const superiority = localSuperiority(state, state.ball.pos, team, params);
    const infos = defenders.map((d) => defenderInfo(input, team, d, previous, info, nearestToBall));
    const prevKeys = infos.map((di) => di.prevKey);
    const breakdown: CostBreakdown[][] = defenders.map((d, j) => tasks.map((t) => taskCost(input, team, d, infos[j], t)));
    const cost = breakdown.map((row) => row.map((b) => b.cost));

    let assignment = options.greedy ? greedyAssignment(cost, tasks) : hungarian(cost).assignment;
    let keptGlobal = false;
    if (!options.greedy) {
      const prev = previousAssignment(prevKeys, tasks);
      if (prev) {
        let prevCost = 0, newCost = 0;
        for (let j = 0; j < defenders.length; j++) { prevCost += cost[j][prev[j]]; newCost += cost[j][assignment[j]]; }
        if (prevCost < INFEASIBLE_COST && newCost > prevCost - dw.minReassignGain) { assignment = prev; keptGlobal = true; }
      }
    }

    const tSetup = performance.now();
    const standDistance = dw.standDistance ?? DEFAULT_STAND_DISTANCE;
    for (let j = 0; j < defenders.length; j++) {
      const tj = performance.now();
      const d = defenders[j];
      const ti = assignment[j] >= 0 ? assignment[j] : tasks.findIndex((t) => t.kind === 'recover' && t.ownerId === d.id);
      const task = tasks[ti];
      // Candidats : 3 tâches les moins coûteuses + la tâche affectée (avec composante de coordination si elle n'est pas la moins chère).
      const order = breakdown[j].map((b, i) => ({ b, i })).sort((a, b) => a.b.cost - b.b.cost);
      const minCost = order[0].b.cost;
      const picks = order.slice(0, KEPT_CANDIDATES).map((x) => x.i);
      if (!picks.includes(ti)) picks.push(ti);
      const candidates: Candidate[] = [];
      let chosen: Candidate | null = null;
      for (const i of picks) {
        const t = tasks[i];
        const comps = costComponents(breakdown[j][i], dw);
        if (i === ti && breakdown[j][i].cost > minCost) comps.push(component('coordination', 'Coordination collective (affectation optimale)', breakdown[j][i].cost - minCost, 1, 's'));
        // Zone / repli déjà tenus (cible à moins de standDistance) : le défenseur reste sur place.
        const held = (t.kind === 'zone' || t.kind === 'recover') && dist(t.point, d.pos) < standDistance;
        const c = moveCandidate(held ? d.pos : t.point, INTENT_OF[t.kind], taskSpeed(t, d, tp.recoverPriority, dw), comps, taskReason(t, breakdown[j][i]), {
          markId: t.markId,
          duration: breakdown[j][i].arrival,
          successPoint: t.point,
        });
        candidates.push(c);
        if (i === ti) chosen = c;
      }
      const explanation = explainDefender(task, breakdown[j][ti], dw, info, order.slice(1, KEPT_CANDIDATES).map((x) => ({ t: tasks[x.i], b: x.b })).filter((x) => x.t !== task), keptGlobal);
      const dec = makeDecision(d.id, state.time, chosen!, candidates, decisionContext(input, d, superiority), explanation, t0);
      // Le temps de calcul de l'affectation collective est réparti entre les défenseurs ; le temps propre est celui de cette itération.
      dec.computeMs = (tSetup - t0) / defenders.length + (performance.now() - tj);
      out.set(d.id, dec);
    }
  }

  if (keeper) out.set(keeper.id, decideKeeper(input, keeper.id, previous.get(keeper.id) ?? null));
  return out;
}

/** Distance de « contain » (m) : containOffset + containSlack·(1 − pressIntensity). */
export function containDistance(dw: SimParams['defence'], pressIntensity: number): number {
  return dw.containOffset + (dw.containSlack ?? DEFAULT_CONTAIN_SLACK) * Math.max(0, 1 - pressIntensity);
}

/**
 * Vitesse de consigne (m/s) d'une tâche défensive (`defence.taskSpeed`). Le repli et la zone sont calmes près de leur
 * point (replacement) et tendent linéairement vers le sprint entre RAMP_START et RAMP_FULL m (la ligne remonte vite après
 * un dégagement, le bloc coulisse sans traîner).
 */
export function taskSpeed(task: DefenceTask, d: Player, recoverPriority: number, dw: SimParams['defence']): number {
  const ts = dw.taskSpeed ?? DEFAULT_TASK_SPEED;
  const ramp = (base: number): number => {
    const far = Math.max(0, Math.min(1, (dist(task.point, d.pos) - RAMP_START) / (RAMP_FULL - RAMP_START)));
    return d.maxSpeed * Math.min(1, base + (1 - base) * far);
  };
  switch (task.kind) {
    case 'press': case 'intercept': case 'chase': return d.maxSpeed;
    case 'contain': return d.maxSpeed * ts.contain;
    case 'mark': return d.maxSpeed * Math.min(1, ts.markBase + ts.markGain * task.priority);
    case 'zone': return ramp(ts.zone);
    default: return ramp(Math.min(1, ts.recoverBase + ts.recoverGain * recoverPriority));
  }
}

function taskReason(task: DefenceTask, b: CostBreakdown): string {
  return `${task.label} : coût ${fmtFr(b.cost, 2)} s (arrivée ${fmtFr(b.arrival, 1)} s, priorité ${fmtFr(task.priority, 2)})`.slice(0, 140);
}

function explainDefender(task: DefenceTask, b: CostBreakdown, dw: SimParams['defence'], info: PressingInfo, alternatives: { t: DefenceTask; b: CostBreakdown }[], keptGlobal: boolean): string {
  const parts: string[] = [`arrivée ${fmtFr(b.arrival, 1)} s`];
  for (const c of costComponents(b, dw)) {
    if (c.key === 'arrival' || Math.abs(c.contribution) < 1e-6) continue;
    parts.push(`${c.label.toLowerCase()} ${fmtFr(-c.contribution, 2, true)} s`);
  }
  const lines = [
    `Tâche : ${task.label} — cible ${fmtPoint(task.point)}, coût ${fmtFr(b.cost, 2)} s.`,
    `Détail : ${parts.join(' ; ')}.`,
    info.counterPress
      ? `Contre-pressing : fenêtre de ${fmtFr(info.tauTrig, 1)} s après la perte, ${info.nPress} presseurs.`
      : info.pressing
        ? `Pressing déclenché : ${info.triggerCount}/${info.required} condition(s) (${info.triggersActive.join(', ')}), ${info.nPress} presseur(s).`
        : `Bloc en place : ${info.triggerCount}/${info.required} condition(s) de pressing${info.triggersActive.length ? ` (${info.triggersActive.join(', ')})` : ''} → contenir le porteur.`,
  ];
  if (alternatives.length) lines.push(`Alternatives : ${alternatives.map((a) => `${a.t.label} (coût ${fmtFr(a.b.cost, 2)} s)`).join(', ')}.`);
  if (keptGlobal) lines.push('Affectation précédente conservée (gain de coût total inférieur au seuil de réaffectation).');
  return lines.join('\n');
}

/** Ré-export pour les tests : intention associée à chaque type de tâche. */
export const TASK_INTENTS = INTENT_OF;

/** Défenseurs de champ d'une équipe (ordre du tableau des joueurs). */
export const outfieldDefenders = (state: MatchState, team: TeamId): Player[] => state.players.filter((p) => p.team === team && p.role !== 'GK');
