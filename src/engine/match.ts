/**
 * Création et réinitialisation d'un match : joueurs, formations, coup d'envoi, postes instanciés (§9.2),
 * copie profonde de l'état, attribution du ballon.
 */
import type { Formation, MatchConfig, MatchState, TeamId, Player, PlayerAttributes, Role } from '../core/types';
import { TEAMS, attackDir, otherTeam } from '../core/types';
import type { Vec2 } from '../core/vec2';
import { clamp } from '../core/vec2';
import type { Rng } from '../core/rng';
import { PITCH, toTeamFrame, fromTeamFrame, isInsidePitch } from '../core/pitch';
import { FORMATIONS } from '../tactics/formations';
import { emptyStats, effectiveMaxSpeed, effectiveMaxAccel } from '../core/state-builder';
import { playerById } from './helpers';

/** Attributs ~ N(0,5 ; 0,1) bornés à [0,2 ; 0,9] ; gardiens : goalkeeping = 0,8. */
const ATTR_MEAN = 0.5;
const ATTR_SD = 0.1;
const ATTR_MIN = 0.2;
const ATTR_MAX = 0.9;
const GK_GOALKEEPING = 0.8;
/** Coup d'envoi : chaque joueur est ramené dans son camp (x' ≤ −2 m dans le repère équipe). */
const KICKOFF_HALF_MARGIN = 2;
/** Second attaquant au coup d'envoi (repère équipe). */
const KICKOFF_SECOND: Vec2 = { x: -1, y: 3 };
/** Marge (m) à l'intérieur du terrain pour les postes instanciés. */
const SLOT_MARGIN = 1;
/** Contraction du bloc vers le ballon en défense : facteur 1 − 0,35·compacité sur l'écart poste − ballon. */
const COMPACTNESS_GAIN = 0.35;
/** Un défenseur n'est jamais maintenu plus de 3 m devant le ballon par la ligne défensive. */
const LINE_BALL_MARGIN = 3;

function drawAttributes(rng: Rng, role: Role): PlayerAttributes {
  const draw = (): number => clamp(rng.normal(ATTR_MEAN, ATTR_SD), ATTR_MIN, ATTR_MAX);
  const attrs: PlayerAttributes = {
    pace: draw(), acceleration: draw(), passing: draw(), shooting: draw(), dribbling: draw(), defending: draw(), goalkeeping: draw(),
  };
  if (role === 'GK') attrs.goalkeeping = GK_GOALKEEPING;
  return attrs;
}

/** Construit l'état initial (coup d'envoi pour l'équipe A) à partir de la configuration. */
export function createMatch(config: MatchConfig, rng: Rng): MatchState {
  const players: Player[] = [];
  const physics = config.params.physics;
  for (const team of TEAMS) {
    const dir = attackDir(team);
    const formation = FORMATIONS[config.tactics[team].formation];
    formation.slots.forEach((slot, i) => {
      const id = team === 'A' ? i : 11 + i;
      const attrs = drawAttributes(rng, slot.role);
      players.push({
        id,
        team,
        number: i + 1,
        name: `${team}${i + 1}`,
        role: slot.role,
        slotIndex: i,
        attrs,
        pos: fromTeamFrame({ x: slot.x, y: slot.y }, dir),
        vel: { x: 0, y: 0 },
        maxSpeed: effectiveMaxSpeed(attrs, physics.playerMaxSpeed),
        maxAccel: effectiveMaxAccel(attrs, physics.playerMaxAccel),
        target: null,
        targetSpeed: 0,
        decision: null,
        lastDecisionTime: -1,
        lastKickTime: -10,
      });
    });
  }
  const state: MatchState = {
    time: 0,
    tick: 0,
    players,
    ball: { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, ownerId: null, lastTouchId: null, flight: null },
    possession: 'A',
    possessionSince: 0,
    phase: { A: 'attack', B: 'defence' },
    phaseSince: { A: 0, B: 0 },
    score: { A: 0, B: 0 },
    restart: null,
    tactics: { A: { ...config.tactics.A }, B: { ...config.tactics.B } },
    stats: emptyStats(),
    events: [],
    fields: null,
    lastKickoff: 'A',
  };
  setupKickoff(state, 'A', config);
  return state;
}

