/**
 * Exécution des actions décidées : frappe du ballon (passe, passe en profondeur, lob, dégagement, tir) avec bruit
 * d'exécution (§3.2), dribble, conservation, mise à jour des cibles de déplacement. Émet les événements correspondants.
 * Le tir suit §3.3 : l'issue (but / arrêt / hors cadre) est tirée à la frappe avec la probabilité xG, puis la
 * trajectoire est choisie pour que la physique (rules.ts) produise cette issue.
 */
import type { Action, BallFlight, BallFlightKind, MatchState, Player, SimParams } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import type { Rng } from '../core/rng';
import type { Vec2 } from '../core/vec2';
import { clamp, clamp01 } from '../core/vec2';
import { PITCH, clampToPitch } from '../core/pitch';
import { pushEvent } from './rules';
import { GRAVITY, isFrozen, isOffsidePosition, keeperOf, launchSpeed, lobKinematics, modelShotXG, nearestOpponent, playerById, pressureAt } from './helpers';

const DEG = Math.PI / 180;
/** Les cibles de déplacement restent à 0,5 m à l'intérieur du terrain. */
const TARGET_MARGIN = 0.5;
/** Conservation : cible à 1 m à l'opposé de l'adversaire le plus proche, à 2 m/s. */
const HOLD_DISTANCE = 1;
const HOLD_SPEED = 2;
/** Points de visée d'un tir (ordonnée sur la ligne de but, m) ; |y| ≤ 3,2 pour rester entre les poteaux. */
const SHOT_AIMS = [-2.9, 0, 2.9];
const SHOT_AIM_MAX = 3.2;
/** Tir manqué : 1 à 3 m à côté du poteau, ou au-dessus de la barre (probabilité 0,3, hauteur 3,5 m). */
const MISS_OUTSIDE_MIN = 1;
const MISS_OUTSIDE_MAX = 3;
const MISS_OVER_BAR_PROB = 0.3;
const MISS_OVER_BAR_HEIGHT = 3.5;
/** Distance minimale d'une frappe (m) : en dessous, on frappe dans la direction d'attaque. */
const MIN_KICK_DISTANCE = 0.5;

/** Applique l'action du joueur à l'état (mutation en place). Retourne true si l'action a été déclenchée. */
export function executeAction(state: MatchState, playerId: number, action: Action, params: SimParams, rng: Rng): boolean {
  const player = playerById(state, playerId);
  if (!player) return false;
  switch (action.type) {
    case 'move':
      return doMove(player, action.target, action.speed);
    case 'hold':
      return doHold(state, player);
    case 'dribble':
      return doDribble(state, player, action.direction, action.distance, params);
    case 'pass':
    case 'clear':
      return doKick(state, player, action, params, rng);
    case 'shoot':
      return doShoot(state, player, action, params, rng);
    default:
      return false;
  }
}

/** Le joueur peut-il frapper le ballon maintenant ? (porteur, jeu non gelé, délai entre deux touches écoulé) */
export function canKick(state: MatchState, player: Player, params: SimParams): boolean {
  return state.ball.ownerId === player.id && !isFrozen(state) && state.time - player.lastKickTime >= params.physics.kickCooldown;
}

function doMove(player: Player, target: Vec2, speed: number): boolean {
  player.target = clampToPitch(target, TARGET_MARGIN);
  player.targetSpeed = clamp(speed, 0, player.maxSpeed);
  return true;
}

function doHold(state: MatchState, player: Player): boolean {
  const opp = nearestOpponent(state, player.pos, player.team);
  let tx = player.pos.x, ty = player.pos.y;
  if (opp) {
    const dx = player.pos.x - opp.pos.x, dy = player.pos.y - opp.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) { tx += (dx / d) * HOLD_DISTANCE; ty += (dy / d) * HOLD_DISTANCE; } else tx += attackDir(player.team) * HOLD_DISTANCE;
  }
  player.target = clampToPitch({ x: tx, y: ty }, TARGET_MARGIN);
  player.targetSpeed = HOLD_SPEED;
  return state.ball.ownerId === player.id;
}

/** Une prise à défaut suppose l'adversaire devant le dribbleur : cos(angle direction → adversaire) ≥ 0,5 (± 60°). */
const TAKE_ON_MIN_COS = 0.5;

/**
 * Conduite de balle vers `direction` à `distance`. Un événement « dribble » (prise à défaut) n'est journalisé que si
 * aucune prise à défaut n'est en cours et qu'un adversaire se trouve à moins de `takeOnRadius`, devant le dribbleur ;
 * une conduite sans opposition ne compte pas. La prise à défaut en cours (`lastDribbleStart`) est gagnée par la
 * physique (duel remporté, rules.ts), perdue (tacle, sortie) ou expire sans issue une fois le porteur dégagé.
 */
