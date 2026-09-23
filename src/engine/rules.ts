/**
 * Règles (§3.4) : buts, sorties de balle, remises en jeu simplifiées, hors-jeu, arrêts et contres de tirs,
 * changement de possession, phases de jeu (attaque / défense / transitions), journal et statistiques.
 * Les issues physiques (prise de balle, tacle, duel) sont lues dans la file déposée par stepPhysics.
 */
import type { MatchConfig, MatchState, MatchEvent, Player, Restart, TeamId, BallFlight, SimParams } from '../core/types';
import { TEAMS, attackDir, otherTeam } from '../core/types';
import type { AttackDir } from '../core/pitch';
import { PITCH } from '../core/pitch';
import type { Vec2 } from '../core/vec2';
import { clamp, dist, distToSegment } from '../core/vec2';
import type { Rng } from '../core/rng';
import { giveBall, kickoffPositions, setupKickoff } from './match';
import { takePhysicsEvents, type PhysicsEvent } from './physics';
import { isFrozen, keeperOf, nearestPlayer, playerById, playerLabel, teamLabel } from './helpers';

/** Taille maximale du journal d'événements. */
export const MAX_EVENTS = 200;
/** Abscisse (repère équipe défendante) du point de six mètres pour une sortie de but. */
const GOAL_KICK_X = 47;
/** Marge (m) à l'intérieur du terrain pour placer une remise en jeu. */
const RESTART_MARGIN = 0.5;
/** Tolérance (m) au-delà des lignes pour un ballon conduit (les cibles sont bornées à l'intérieur du terrain). */
const OWNED_OUT_TOLERANCE = 0.3;
/** Vitesse relative conservée par un tir contré, et déviation latérale maximale (m/s). */
const BLOCK_REBOUND = 0.2;
const BLOCK_LATERAL = 3;
/** Distance (m) derrière la ligne de but à laquelle est posé un ballon dévié en corner par le gardien. */
const DEFLECTION_BEHIND = 0.5;
/** Ballons haut (m) : un tir à cette hauteur ne peut plus être contré. */
const BLOCK_MAX_HEIGHT = 1.6;

const isPassKind = (kind: BallFlight['kind']): boolean => kind === 'pass' || kind === 'through' || kind === 'lob';

// ---------------------------------------------------------------------------
// Journal et statistiques
// ---------------------------------------------------------------------------

/** Libellé français par défaut d'un événement. */
function describeEvent(state: MatchState, e: MatchEvent): string {
  const who = playerLabel(state, e.playerId);
  const to = playerLabel(state, e.targetId);
  switch (e.kind) {
    case 'goal': return e.playerId !== undefined ? `But de ${who}` : `But pour l'${teamLabel(e.team)}`;
    case 'shot': return `Tir de ${who}`;
    case 'pass': return e.targetId !== undefined ? `Passe de ${who} vers ${to}` : `Frappe de ${who}`;
    case 'pass_complete': return `Passe réussie ${who} → ${to}`;
    case 'pass_intercepted': return `Interception de ${who} (passe de ${to})`;
    case 'pass_failed': return `Passe manquée de ${who}`;
    case 'dribble': return `Dribble de ${who}`;
    case 'dribble_failed': return `Dribble raté de ${who}`;
    case 'tackle': return `Tacle de ${who} sur ${to}`;
    case 'turnover': return `Perte de balle de l'${teamLabel(e.team)}${e.playerId !== undefined ? ` (${who})` : ''}`;
    case 'out': return `Sortie de balle (dernier toucheur ${who})`;
    case 'restart': return `Reprise pour l'${teamLabel(e.team)}${e.playerId !== undefined ? ` par ${who}` : ''}`;
    case 'save': return `Arrêt de ${who}`;
    case 'possession_change': return `Possession : ${teamLabel(e.team)}`;
    case 'offside': return `Hors-jeu de ${who}`;
    default: return e.kind;
  }
}

