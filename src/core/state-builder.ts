/**
 * Constructeur d'états de match « à la main » pour les tests unitaires et la bibliothèque de scénarios.
 * (Le moteur possède sa propre création de match complète : src/engine/match.ts.)
 */
import type { Ball, FieldSet, MatchState, MatchStats, Player, PlayerAttributes, Role, TacticConfig, TeamId, TeamStats } from './types';
import { ScalarField } from './grid';
import { attackDir } from './types';
import type { Vec2 } from './vec2';
import { FORMATIONS } from '../tactics/formations';
import { makeTactic } from '../tactics/styles';
import { DEFAULT_PARAMS } from './params';

export const DEFAULT_ATTRS: PlayerAttributes = {
  pace: 0.5, acceleration: 0.5, passing: 0.5, shooting: 0.5, dribbling: 0.5, defending: 0.5, goalkeeping: 0.5,
};

export const emptyTeamStats = (): TeamStats => ({
  goals: 0, shots: 0, shotsOnTarget: 0, xG: 0, passes: 0, passesCompleted: 0, throughBalls: 0, dribbles: 0, dribblesWon: 0,
  tackles: 0, interceptions: 0, turnovers: 0, possessionTime: 0, threatCreated: 0, decisions: 0, decisionMs: 0, regret: 0,
});

export const emptyStats = (): MatchStats => ({ A: emptyTeamStats(), B: emptyTeamStats() });

export interface PlayerSpec {
  team: TeamId;
  pos: Vec2;
  vel?: Vec2;
  role?: Role;
  number?: number;
  slotIndex?: number;
  attrs?: Partial<PlayerAttributes>;
}

/** Vitesse max et accélération effectives à partir des attributs (mêmes formules que le moteur). */
export const effectiveMaxSpeed = (attrs: PlayerAttributes, base = DEFAULT_PARAMS.physics.playerMaxSpeed): number => base * (0.85 + 0.3 * attrs.pace);
export const effectiveMaxAccel = (attrs: PlayerAttributes, base = DEFAULT_PARAMS.physics.playerMaxAccel): number => base * (0.85 + 0.3 * attrs.acceleration);

export function makePlayer(id: number, spec: PlayerSpec): Player {
  const attrs = { ...DEFAULT_ATTRS, ...(spec.attrs ?? {}) };
  const number = spec.number ?? (id % 11) + 1;
  return {
    id,
    team: spec.team,
    number,
    name: `${spec.team}${number}`,
    role: spec.role ?? (number === 1 ? 'GK' : 'MF'),
    slotIndex: spec.slotIndex ?? id % 11,
    attrs,
    pos: { ...spec.pos },
    vel: spec.vel ? { ...spec.vel } : { x: 0, y: 0 },
    maxSpeed: effectiveMaxSpeed(attrs),
    maxAccel: effectiveMaxAccel(attrs),
    target: null,
    targetSpeed: 0,
    decision: null,
    lastDecisionTime: -1,
    lastKickTime: -10,
  };
}

export const makeBall = (pos: Vec2, ownerId: number | null = null): Ball => ({
  pos: { ...pos }, vel: { x: 0, y: 0 }, z: 0, vz: 0, ownerId, lastTouchId: ownerId, flight: null,
});

export interface StateSpec {
  players: PlayerSpec[];
  ball?: { pos: Vec2; ownerId?: number | null };
  tactics?: Partial<Record<TeamId, TacticConfig>>;
  possession?: TeamId | null;
  time?: number;
}

/**
 * Construit un état à partir d'une liste de joueurs (ordre = identifiants 0..n−1).
 * Pour un état complet à 22 joueurs, utiliser `buildFullState`.
 */
export function buildState(spec: StateSpec): MatchState {
  const players = spec.players.map((p, i) => makePlayer(i, p));
  const ownerId = spec.ball?.ownerId ?? null;
  const ballPos = spec.ball?.pos ?? (ownerId !== null ? players[ownerId].pos : { x: 0, y: 0 });
  const tacticA = spec.tactics?.A ?? makeTactic('4-3-3', 'balanced');
  const tacticB = spec.tactics?.B ?? makeTactic('4-3-3', 'balanced');
  const possession = spec.possession ?? (ownerId !== null ? players[ownerId].team : null);
  return {
    time: spec.time ?? 0,
    tick: 0,
    players,
    ball: makeBall(ballPos, ownerId),
    possession,
    possessionSince: 0,
    phase: { A: possession === 'A' ? 'attack' : 'defence', B: possession === 'B' ? 'attack' : 'defence' },
    phaseSince: { A: 0, B: 0 },
    score: { A: 0, B: 0 },
    restart: null,
    tactics: { A: tacticA, B: tacticB },
    stats: emptyStats(),
    events: [],
    fields: null,
    lastKickoff: 'A',
  };
}

/**
 * État complet 11 contre 11 : les joueurs sont placés sur les positions de référence de leur formation
 * (repère terrain), avec une compression vers le ballon optionnelle. Ids : A = 0..10, B = 11..21.
 */
export function buildFullState(options: {
  tactics?: Partial<Record<TeamId, TacticConfig>>;
  ballPos?: Vec2;
  ownerId?: number | null;
  /** Décalage global des blocs (repère terrain) : permet de déplacer les équipes vers une zone. */
  shift?: Partial<Record<TeamId, Vec2>>;
  overrides?: Partial<Record<number, Partial<PlayerSpec>>>;
} = {}): MatchState {
  const tactics: Record<TeamId, TacticConfig> = {
    A: options.tactics?.A ?? makeTactic('4-3-3', 'balanced'),
    B: options.tactics?.B ?? makeTactic('4-4-2', 'balanced'),
  };
  const players: PlayerSpec[] = [];
  for (const team of ['A', 'B'] as TeamId[]) {
    const dir = attackDir(team);
    const formation = FORMATIONS[tactics[team].formation];
    const shift = options.shift?.[team] ?? { x: 0, y: 0 };
    formation.slots.forEach((slot, i) => {
      const id = team === 'A' ? i : 11 + i;
      const base: PlayerSpec = {
        team,
        pos: { x: dir * slot.x + shift.x, y: dir * slot.y + shift.y },
        role: slot.role,
        number: i + 1,
        slotIndex: i,
        attrs: slot.role === 'GK' ? { goalkeeping: 0.8 } : {},
      };
      players.push({ ...base, ...(options.overrides?.[id] ?? {}) });
    });
  }
  const state = buildState({ players, tactics, ball: { pos: options.ballPos ?? { x: 0, y: 0 }, ownerId: options.ownerId ?? null } });
  return state;
}

/** Champs vides (utile pour tester des fonctions qui exigent un FieldSet sans dépendre du calcul complet). */
export function emptyFields(time = 0): FieldSet {
  return {
    time,
    controlA: new ScalarField(DEFAULT_PARAMS.fieldCellSize).fill(() => 0.5),
    threatA: new ScalarField(DEFAULT_PARAMS.fieldCellSize),
    threatB: new ScalarField(DEFAULT_PARAMS.fieldCellSize),
    pressureByA: new ScalarField(DEFAULT_PARAMS.fieldCellSize),
    pressureByB: new ScalarField(DEFAULT_PARAMS.fieldCellSize),
  };
}