function doDribble(state: MatchState, player: Player, direction: Vec2, distance: number, params: SimParams): boolean {
  if (state.ball.ownerId !== player.id || isFrozen(state)) return false;
  let ux = direction.x, uy = direction.y;
  const n = Math.hypot(ux, uy);
  if (n < 1e-9) { ux = attackDir(player.team); uy = 0; } else { ux /= n; uy /= n; }
  const d = Math.max(0, distance);
  player.target = clampToPitch({ x: player.pos.x + ux * d, y: player.pos.y + uy * d }, TARGET_MARGIN);
  player.targetSpeed = player.maxSpeed;
  if (player.lastDribbleStart === undefined) {
    const opp = nearestOpponent(state, player.pos, player.team);
    if (opp) {
      const ox = opp.pos.x - player.pos.x, oy = opp.pos.y - player.pos.y;
      const od = Math.hypot(ox, oy);
      if (od <= params.physics.takeOnRadius && (od < 1e-6 || (ox * ux + oy * uy) / od >= TAKE_ON_MIN_COS)) {
        player.lastDribbleStart = state.time;
        pushEvent(state, { time: state.time, kind: 'dribble', team: player.team, playerId: player.id, pos: { x: player.pos.x, y: player.pos.y } });
      }
    }
  }
  return true;
}

/** Passe / passe en profondeur / lob / dégagement : vitesse de lancement §3.2, bruit d'exécution, libération du ballon. */
function doKick(state: MatchState, player: Player, action: Extract<Action, { type: 'pass' | 'clear' }>, params: SimParams, rng: Rng): boolean {
  if (!canKick(state, player, params)) return false;
  const ph = params.physics;
  const ball = state.ball;
  const time = state.time;
  const isClear = action.type === 'clear';
  const kind: BallFlightKind = isClear ? 'clearance' : action.kind === 'through' ? 'through' : action.kind === 'lob' ? 'lob' : 'pass';
  const origin: Vec2 = { x: ball.pos.x, y: ball.pos.y };
  let ox = action.targetPoint.x - origin.x, oy = action.targetPoint.y - origin.y;
  let d = Math.hypot(ox, oy);
  if (d < MIN_KICK_DISTANCE) { ox = attackDir(player.team) * MIN_KICK_DISTANCE; oy = 0; d = MIN_KICK_DISTANCE; }
  const defaultArrival = kind === 'through' ? ph.throughArrivalSpeed : ph.passArrivalSpeed;
  const arrival = !isClear && action.speed > 0 ? action.speed : defaultArrival;
  let s0 = launchSpeed(d, arrival, ph);

  // Bruit d'exécution : direction N(0, σ_deg + σ_pressure·Π(b)), vitesse ±speedNoise
  const pressure = pressureAt(state, ball.pos, player.team, params);
  const sigmaDeg = ph.executionNoiseDeg + ph.executionNoisePressure * pressure;
  const angle = Math.atan2(oy, ox) + (sigmaDeg > 0 ? rng.normal(0, sigmaDeg) * DEG : 0);
  if (ph.speedNoise > 0) s0 *= 1 + rng.normal(0, ph.speedNoise);
  s0 = clamp(s0, 1, ph.passSpeedMax);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let vx = cos * s0, vy = sin * s0, vz = 0;
  if (kind === 'lob' || isClear) {
    // Vol balistique à 45° (même modèle que la décision : lobKinematics) ; le bruit de vitesse porte sur la portée
    const lob = lobKinematics(d * (ph.speedNoise > 0 ? 1 + rng.normal(0, ph.speedNoise) : 1), ph);
    vx = cos * lob.hs;
    vy = sin * lob.hs;
    vz = lob.vz;
    s0 = lob.initialSpeed;
  }

  ball.ownerId = null;
  ball.lastTouchId = player.id;
  ball.vel = { x: vx, y: vy };
  ball.z = 0;
  ball.vz = vz;
  const flight: BallFlight = {
    kind, kickerId: player.id, targetId: isClear ? null : action.targetId,
    targetPoint: { x: action.targetPoint.x, y: action.targetPoint.y }, origin, startTime: time, initialSpeed: s0,
  };
  if (!isClear) {
    const receiver = playerById(state, action.targetId);
    if (receiver && receiver.team === player.team) flight.receiverOffside = isOffsidePosition(state, receiver.pos, player.team);
  }
  ball.flight = flight;
  player.lastKickTime = time;

  if (isClear) {
    pushEvent(state, { time, kind: 'clearance', team: player.team, playerId: player.id, pos: origin, label: `Dégagement de ${player.name}` });
  } else {
    if (kind === 'through') state.stats[player.team].throughBalls++;
    pushEvent(state, { time, kind: 'pass', team: player.team, playerId: player.id, targetId: action.targetId, pos: origin });
  }
  return true;
}