/** Ajoute un événement au journal (borné) et met à jour les statistiques de comptage. */
export function pushEvent(state: MatchState, event: MatchEvent): void {
  if (!event.label) event.label = describeEvent(state, event);
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  const s = state.stats[event.team];
  if (!s) return;
  switch (event.kind) {
    case 'goal': s.goals++; break;
    case 'shot': s.shots++; break;
    case 'pass': s.passes++; break;
    case 'pass_complete': s.passesCompleted++; break;
    case 'pass_intercepted': s.interceptions++; break;
    case 'tackle': s.tackles++; break;
    case 'turnover': s.turnovers++; break;
    case 'dribble': s.dribbles++; break;
    default: break;
  }
}

/**
 * Change l'équipe en possession : événement `possession_change` pour l'équipe qui récupère et, si `turnover`,
 * événement `turnover` pour l'équipe qui perd (jamais sur une sortie de balle ou un but).
 */
export function changePossession(state: MatchState, team: TeamId, turnover: boolean, pos?: Vec2, loserId?: number): void {
  if (state.possession === team) return;
  const loser = state.possession;
  state.possession = team;
  state.possessionSince = state.time;
  const p = pos ? { x: pos.x, y: pos.y } : { x: state.ball.pos.x, y: state.ball.pos.y };
  pushEvent(state, { time: state.time, kind: 'possession_change', team, pos: p });
  if (turnover && loser) {
    // Le joueur fautif n'est attribué que s'il appartient bien à l'équipe qui perd le ballon
    const culprit = loserId !== undefined ? playerById(state, loserId) : undefined;
    pushEvent(state, { time: state.time, kind: 'turnover', team: loser, playerId: culprit && culprit.team === loser ? culprit.id : undefined, pos: { ...p } });
  }
}

// ---------------------------------------------------------------------------
// Règles
// ---------------------------------------------------------------------------

/** Applique les règles après un pas de physique (mutation en place). */
export function applyRules(state: MatchState, config: MatchConfig, rng: Rng): void {
  const params = config.params;
  const ph = params.physics;

  // 1. Issues physiques du tick (prises de balle, tacles, duels)
  for (const ev of takePhysicsEvents(state)) handlePhysicsEvent(state, ev, params);

  // 2. Reprise du jeu après un gel
  if (state.restart && state.time >= state.restart.resumeAt - 1e-9) resumeRestart(state, config);

  // 3. Tirs, buts, sorties, fin de trajectoire
  if (!isFrozen(state)) {
    if (state.ball.ownerId === null) resolveShot(state, params, rng);
    if (!state.restart) checkBallOut(state, params, rng);
    if (!state.restart && state.ball.ownerId === null) checkFlightEnded(state);
  }

  // 4. Issues des dribbles
  updateDribbles(state, ph);

  // 5. Temps de possession
  if (state.possession) state.stats[state.possession].possessionTime += ph.dt;
}

function handlePhysicsEvent(state: MatchState, ev: PhysicsEvent, params: SimParams): void {
  switch (ev.kind) {
    case 'control':
      onControl(state, ev, params);
      break;
    case 'tackle': {
      const tackler = playerById(state, ev.tacklerId);
      const victim = playerById(state, ev.victimId);
      if (!tackler || !victim) return;
      pushEvent(state, {
        time: state.time, kind: 'tackle', team: tackler.team, playerId: tackler.id, targetId: victim.id,
        pos: { x: victim.pos.x, y: victim.pos.y }, value: ev.probability,
      });
      failDribble(state, victim);
      if (!ev.loose) changePossession(state, tackler.team, true, victim.pos, victim.id);
      break;
    }
    case 'duel_won':
      // Le défenseur est « passé » (immobilisé par la physique) ; rien à comptabiliser ici.
      break;
    default:
      break;
  }
}

