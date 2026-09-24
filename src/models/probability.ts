/**
 * Modèles probabilistes de réussite des actions (logistiques sur des caractéristiques physiques,
 * docs/CONCEPTION.md §5). Chaque fonction retourne la probabilité ET les caractéristiques nommées
 * (ScoreComponent : valeur brute, poids = coefficient logistique, contribution = coef·valeur) pour l'explication.
 *
 * Convention des contributions : pour les termes du logit, contribution = β_k·f_k et Σ = logit de la partie
 * logistique ; les facteurs multiplicatifs (1 − P_int, « receveur en premier », hors-jeu) sont exprimés en
 * log-facteur (ln du facteur), de sorte que ln P = Σ contributions − ln(1 + e^{−logit}) reste additif.
 *
 * Attributs individuels (0..1, 0,5 = moyen) : ils modulent mildement les logits, terme
 * `attributeInfluence · (attribut − 0,5)` (passing pour les passes, shooting pour les tirs, dribbling pour
 * dribbles et conservation ; goalkeeping module le rayon d'action du gardien).
 */
import type { Vec2 } from '../core/vec2';
import { sigmoid, dist } from '../core/vec2';
import { PITCH, goalAngle, distToGoal, toTeamFrame } from '../core/pitch';
import type { FieldSet, MatchState, Player, ScoreComponent, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import type { InterceptionAnalysis } from './interception';
import { analyseInterception, arrivalLogistic } from './interception';
import { controlFor, pressureAt, pressureOn, minArrivalTime } from './fields';
import { dribbleTime, timeToArrive } from './motion';
import { isOffsidePosition } from './structure';

export interface ProbabilityResult {
  p: number;
  /** Caractéristiques nommées ayant servi au calcul (valeur brute + contribution au logit). */
  features: ScoreComponent[];
  interception?: InterceptionAnalysis;
}

const DEFAULT_ATTRIBUTE_INFLUENCE = 0.6;
const DEFAULT_KEEPER_REACH_MAX = 1.2;
const DEFAULT_KEEPER_BODY_WIDTH = 1.8;
/** Log-facteur attribué à un facteur nul (hors-jeu) pour rester fini : ln(10⁻⁶). */
const LOG_ZERO = Math.log(1e-6);
/** Rayon (m) du dénombrement des adversaires proches pour la conservation (§5.5). */
const HOLD_CLOSE_RADIUS = 2;
/** Marge (s) accordée au receveur d'une passe en profondeur pour rattraper le ballon (repli si through.reachSlack est absent). */
const DEFAULT_THROUGH_REACH_SLACK = 0.6;

const feat = (key: string, label: string, value: number, weight: number, unit?: string): ScoreComponent => ({
  key, label, value, unit, weight, contribution: weight * value,
});
/** Facteur multiplicatif exprimé en log-facteur (poids 1, contribution = ln f). */
const logFactor = (key: string, label: string, value: number, factor: number, unit?: string): ScoreComponent => ({
  key, label, value, unit, weight: 1, contribution: factor > 0 ? Math.log(factor) : LOG_ZERO,
});

/** Joueur par identifiant (les ids suivent l'ordre du tableau dans les états standard ; repli sur une recherche). */
export function getPlayer(state: MatchState, id: number): Player {
  const direct = state.players[id];
  if (direct && direct.id === id) return direct;
  const p = state.players.find((q) => q.id === id);
  if (!p) throw new Error(`joueur inconnu : ${id}`);
  return p;
}

/** Point de départ de l'action : le ballon s'il est au joueur, sinon la position du joueur. */
const originOf = (state: MatchState, player: Player): Vec2 => (state.ball.ownerId === player.id ? state.ball.pos : player.pos);

const attrInfluence = (params: SimParams): number => params.models.attributeInfluence ?? DEFAULT_ATTRIBUTE_INFLUENCE;

// ---------------------------------------------------------------------------
// §5.1 Passe au pied
// ---------------------------------------------------------------------------
/** Vitesse d'arrivée (m/s) au-delà de laquelle une passe appuyée pénalise le contrôle du receveur (§5.1). */
export const ARRIVAL_SPEED_FREE = 9;
const DEFAULT_ARRIVAL_SPEED_COEF = -0.1;
const DEFAULT_LOB_PENALTY = -1.5;

/**
 * Partie logistique de P_pass (§5.1), hors interception — partagée avec la calibration (§11.6), qui la recalcule sur
 * la passe réellement jouée : `from` est l'origine du ballon, `passer` fournit la pression Π(b) et l'attribut.
 *   logit = 2,4 − 0,03 d − 0,9 Π(b) − 0,6 Π(q_r) − 0,01 max(0, d − 30) − 0,1 max(0, s_arr − 9) + a·(passing − 0,5) [+ β_lob]
 * (coefficients de params.models.pass, termes de distance réajustés §11.6 / §15.2).
 * `aerial` : passe lobée, terme additif pass.lobPenalty (réception d'un ballon retombé à côté du point visé).
 * Retourne le logit et ses termes nommés (sans le log-facteur d'interception).
 */
export function passLogit(state: MatchState, fields: FieldSet, passer: Player, from: Vec2, target: Vec2, params: SimParams, arrivalSpeed: number, aerial = false): { logit: number; features: ScoreComponent[] } {
  const team = passer.team;
  const d = dist(from, target);
  const c = params.models.pass;
  const piBall = pressureAt(state, from, team, params);
  const piTarget = pressureOn(fields, target, team);
  const longExcess = Math.max(0, d - 30);
  const speedExcess = Math.max(0, arrivalSpeed - ARRIVAL_SPEED_FREE);
  const speedCoef = c.arrivalSpeed ?? DEFAULT_ARRIVAL_SPEED_COEF;
  const skill = passer.attrs.passing - 0.5;
  const features: ScoreComponent[] = [
    feat('base', 'Base', 1, c.base),
    feat('distance', 'Distance de passe', d, c.distance, 'm'),
    feat('longDistance', 'Excédent au-delà de 30 m', longExcess, c.longDistance, 'm'),
    feat('passerPressure', 'Pression sur le passeur', piBall, c.passerPressure),
    feat('receiverPressure', 'Pression au point de réception', piTarget, c.receiverPressure),
    feat('arrivalSpeed', 'Passe appuyée (excédent au-delà de 9 m/s)', speedExcess, speedCoef, 'm/s'),
    feat('skill', 'Qualité de passe du joueur', skill, attrInfluence(params)),
  ];
  let logit = c.base + c.distance * d + c.longDistance * longExcess + c.passerPressure * piBall + c.receiverPressure * piTarget + speedCoef * speedExcess + attrInfluence(params) * skill;
  if (aerial) {
    const lob = c.lobPenalty ?? DEFAULT_LOB_PENALTY;
    features.push(feat('lob', 'Réception d’un ballon lobé', 1, lob));
    logit += lob;
  }
  return { logit, features };
}

/**
 * Passe dans les pieds de `receiverId` (ou vers `targetPoint` si fourni : passe « devant »).
 *   P_pass = (1 − P_int) · σ(2,4 − 0,03 d − 0,9 Π(b) − 0,6 Π(q_r) − 0,01 max(0, d − 30) − 0,1 max(0, s_arr − 9) + a·(passing − 0,5)).
 * Π(b) est exact (ponctuel), Π(q_r) est lu sur la grille du cycle. `arrivalSpeed` (m/s) permet de tester
 * les vitesses candidates {4, 6, 9, 10} ; défaut physics.passArrivalSpeed.
 * Ancrages (sans interception) : 15 m libre ≈ 0,86 ; 35 m sous pression Π(b) = 1 ≈ 0,5.
 */
export function passProbability(state: MatchState, fields: FieldSet, passerId: number, receiverId: number, targetPoint: Vec2, params: SimParams, arrivalSpeed?: number): ProbabilityResult {
  const passer = getPlayer(state, passerId);
  const team = passer.team;
  const from = originOf(state, passer);
  const target = targetPoint ?? getPlayer(state, receiverId).pos;
  const sArr = arrivalSpeed ?? params.physics.passArrivalSpeed;
  const interception = analyseInterception(state, from, target, 'pass', team, params, sArr);
  const { logit, features } = passLogit(state, fields, passer, from, target, params, sArr);
  features.push(logFactor('interception', 'Risque d’interception', interception.pIntercept, 1 - interception.pIntercept));
  return { p: (1 - interception.pIntercept) * sigmoid(logit), features, interception };
}

// ---------------------------------------------------------------------------
// §5.2 Passe en profondeur
// ---------------------------------------------------------------------------
/**
 * Passe en profondeur vers `targetPoint`, destinée à `receiverId` (course) :
 *   P = (1 − P_int) · logit⁻¹((min_j T_j(q) − T_k(q))/σ_T) · logit⁻¹((T_b(q) + δ_reach − T_k(q))/σ_T)
 *       · σ(1,8 − 0,03 d − 0,8 Π(b) + a·(passing − 0,5)) · 1[onside(k)],
 * s_arr = physics.throughArrivalSpeed ; hors-jeu évalué à la position du receveur au lancement (§3.4).
 * Le facteur « receveur au rendez-vous » (δ_reach = through.reachSlack) exprime que le receveur doit rejoindre le
 * ballon avant qu'il ne le dépasse : un ballon lancé pour arriver à 9 m/s continue sa course au-delà de q, et un
 * receveur trop en retard le manque (passe « manquée » du moteur), même sans défenseur.
 */
export function throughBallProbability(state: MatchState, fields: FieldSet, passerId: number, receiverId: number, targetPoint: Vec2, params: SimParams): ProbabilityResult {
  const passer = getPlayer(state, passerId);
  const receiver = getPlayer(state, receiverId);
  const team = passer.team;
  const from = originOf(state, passer);
  const d = dist(from, targetPoint);
  const c = params.models.through;
  const m = params.models;
  const interception = analyseInterception(state, from, targetPoint, 'through', team, params, params.physics.throughArrivalSpeed);
  const tReceiver = timeToArrive(receiver.pos, receiver.vel, targetPoint, receiver.maxSpeed, receiver.maxAccel, m);
  let tOpp = Infinity;
  for (const o of state.players) {
    if (o.team === team) continue;
    const t = timeToArrive(o.pos, o.vel, targetPoint, o.maxSpeed, o.maxAccel, m);
    if (t < tOpp) tOpp = t;
  }
  const lead = tOpp === Infinity ? 10 : tOpp - tReceiver;
  const first = arrivalLogistic(lead / Math.max(1e-6, m.arrivalSigma));
  const reachLead = interception.travelTime + (c.reachSlack ?? DEFAULT_THROUGH_REACH_SLACK) - tReceiver;
  const reach = Number.isFinite(reachLead) ? arrivalLogistic(reachLead / Math.max(1e-6, m.arrivalSigma)) : 1;
  const offside = isOffsidePosition(state, receiver.pos, team);
  const piBall = pressureAt(state, from, team, params);
  const skill = passer.attrs.passing - 0.5;
  const features: ScoreComponent[] = [
    feat('base', 'Base', 1, c.base),
    feat('distance', 'Longueur de la passe', d, c.distance, 'm'),
    feat('passerPressure', 'Pression sur le passeur', piBall, c.passerPressure),
    feat('skill', 'Qualité de passe du joueur', skill, attrInfluence(params)),
    logFactor('receiverFirst', 'Avance du receveur sur le défenseur', lead, first, 's'),
    logFactor('receiverReach', 'Receveur au rendez-vous avec le ballon', reachLead, reach, 's'),
    logFactor('interception', 'Risque d’interception', interception.pIntercept, 1 - interception.pIntercept),
    logFactor('offside', 'Receveur hors-jeu', offside ? 1 : 0, offside ? 0 : 1),
  ];
  const logit = c.base + c.distance * d + c.passerPressure * piBall + attrInfluence(params) * skill;
  const p = offside ? 0 : (1 - interception.pIntercept) * first * reach * sigmoid(logit);
  void fields;
  return { p, features, interception };
}

// ---------------------------------------------------------------------------
// §5.3 Dribble
// ---------------------------------------------------------------------------
/**
 * Dribble du porteur `playerId` vers `targetPoint` (d ≤ 8 m en pratique) :
 *   P = σ(1,5 − 1,2 Π̄_path − 0,15 d + 0,8 (PC_att(q) − 0,5) + 1,0 tanh(min_j T_j(q) − T_drib(q)) + a·(dribbling − 0,5)),
 * Π̄_path = moyenne de la pression sur M points du trajet (grille), PC_att(q) lu sur fields.controlA,
 * T_drib(q) = temps de conduite du ballon avec la même cinématique que les adversaires (`dribbleTime` : accélération
 * bornée depuis la vitesse courante, plafond v_drib = dribbleSpeedFactor · v_max) — et non d/v_drib, qui accordait
 * au porteur un départ lancé instantané alors que les défenseurs payaient réaction et accélération.
 * Ancrages : 4 m libre ≈ 0,9 ; 4 m contesté ≈ 0,32.
 */
export function dribbleProbability(state: MatchState, fields: FieldSet, playerId: number, targetPoint: Vec2, params: SimParams): ProbabilityResult {
  const player = getPlayer(state, playerId);
  const team = player.team;
  const from = originOf(state, player);
  const d = dist(from, targetPoint);
  const c = params.models.dribble;
  const M = Math.max(1, Math.floor(params.models.interceptSamples));
  let piSum = 0;
  for (let s = 1; s <= M; s++) {
    const f = s / M;
    piSum += pressureOn(fields, { x: from.x + (targetPoint.x - from.x) * f, y: from.y + (targetPoint.y - from.y) * f }, team);
  }
  const piPath = piSum / M;
  const control = controlFor(fields, targetPoint, team);
  const tDrib = dribbleTime(from, player.vel, targetPoint, player.maxSpeed, player.maxAccel, params.physics);
  const tOpp = minArrivalTime(state, targetPoint, params, team === 'A' ? 'B' : 'A');
  const raceMargin = (tOpp === Infinity ? 10 : tOpp) - tDrib;
  const race = Math.tanh(raceMargin);
  const raceCoef = c.race ?? 1.0;
  const skill = player.attrs.dribbling - 0.5;
  const features: ScoreComponent[] = [
    feat('base', 'Base', 1, c.base),
    feat('pathPressure', 'Pression moyenne sur le trajet', piPath, c.pathPressure),
    feat('distance', 'Distance du dribble', d, c.distance, 'm'),
    feat('control', 'Contrôle du terrain à l’arrivée (− 0,5)', control - 0.5, c.control),
    feat('race', 'Course gagnée sur le défenseur (tanh)', race, raceCoef),
    feat('skill', 'Qualité de dribble du joueur', skill, attrInfluence(params)),
  ];
  const logit = c.base + c.pathPressure * piPath + c.distance * d + c.control * (control - 0.5) + raceCoef * race + attrInfluence(params) * skill;
  return { p: sigmoid(logit), features };
}

// ---------------------------------------------------------------------------
// §5.4 Tir
// ---------------------------------------------------------------------------
/** Rayon d'action du gardien r_gk = min(r_max, base + gain·T_vol), modulé par son attribut goalkeeping (×(0,9 + 0,2·gk)). */
export function keeperReach(keeper: Player | null, tFlight: number, params: SimParams): number {
  const m = params.models;
  const base = Math.min(m.keeperReachMax ?? DEFAULT_KEEPER_REACH_MAX, m.keeperReachBase + m.keeperReachPerSecond * tFlight);
  const gk = keeper ? keeper.attrs.goalkeeping : 0.5;
  return base * (0.9 + 0.2 * gk);
}

/** Intervalle angulaire [lo, hi] (repère équipe, but en +x) sous lequel un segment centré en `centre`, de demi-largeur `half`, perpendiculaire à la ligne de visée, est vu depuis `from`. */
function angularInterval(from: Vec2, centre: Vec2, half: number): [number, number] | null {
  const rx = centre.x - from.x, ry = centre.y - from.y;
  const r = Math.hypot(rx, ry);
  if (r < 1e-6 || rx <= 0) return null;
  const a = Math.atan2(ry, rx);
  const h = Math.atan(half / r);
  return [a - h, a + h];
}

/**
 * Couverture du gardien c_gk ∈ [0, 1] (§5.4) : fraction de l'angle de tir ω masquée par un segment de
 * largeur (keeperBodyWidth + 2 r_gk) centré sur le gardien, vu depuis le tireur. Repère équipe (but en +x).
 * Un gardien derrière le tireur ou derrière sa ligne de but ne couvre rien.
 */
export function keeperCoverage(shooterPos: Vec2, keeperPos: Vec2, team: TeamId, tFlight: number, params: SimParams, keeper: Player | null = null): number {
  const dir = attackDir(team);
  const s = toTeamFrame(shooterPos, dir);
  const k = toTeamFrame(keeperPos, dir);
  if (k.x > PITCH.halfLength + 0.5) return 0;
  const omega = goalAngle(shooterPos, dir);
  if (omega < 1e-6) return 0;
  const half = (params.models.keeperBodyWidth ?? DEFAULT_KEEPER_BODY_WIDTH) / 2 + keeperReach(keeper, tFlight, params);
  const ki = angularInterval(s, k, half);
  if (!ki) return 0;
  const a1 = Math.atan2(-PITCH.goalHalfWidth - s.y, PITCH.halfLength - s.x);
  const a2 = Math.atan2(PITCH.goalHalfWidth - s.y, PITCH.halfLength - s.x);
  const lo = Math.min(a1, a2), hi = Math.max(a1, a2);
  const overlap = Math.max(0, Math.min(hi, ki[1]) - Math.max(lo, ki[0]));
  return Math.min(1, overlap / (hi - lo));
}

/** La direction de visée (tireur → aimPoint) tombe-t-elle dans le secteur couvert par le gardien ? (aide au choix du point de visée, §3.3) */
export function isAimCovered(shooterPos: Vec2, aimPoint: Vec2, keeperPos: Vec2, team: TeamId, tFlight: number, params: SimParams, keeper: Player | null = null): boolean {
  const dir = attackDir(team);
  const s = toTeamFrame(shooterPos, dir);
  const k = toTeamFrame(keeperPos, dir);
  const a = toTeamFrame(aimPoint, dir);
  const half = (params.models.keeperBodyWidth ?? DEFAULT_KEEPER_BODY_WIDTH) / 2 + keeperReach(keeper, tFlight, params);
  const ki = angularInterval(s, k, half);
  if (!ki) return false;
  const aim = Math.atan2(a.y - s.y, a.x - s.x);
  return aim >= ki[0] && aim <= ki[1];
}

/** Le point p est-il dans le triangle (a, b, c) ? */
function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  const neg = s1 < 0 || s2 < 0 || s3 < 0;
  const pos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(neg && pos);
}