/** Ordre de priorité pour engager : attaquants d'abord, puis les plus axiaux, puis les plus avancés. */
function kickoffTakers(members: Player[], formation: Formation): [Player | undefined, Player | undefined] {
  const roleRank: Record<Role, number> = { FW: 0, MF: 1, DF: 2, GK: 3 };
  const key = (p: Player): [number, number, number] => {
    const s = formation.slots[p.slotIndex];
    return [roleRank[p.role], s ? Math.abs(s.y) : 99, s ? -s.x : 0];
  };
  const sorted = [...members].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.id - b.id;
  });
  return [sorted[0], sorted[1]];
}

/**
 * Positions de coup d'envoi (repère terrain) de tous les joueurs quand `kickingTeam` engage :
 * chaque poste ramené dans son camp, l'attaquant central au point central, un second attaquant à ses côtés.
 */
export function kickoffPositions(state: MatchState, kickingTeam: TeamId): Map<number, Vec2> {
  const out = new Map<number, Vec2>();
  for (const team of TEAMS) {
    const dir = attackDir(team);
    const formation = FORMATIONS[state.tactics[team].formation];
    const members = state.players.filter((p) => p.team === team);
    for (const p of members) {
      const slot = formation.slots[p.slotIndex] ?? formation.slots[Math.min(p.slotIndex, formation.slots.length - 1)];
      out.set(p.id, fromTeamFrame({ x: Math.min(slot.x, -KICKOFF_HALF_MARGIN), y: slot.y }, dir));
    }
    if (team === kickingTeam) {
      const [striker, second] = kickoffTakers(members, formation);
      if (striker) out.set(striker.id, { x: 0, y: 0 });
      if (second) out.set(second.id, fromTeamFrame(KICKOFF_SECOND, dir));
    }
  }
  return out;
}