/** Prise de balle : hors-jeu, passe réussie / interceptée, changement de possession. */
function onControl(state: MatchState, ev: Extract<PhysicsEvent, { kind: 'control' }>, params: SimParams): void {
  const taker = playerById(state, ev.playerId);
  if (!taker) return;
  const fl = ev.flight;
  const team = taker.team;
  if (fl && isPassKind(fl.kind)) {
    const kicker = playerById(state, fl.kickerId);
    if (kicker && kicker.team === team) {
      if (fl.receiverOffside && fl.targetId === taker.id) {
        whistleOffside(state, taker, params);
        return;
      }
      pushEvent(state, {
        time: state.time, kind: 'pass_complete', team, playerId: fl.kickerId, targetId: taker.id,
        pos: { x: taker.pos.x, y: taker.pos.y }, value: fl.expectedP,
      });
      if (state.fields) {
        const threat = team === 'A' ? state.fields.threatA : state.fields.threatB;
        state.stats[team].threatCreated += threat.sample(taker.pos) - threat.sample(fl.origin);
      }
    } else {
      pushEvent(state, {
        time: state.time, kind: 'pass_intercepted', team, playerId: taker.id, targetId: fl.kickerId,
        pos: { x: taker.pos.x, y: taker.pos.y }, value: fl.expectedP,
      });
    }
  }
  changePossession(state, team, true, taker.pos, ev.lastTouchId ?? undefined);
}

/** Hors-jeu sifflé à la réception : coup franc indirect pour l'adversaire au point de la faute. */
function whistleOffside(state: MatchState, receiver: Player, params: SimParams): void {
  const pos = { x: receiver.pos.x, y: receiver.pos.y };
  pushEvent(state, { time: state.time, kind: 'offside', team: receiver.team, playerId: receiver.id, pos });
  const opp = otherTeam(receiver.team);
  changePossession(state, opp, true, pos, receiver.id);
  const taker = nearestPlayer(state, pos, opp) ?? nearestPlayer(state, pos, undefined, receiver.id);
  restartWith(state, { kind: 'free_kick', team: opp, pos, resumeAt: 0 }, taker, params.physics.restartFreeze);
}

/** Met en place une remise en jeu : ballon (et remetteur) au point, gel jusqu'à `time + freeze`. */
function restartWith(state: MatchState, restart: Restart, taker: Player | undefined, freeze: number): void {
  const pos: Vec2 = {
    x: clamp(restart.pos.x, -PITCH.halfLength + RESTART_MARGIN, PITCH.halfLength - RESTART_MARGIN),
    y: clamp(restart.pos.y, -PITCH.halfWidth + RESTART_MARGIN, PITCH.halfWidth - RESTART_MARGIN),
  };
  const ball = state.ball;
  if (taker) {
    taker.pos = { x: pos.x, y: pos.y };
    taker.vel = { x: 0, y: 0 };
    taker.target = null;
    taker.targetSpeed = 0;
    giveBall(state, taker.id);
  } else {
    ball.pos = { x: pos.x, y: pos.y };
    ball.vel = { x: 0, y: 0 };
    ball.z = 0;
    ball.vz = 0;
    ball.ownerId = null;
    ball.flight = null;
  }
  state.restart = { ...restart, pos, resumeAt: state.time + freeze };
  pushEvent(state, { time: state.time, kind: 'restart', team: restart.team, playerId: taker?.id, pos: { ...pos }, label: restartLabel(state.restart, taker) });
}

function restartLabel(r: Restart, taker: Player | undefined): string {
  const kinds: Record<Restart['kind'], string> = {
    kickoff: 'Coup d’envoi', goal_kick: 'Sortie de but', throw_in: 'Touche', corner: 'Corner', free_kick: 'Coup franc',
  };
  return `${kinds[r.kind]} pour l'${teamLabel(r.team)}${taker ? ` (${taker.name})` : ''}`;
}

/** Fin d'un gel : replacement des joueurs pour un coup d'envoi après but, puis reprise. */
function resumeRestart(state: MatchState, config: MatchConfig): void {
  const r = state.restart!;
  if (r.resetOnResume) setupKickoff(state, r.team, config);
  state.restart = null;
}