/** Nombre de défenseurs de champ (hors gardien) dans le cône de tir (triangle tireur–poteaux). */
export function shotBlockers(state: MatchState, shooterPos: Vec2, team: TeamId): number {
  const dir = attackDir(team);
  const p1 = { x: dir * PITCH.halfLength, y: -PITCH.goalHalfWidth };
  const p2 = { x: dir * PITCH.halfLength, y: PITCH.goalHalfWidth };
  let n = 0;
  for (const o of state.players) {
    if (o.team === team || o.role === 'GK') continue;
    if (dist(o.pos, shooterPos) < 0.3) continue;
    if (inTriangle(o.pos, shooterPos, p1, p2)) n++;
  }
  return n;
}

/**
 * Tir de `shooterId` vers `aimPoint` (sur la ligne de but) : xG avec gardien et contreurs (§5.4).
 *   xG = σ(−1,1 + 3,0 ω − 0,08 d_G − 1,5 c_gk − 0,9 n_blk − 0,5 Π(b) + a·(shooting − 0,5)),
 * T_flight = d_G / s_shot. Ancrages (gardien centré sur sa ligne, sans pression) : 6 m axial ≈ 0,71 ;
 * point de penalty ≈ 0,28 ; 18 m axial ≈ 0,10 ; 25 m ≈ 0,04.
 * Conformément au §5.4, xG ne dépend pas du point de visée ; `isAimCovered` aide à choisir la visée.
 */