/** Replace les 22 joueurs et le ballon pour un coup d'envoi de `team` (score et temps conservés). */
export function setupKickoff(state: MatchState, team: TeamId, config: MatchConfig): void {
  const positions = kickoffPositions(state, team);
  for (const p of state.players) {
    const q = positions.get(p.id);
    if (q) p.pos = { x: q.x, y: q.y };
    p.vel = { x: 0, y: 0 };
    p.target = null;
    p.targetSpeed = 0;
    p.beatenUntil = undefined;
    p.lastDribbleStart = undefined;
    p.lastDuelTime = undefined;
  }
  const [striker] = kickoffTakers(state.players.filter((p) => p.team === team), FORMATIONS[state.tactics[team].formation]);
  const ball = state.ball;
  ball.pos = { x: 0, y: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  ball.ownerId = striker ? striker.id : null;
  ball.lastTouchId = ball.ownerId;
  ball.flight = null;
  state.possession = team;
  state.possessionSince = state.time;
  state.phase[team] = 'attack';
  state.phase[otherTeam(team)] = 'defence';
  state.phaseSince[team] = state.time;
  state.phaseSince[otherTeam(team)] = state.time;
  state.restart = { kind: 'kickoff', team, pos: { x: 0, y: 0 }, resumeAt: state.time + config.params.physics.kickoffFreeze };
  state.lastKickoff = team;
}

/**
 * Position de référence (repère terrain) du poste d'un joueur, ajustée au ballon et à la tactique (§9.2) :
 * poste + (followX·Δx, followY·Δy) dans le repère équipe, largeur y·(0,7 + 0,6·widthUsage) ; en phase défensive,
 * contraction du bloc vers le ballon (1 − 0,35·compactness) et ligne défensive comme plancher pour les défenseurs.
 */
export function slotPosition(state: MatchState, player: Player, ballPos?: Vec2): Vec2 {
  const team = player.team;
  const dir = attackDir(team);
  const tactic = state.tactics[team].params;
  const formation = FORMATIONS[state.tactics[team].formation];
  const slot = formation.slots[player.slotIndex];
  if (!slot) return { x: player.pos.x, y: player.pos.y };
  const b = toTeamFrame(ballPos ?? state.ball.pos, dir);
  let x = slot.x + slot.followX * b.x;
  let y = slot.y * (0.7 + 0.6 * tactic.widthUsage) + slot.followY * b.y;
  const phase = state.phase[team];
  if ((phase === 'defence' || phase === 'transition_defence') && slot.role !== 'GK') {
    const k = 1 - COMPACTNESS_GAIN * tactic.compactness;
    x = b.x + (x - b.x) * k;
    y = b.y + (y - b.y) * k;
    if (slot.role === 'DF') x = Math.max(x, Math.min(tactic.defensiveLine, b.x - LINE_BALL_MARGIN));
  }
  x = clamp(x, -PITCH.halfLength + SLOT_MARGIN, PITCH.halfLength - SLOT_MARGIN);
  y = clamp(y, -PITCH.halfWidth + SLOT_MARGIN, PITCH.halfWidth - SLOT_MARGIN);
  return fromTeamFrame({ x, y }, dir);
}

/**
 * Copie profonde de l'état (utilisée par la recherche en avant et les scénarios).
 * Les champs spatiaux (`fields`, ScalarField immuables) et les décisions sont partagés par référence.
 */
export function cloneState(state: MatchState): MatchState {
  const flight = state.ball.flight;
  return {
    time: state.time,
    tick: state.tick,
    players: state.players.map((p) => ({
      ...p,
      attrs: { ...p.attrs },
      pos: { x: p.pos.x, y: p.pos.y },
      vel: { x: p.vel.x, y: p.vel.y },
      target: p.target ? { x: p.target.x, y: p.target.y } : null,
    })),
    ball: {
      ...state.ball,
      pos: { x: state.ball.pos.x, y: state.ball.pos.y },
      vel: { x: state.ball.vel.x, y: state.ball.vel.y },
      flight: flight ? { ...flight, targetPoint: { ...flight.targetPoint }, origin: { ...flight.origin } } : null,
    },
    possession: state.possession,
    possessionSince: state.possessionSince,
    phase: { ...state.phase },
    phaseSince: { ...state.phaseSince },
    score: { ...state.score },
    restart: state.restart ? { ...state.restart, pos: { ...state.restart.pos } } : null,
    tactics: {
      A: { ...state.tactics.A, params: { ...state.tactics.A.params } },
      B: { ...state.tactics.B, params: { ...state.tactics.B.params } },
    },
    stats: { A: { ...state.stats.A }, B: { ...state.stats.B } },
    events: state.events.map((e) => ({ ...e, pos: e.pos ? { ...e.pos } : undefined })),
    fields: state.fields,
    lastKickoff: state.lastKickoff,
  };
}

/**
 * Donne le ballon à un joueur : ballon dans ses pieds, possession mise à jour, trajectoire annulée.
 * Avec `placeOthers`, les autres joueurs sont replacés sur leurs postes instanciés (scénarios).
 */
export function giveBall(state: MatchState, playerId: number, placeOthers = false): void {
  const p = playerById(state, playerId);
  if (!p) return;
  const ball = state.ball;
  if (!isInsidePitch(p.pos, -0.5)) {
    p.pos.x = clamp(p.pos.x, -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5);
    p.pos.y = clamp(p.pos.y, -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5);
  }
  ball.pos = { x: p.pos.x, y: p.pos.y };
  ball.vel = { x: p.vel.x, y: p.vel.y };
  ball.z = 0;
  ball.vz = 0;
  ball.ownerId = playerId;
  ball.lastTouchId = playerId;
  ball.flight = null;
  if (state.possession !== p.team) {
    state.possession = p.team;
    state.possessionSince = state.time;
  }
  if (placeOthers) {
    for (const q of state.players) {
      if (q.id === playerId) continue;
      q.pos = slotPosition(state, q);
      q.vel = { x: 0, y: 0 };
      q.target = null;
      q.targetSpeed = 0;
    }
  }
}