/** Tir en cours : contre par un défenseur de champ au départ, arrêt du gardien (issue tirée à la frappe). */
function resolveShot(state: MatchState, params: SimParams, rng: Rng): void {
  const ball = state.ball;
  const fl = ball.flight;
  if (!fl || fl.kind !== 'shot') return;
  const ph = params.physics;
  const shooter = playerById(state, fl.kickerId);
  const attacking: TeamId = shooter ? shooter.team : ball.vel.x >= 0 ? 'A' : 'B';
  const defending = otherTeam(attacking);
  const dir = attackDir(attacking);
  const elapsed = state.time - fl.startTime;
  const total = dist(fl.origin, fl.targetPoint) / Math.max(1, fl.initialSpeed);

  // Contre (rare) : défenseur de champ à moins de blockRadius du trajet parcouru ce tick, en début de vol
  if (elapsed <= ph.blockWindow * total && ball.z < BLOCK_MAX_HEIGHT) {
    const prev: Vec2 = { x: ball.pos.x - ball.vel.x * ph.dt, y: ball.pos.y - ball.vel.y * ph.dt };
    for (const d of state.players) {
      if (d.team !== defending || d.role === 'GK') continue;
      if (distToSegment(d.pos, prev, ball.pos) < ph.blockRadius) {
        blockShot(state, d, fl, attacking, rng);
        return;
      }
    }
  }

  if (fl.outcome !== 'save') return;
  const keeper = keeperOf(state, defending);
  if (!keeper) { fl.outcome = 'miss'; return; }
  const reached = dist(ball.pos, keeper.pos) < ph.keeperSaveRadius || (ball.pos.x - keeper.pos.x) * dir >= 0;
  if (!reached) return;
  pushEvent(state, {
    time: state.time, kind: 'save', team: defending, playerId: keeper.id, targetId: shooter?.id,
    pos: { x: keeper.pos.x, y: keeper.pos.y }, value: fl.expectedP,
  });
  if (rng.bernoulli(1 - ph.saveCornerProb)) {
    changePossession(state, defending, false, keeper.pos);
    giveBall(state, keeper.id);
  } else {
    // Déviation derrière la ligne de but (dernier toucheur : le gardien ⇒ corner)
    ball.lastTouchId = keeper.id;
    ball.flight = null;
    ball.pos = { x: dir * (PITCH.halfLength + DEFLECTION_BEHIND), y: (ball.pos.y >= 0 ? 1 : -1) * (PITCH.goalHalfWidth + 2) };
    ball.vel = { x: 0, y: 0 };
    ball.z = 0;
    ball.vz = 0;
  }
}

/** Tir contré : le ballon devient libre, l'issue tirée est annulée (le tir n'est plus cadré). */
function blockShot(state: MatchState, blocker: Player, fl: BallFlight, attacking: TeamId, rng: Rng): void {
  const ball = state.ball;
  const sp = Math.hypot(ball.vel.x, ball.vel.y) || 1;
  const px = -ball.vel.y / sp, py = ball.vel.x / sp;
  const lateral = rng.uniform(-BLOCK_LATERAL, BLOCK_LATERAL);
  ball.vel = { x: -ball.vel.x * BLOCK_REBOUND + px * lateral, y: -ball.vel.y * BLOCK_REBOUND + py * lateral };
  ball.z = 0;
  ball.vz = 0;
  ball.lastTouchId = blocker.id;
  ball.flight = {
    kind: 'loose', kickerId: blocker.id, targetId: null, targetPoint: { ...ball.pos }, origin: { ...ball.pos },
    startTime: state.time, initialSpeed: Math.hypot(ball.vel.x, ball.vel.y),
  };
  if (fl.outcome !== 'miss') state.stats[attacking].shotsOnTarget = Math.max(0, state.stats[attacking].shotsOnTarget - 1);
  fl.outcome = 'miss';
  fl.onTarget = false;
  pushEvent(state, {
    time: state.time, kind: 'tackle', team: blocker.team, playerId: blocker.id, targetId: fl.kickerId,
    pos: { x: ball.pos.x, y: ball.pos.y }, label: `Tir de ${playerLabel(state, fl.kickerId)} contré par ${blocker.name}`,
  });
}