export function shotProbability(state: MatchState, fields: FieldSet, shooterId: number, aimPoint: Vec2, params: SimParams): ProbabilityResult {
  const shooter = getPlayer(state, shooterId);
  const team = shooter.team;
  const dir = attackDir(team);
  const from = originOf(state, shooter);
  const c = params.models.shot;
  const omega = goalAngle(from, dir);
  const dG = distToGoal(from, dir);
  const tFlight = dG / params.physics.shotSpeed;
  let keeper: Player | null = null;
  for (const o of state.players) if (o.team !== team && o.role === 'GK') { keeper = o; break; }
  const cgk = keeper ? keeperCoverage(from, keeper.pos, team, tFlight, params, keeper) : 0;
  const nBlk = shotBlockers(state, from, team);
  const piBall = pressureAt(state, from, team, params);
  const skill = shooter.attrs.shooting - 0.5;
  const features: ScoreComponent[] = [
    feat('base', 'Base', 1, c.base),
    feat('angle', 'Angle de tir', omega, c.angle, 'rad'),
    feat('distance', 'Distance au but', dG, c.distance, 'm'),
    feat('keeperCoverage', 'Couverture du gardien', cgk, c.keeperCoverage),
    feat('blockers', 'Défenseurs dans le cône de tir', nBlk, c.blockers),
    feat('pressure', 'Pression sur le tireur', piBall, c.pressure),
    feat('skill', 'Qualité de frappe du joueur', skill, attrInfluence(params)),
  ];
  const logit = c.base + c.angle * omega + c.distance * dG + c.keeperCoverage * cgk + c.blockers * nBlk + c.pressure * piBall + attrInfluence(params) * skill;
  void fields; void aimPoint;
  return { p: sigmoid(logit), features };
}