/** La trajectoire rectiligne (origine, vitesse, vz) passe-t-elle entre les poteaux, sous la barre, du but attaqué ? */
export function crossesGoalMouth(origin: Vec2, vel: Vec2, vz: number, dir: 1 | -1): boolean {
  if (vel.x * dir <= 1e-9) return false;
  const t = (dir * PITCH.halfLength - origin.x) / vel.x;
  if (t < 0) return false;
  const y = origin.y + vel.y * t;
  const z = Math.max(0, vz * t - 0.5 * GRAVITY * t * t);
  return Math.abs(y) < PITCH.goalHalfWidth && z < PITCH.goalHeight;
}

/** Tir (§3.3) : issue tirée avec xG, trajectoire cohérente avec l'issue, vitesse s_shot. */
function doShoot(state: MatchState, player: Player, action: Extract<Action, { type: 'shoot' }>, params: SimParams, rng: Rng): boolean {
  if (!canKick(state, player, params)) return false;
  const ph = params.physics;
  const ball = state.ball;
  const time = state.time;
  const dir = attackDir(player.team);
  const gx = dir * PITCH.halfLength;
  const keeper = keeperOf(state, otherTeam(player.team));
  const origin: Vec2 = { x: ball.pos.x, y: ball.pos.y };
  const xg = clamp01(
    action.xg !== undefined && Number.isFinite(action.xg)
      ? action.xg
      : state.fields ? modelShotXG(state, state.fields, player.id, action.targetPoint, params, ph.defaultShotXG) : ph.defaultShotXG,
  );

  // Issue tirée à la frappe
  let outcome: 'goal' | 'save' | 'miss';
  if (rng.bernoulli(xg)) outcome = 'goal';
  else if (keeper && (keeper.pos.x - origin.x) * dir > MIN_KICK_DISTANCE && rng.bernoulli(ph.saveProb)) outcome = 'save';
  else outcome = 'miss';

  let aim: Vec2;
  let vz = 0;
  const preferredSide = action.targetPoint.y !== 0 ? Math.sign(action.targetPoint.y) : rng.bernoulli(0.5) ? 1 : -1;
  if (outcome === 'goal') {
    // Point de visée le plus éloigné du gardien (à défaut, le plus proche de la cible demandée)
    let bestY = clamp(action.targetPoint.y, -SHOT_AIM_MAX, SHOT_AIM_MAX);
    if (keeper) {
      let bestScore = -Infinity;
      for (const y of SHOT_AIMS) {
        const score = Math.abs(y - keeper.pos.y) + 1e-3 * Math.sign(y) * preferredSide;
        if (score > bestScore) { bestScore = score; bestY = y; }
      }
    }
    aim = { x: gx, y: bestY };
  } else if (outcome === 'save') {
    aim = { x: keeper!.pos.x, y: keeper!.pos.y };
  } else if (rng.bernoulli(MISS_OVER_BAR_PROB)) {
    aim = { x: gx, y: preferredSide * rng.uniform(0, PITCH.goalHalfWidth - 0.5) };
    const T = Math.hypot(aim.x - origin.x, aim.y - origin.y) / ph.shotSpeed;
    vz = (MISS_OVER_BAR_HEIGHT + 0.5 * GRAVITY * T * T) / T;
  } else {
    aim = { x: gx, y: preferredSide * (PITCH.goalHalfWidth + rng.uniform(MISS_OUTSIDE_MIN, MISS_OUTSIDE_MAX)) };
  }

  let ux = aim.x - origin.x, uy = aim.y - origin.y;
  const n = Math.hypot(ux, uy);
  if (n < 1e-6) { ux = dir; uy = 0; } else { ux /= n; uy /= n; }
  const vel: Vec2 = { x: ux * ph.shotSpeed, y: uy * ph.shotSpeed };
  const onTarget = crossesGoalMouth(origin, vel, vz, dir);

  ball.ownerId = null;
  ball.lastTouchId = player.id;
  ball.vel = vel;
  ball.z = 0;
  ball.vz = vz;
  ball.flight = {
    kind: 'shot', kickerId: player.id, targetId: null, targetPoint: aim, origin, startTime: time, initialSpeed: ph.shotSpeed,
    outcome, onTarget, expectedP: xg,
  };
  player.lastKickTime = time;

  const stats = state.stats[player.team];
  if (outcome !== 'miss') stats.shotsOnTarget++;
  stats.xG += xg;
  pushEvent(state, { time, kind: 'shot', team: player.team, playerId: player.id, pos: origin, value: xg, label: `Tir de ${player.name} (xG ${xg.toFixed(2)})` });
  return true;
}