/** Buts et sorties (§3.4). Le ballon conduit compte aussi (avec une tolérance). */
function checkBallOut(state: MatchState, params: SimParams, rng: Rng): void {
  const ball = state.ball;
  const b = ball.pos;
  const owned = ball.ownerId !== null;
  const tol = owned ? OWNED_OUT_TOLERANCE : 0;
  const H = PITCH.halfLength, W = PITCH.halfWidth;
  if (Math.abs(b.x) > H + tol) {
    const side: AttackDir = b.x > 0 ? 1 : -1;
    const attacking: TeamId = side === 1 ? 'A' : 'B';
    const defending = otherTeam(attacking);
    // Point de franchissement de la ligne (interpolation le long de la vitesse)
    let yCross = b.y, zCross = ball.z;
    if (!owned && Math.abs(ball.vel.x) > 1e-6) {
      const back = (b.x - side * H) / ball.vel.x;
      yCross = b.y - ball.vel.y * back;
      zCross = Math.max(0, ball.z - ball.vz * back);
    }
    if (Math.abs(yCross) < PITCH.goalHalfWidth && zCross < PITCH.goalHeight) {
      scoreGoal(state, attacking, params);
      return;
    }
    const lastTouch = ball.lastTouchId !== null ? playerById(state, ball.lastTouchId) : undefined;
    const lastTeam: TeamId = lastTouch ? lastTouch.team : defending;
    endFlightOut(state, lastTouch);
    if (lastTeam === attacking) {
      const spot: Vec2 = { x: side * GOAL_KICK_X, y: 0 };
      const taker = keeperOf(state, defending) ?? nearestPlayer(state, spot, defending) ?? nearestPlayer(state, spot);
      changePossession(state, defending, false, spot);
      restartWith(state, { kind: 'goal_kick', team: defending, pos: spot, resumeAt: 0 }, taker, params.physics.restartFreeze);
    } else {
      const spot: Vec2 = { x: side * H, y: (b.y >= 0 ? 1 : -1) * W };
      const taker = nearestPlayer(state, spot, attacking) ?? nearestPlayer(state, spot);
      changePossession(state, attacking, false, spot);
      restartWith(state, { kind: 'corner', team: attacking, pos: spot, resumeAt: 0 }, taker, params.physics.restartFreeze);
    }
    return;
  }
  if (Math.abs(b.y) > W + tol) {
    const lastTouch = ball.lastTouchId !== null ? playerById(state, ball.lastTouchId) : undefined;
    const lastTeam: TeamId = lastTouch ? lastTouch.team : state.possession ?? 'A';
    const team = otherTeam(lastTeam);
    const spot: Vec2 = { x: clamp(b.x, -H + 1, H - 1), y: (b.y > 0 ? 1 : -1) * W };
    endFlightOut(state, lastTouch);
    const taker = nearestPlayer(state, spot, team) ?? nearestPlayer(state, spot);
    changePossession(state, team, false, spot);
    restartWith(state, { kind: 'throw_in', team, pos: spot, resumeAt: 0 }, taker, params.physics.restartFreeze);
  }
  void rng;
}

/** Journalise la sortie et l'échec de la passe éventuelle en cours. */
function endFlightOut(state: MatchState, lastTouch: Player | undefined): void {
  const ball = state.ball;
  const fl = ball.flight;
  if (fl && isPassKind(fl.kind)) {
    const kicker = playerById(state, fl.kickerId);
    if (kicker) pushEvent(state, { time: state.time, kind: 'pass_failed', team: kicker.team, playerId: kicker.id, targetId: fl.targetId ?? undefined, pos: { ...ball.pos }, value: fl.expectedP });
  }
  if (lastTouch) failDribble(state, lastTouch);
  pushEvent(state, { time: state.time, kind: 'out', team: lastTouch ? lastTouch.team : state.possession ?? 'A', playerId: lastTouch?.id, pos: { ...ball.pos } });
  ball.flight = null;
}