// ---------------------------------------------------------------------------
// §5.5 Conservation
// ---------------------------------------------------------------------------
/**
 * Conservation du ballon pendant un cycle de décision :
 *   P_hold = σ(2,5 − 1,6 Π(b) − 0,3 n_2m + a·(dribbling − 0,5)), n_2m = adversaires à moins de 2 m du ballon.
 */
export function holdProbability(state: MatchState, fields: FieldSet, playerId: number, params: SimParams): ProbabilityResult {
  const player = getPlayer(state, playerId);
  const team = player.team;
  const from = originOf(state, player);
  const c = params.models.hold;
  const piBall = pressureAt(state, from, team, params);
  let close = 0;
  for (const o of state.players) if (o.team !== team && dist(o.pos, from) < HOLD_CLOSE_RADIUS) close++;
  const skill = player.attrs.dribbling - 0.5;
  const features: ScoreComponent[] = [
    feat('base', 'Base', 1, c.base),
    feat('pressure', 'Pression sur le porteur', piBall, c.pressure),
    feat('closeOpponents', 'Adversaires à moins de 2 m', close, c.closeOpponents),
    feat('skill', 'Protection de balle du joueur', skill, attrInfluence(params)),
  ];
  const logit = c.base + c.pressure * piBall + c.closeOpponents * close + attrInfluence(params) * skill;
  void fields;
  return { p: sigmoid(logit), features };
}