/** But : score, événement, coup d'envoi pour l'équipe encaissante (retour aux postes pendant le gel). */
function scoreGoal(state: MatchState, team: TeamId, params: SimParams): void {
  const ball = state.ball;
  state.score[team]++;
  const last = ball.lastTouchId !== null ? playerById(state, ball.lastTouchId) : undefined;
  const ownGoal = last !== undefined && last.team !== team;
  pushEvent(state, {
    time: state.time, kind: 'goal', team, playerId: last && !ownGoal ? last.id : undefined, pos: { ...ball.pos },
    value: ball.flight?.kind === 'shot' ? ball.flight.expectedP : undefined,
    label: ownGoal && last ? `But contre son camp de ${last.name}` : undefined,
  });
  const conceding = otherTeam(team);
  const positions = kickoffPositions(state, conceding);
  for (const p of state.players) {
    const q = positions.get(p.id);
    p.target = q ? { x: q.x, y: q.y } : null;
    p.targetSpeed = p.maxSpeed;
    p.beatenUntil = undefined;
    p.lastDribbleStart = undefined;
    p.lastDuelTime = undefined;
  }
  ball.pos = { x: 0, y: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  ball.ownerId = null;
  ball.lastTouchId = null;
  ball.flight = null;
  changePossession(state, conceding, false, { x: 0, y: 0 });
  state.phase[conceding] = 'attack';
  state.phase[team] = 'defence';
  state.phaseSince[conceding] = state.time;
  state.phaseSince[team] = state.time;
  state.restart = { kind: 'kickoff', team: conceding, pos: { x: 0, y: 0 }, resumeAt: state.time + params.physics.goalFreeze, resetOnResume: true };
  state.lastKickoff = conceding;
  pushEvent(state, { time: state.time, kind: 'restart', team: conceding, pos: { x: 0, y: 0 }, label: `Coup d’envoi pour l'${teamLabel(conceding)}` });
}

/** Trajectoire terminée sans prise de balle (ballon arrêté) : passe manquée. */
function checkFlightEnded(state: MatchState): void {
  const ball = state.ball;
  const fl = ball.flight;
  if (!fl) return;
  if (ball.z > 0 || ball.vz !== 0 || ball.vel.x !== 0 || ball.vel.y !== 0) return;
  if (isPassKind(fl.kind)) {
    const kicker = playerById(state, fl.kickerId);
    if (kicker) pushEvent(state, { time: state.time, kind: 'pass_failed', team: kicker.team, playerId: kicker.id, targetId: fl.targetId ?? undefined, pos: { ...ball.pos }, value: fl.expectedP });
  }
  ball.flight = null;
}

/** Dribble raté (perte du ballon avant `dribbleWonDelay`). */
function failDribble(state: MatchState, p: Player): void {
  if (p.lastDribbleStart === undefined) return;
  p.lastDribbleStart = undefined;
  pushEvent(state, { time: state.time, kind: 'dribble_failed', team: p.team, playerId: p.id, pos: { x: p.pos.x, y: p.pos.y } });
}

/** Dribble réussi si le dribbleur possède encore le ballon `dribbleWonDelay` s après le départ. */
function updateDribbles(state: MatchState, ph: SimParams['physics']): void {
  const ball = state.ball;
  for (const p of state.players) {
    if (p.lastDribbleStart === undefined) continue;
    if (ball.ownerId === p.id) {
      if (state.time - p.lastDribbleStart >= ph.dribbleWonDelay) {
        state.stats[p.team].dribblesWon++;
        p.lastDribbleStart = undefined;
      }
    } else if (p.lastKickTime >= p.lastDribbleStart) {
      p.lastDribbleStart = undefined; // passe ou tir : le dribble n'est ni gagné ni perdu
    } else {
      failDribble(state, p);
    }
  }
}

// ---------------------------------------------------------------------------
// Phases de jeu
// ---------------------------------------------------------------------------

/**
 * Met à jour les phases : l'équipe qui récupère passe en `transition_attack` pendant `transitionWindow` s puis
 * `attack` ; celle qui perd en `transition_defence` puis `defence`. Un ballon libre conserve les phases.
 */
export function updatePhases(state: MatchState, config: MatchConfig): void {
  if (!state.possession) return;
  const window = config.params.transitionWindow;
  const t = state.time;
  const elapsed = t - state.possessionSince;
  for (const team of TEAMS) {
    const has = state.possession === team;
    const phase = state.phase[team];
    let next = phase;
    if (has) {
      if (phase === 'attack') next = 'attack';
      else if (phase === 'transition_attack') next = elapsed >= window ? 'attack' : phase;
      else next = 'transition_attack';
    } else {
      if (phase === 'defence') next = 'defence';
      else if (phase === 'transition_defence') next = elapsed >= window ? 'defence' : phase;
      else next = 'transition_defence';
    }
    if (next !== phase) {
      state.phase[team] = next;
      state.phaseSince[team] = t;
    }
  }
}
