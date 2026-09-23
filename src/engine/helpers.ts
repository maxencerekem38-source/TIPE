/**
 * Utilitaires internes du moteur (src/engine) :
 *  - formules balistiques du ballon roulant (§3.2), implémentées localement pour que le moteur reste
 *    autonome et déterministe quel que soit l'état d'avancement de src/models ;
 *  - pont optionnel vers src/models (pression, hors-jeu, xG) : la fonction du modèle est utilisée si elle
 *    est implémentée, sinon un repli local simple est employé (décidé une fois, au premier appel) ;
 *  - accès aux joueurs (par identifiant, gardien, plus proche) et test de gel du jeu.
 */
import type { FieldSet, MatchState, Player, PhysicsParams, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import type { Vec2 } from '../core/vec2';
import { dist2 } from '../core/vec2';
import * as fieldsModel from '../models/fields';
import * as structureModel from '../models/structure';
import * as probabilityModel from '../models/probability';

// ---------------------------------------------------------------------------
// Ballon roulant (§3.2) : décélération constante μ = physics.ballFriction
// ---------------------------------------------------------------------------

/** Vitesse initiale s0 = min(s0max, √(2 μ d + s_arr²)) pour arriver à `distance` à la vitesse `arrivalSpeed`. */
export const launchSpeed = (distance: number, arrivalSpeed: number, physics: PhysicsParams): number =>
  Math.min(physics.passSpeedMax, Math.sqrt(2 * physics.ballFriction * Math.max(0, distance) + arrivalSpeed * arrivalSpeed));

/** Temps de trajet T_b(d) = (s0 − √(s0² − 2 μ d)) / μ, Infinity si la distance n'est pas atteignable. */
export const ballTravelTime = (distance: number, initialSpeed: number, physics: PhysicsParams): number => {
  const mu = physics.ballFriction;
  if (distance <= 0) return 0;
  if (mu <= 1e-9) return initialSpeed > 0 ? distance / initialSpeed : Infinity;
  const disc = initialSpeed * initialSpeed - 2 * mu * distance;
  if (disc < 0) return Infinity;
  return (initialSpeed - Math.sqrt(disc)) / mu;
};

/** Portée d'un ballon lancé à `initialSpeed` : s0² / (2 μ). */
export const ballStopDistance = (initialSpeed: number, physics: PhysicsParams): number =>
  physics.ballFriction <= 1e-9 ? Infinity : (initialSpeed * initialSpeed) / (2 * physics.ballFriction);

// ---------------------------------------------------------------------------
// Ballon aérien (lob, dégagement) : tir balistique à 45° partagé avec le modèle de décision
// ---------------------------------------------------------------------------
/** Gravité (m/s²). */
export const GRAVITY = 9.81;

/**
 * Cinématique d'un ballon aérien couvrant `distance` : tir à 45° (v₀ = √(g d), bornée à passSpeedMax),
 * composante horizontale hs = v₀/√2, durée T = d/hs, vitesse verticale vz = g·T/2 (portée exactement d).
 * Identique au `flightModel('lob')` de src/models/interception.ts : la décision et le moteur prévoient la même durée.
 * Apogée g·T²/8 = d/4 (7,5 m pour 30 m). Au-delà de passSpeedMax²/g (≈ 64 m) l'arc se redresse (vz > hs).
 */
export function lobKinematics(distance: number, physics: PhysicsParams): { hs: number; T: number; vz: number; initialSpeed: number } {
  const d = Math.max(0.1, distance);
  const s0 = Math.min(physics.passSpeedMax, Math.sqrt(GRAVITY * d));
  const hs = s0 / Math.SQRT2;
  const T = d / hs;
  const vz = (GRAVITY * T) / 2;
  return { hs, T, vz, initialSpeed: Math.hypot(hs, vz) };
}

// ---------------------------------------------------------------------------
// Pont optionnel vers src/models
// ---------------------------------------------------------------------------
const NOT_IMPLEMENTED = /non implémenté/;

/**
 * Enveloppe une fonction de src/models : si elle lève « non implémenté » au premier appel (ou n'existe pas),
 * le repli local est utilisé définitivement ; toute autre erreur est propagée (vrai bogue).
 */
export function optionalModel<A extends unknown[], R>(model: ((...args: A) => R) | undefined, fallback: (...args: A) => R): (...args: A) => R {
  let available: boolean | null = typeof model === 'function' ? null : false;
  return (...args: A): R => {
    if (available === false) return fallback(...args);
    try {
      const r = model!(...args);
      available = true;
      return r;
    } catch (e) {
      if (available === null && e instanceof Error && NOT_IMPLEMENTED.test(e.message)) {
        available = false;
        return fallback(...args);
      }
      throw e;
    }
  };
}

/** Rayon (m) dans lequel un adversaire compte pour la pression locale de repli. */
export const LOCAL_PRESSURE_RADIUS = 3;
/** Nombre maximal d'adversaires comptés dans la pression locale de repli. */
export const LOCAL_PRESSURE_CAP = 2;

/** Pression de repli : nombre d'adversaires de `team` à moins de 3 m de q, plafonné à 2. */
export function localPressure(state: MatchState, q: Vec2, team: TeamId, _params: SimParams): number {
  const r2 = LOCAL_PRESSURE_RADIUS * LOCAL_PRESSURE_RADIUS;
  let n = 0;
  for (const p of state.players) if (p.team !== team && dist2(p.pos, q) < r2) n++;
  return Math.min(LOCAL_PRESSURE_CAP, n);
}

/** Pression Π(q) exercée par les adversaires de `team` (modèle §4.4 si disponible, sinon repli local). */
export const pressureAt: (state: MatchState, q: Vec2, team: TeamId, params: SimParams) => number =
  optionalModel(fieldsModel.pressureAt, localPressure);

/**
 * Hors-jeu de repli (§3.4) : dans le repère de l'attaquant, q est hors-jeu si x' > 0, x' > x'_ballon
 * et x' > x' de l'avant-dernier adversaire (le dernier adversaire seul fait office de ligne s'il n'y en a qu'un).
 */
export function localIsOffside(state: MatchState, q: Vec2, attackingTeam: TeamId): boolean {
  const dir = attackDir(attackingTeam);
  const xr = dir * q.x;
  if (xr <= 0 || xr <= dir * state.ball.pos.x) return false;
  let first = -Infinity, second = -Infinity, n = 0;
  for (const p of state.players) {
    if (p.team === attackingTeam) continue;
    n++;
    const x = dir * p.pos.x;
    if (x > first) { second = first; first = x; } else if (x > second) second = x;
  }
  if (n === 0) return false;
  if (n === 1) second = first;
  return xr > second;
}

/** Position de hors-jeu (modèle src/models/structure si disponible, sinon repli local). */
export const isOffsidePosition: (state: MatchState, q: Vec2, attackingTeam: TeamId) => boolean =
  optionalModel(structureModel.isOffsidePosition, localIsOffside);

/** xG d'un tir via le modèle §5.4 si disponible et si les champs existent, sinon `defaultXG`. */
export const modelShotXG: (state: MatchState, fields: FieldSet, shooterId: number, aimPoint: Vec2, params: SimParams, defaultXG: number) => number =
  optionalModel(
    typeof probabilityModel.shotProbability === 'function'
      ? (state, fields, shooterId, aimPoint, params, _d) => probabilityModel.shotProbability(state, fields, shooterId, aimPoint, params).p
      : undefined,
    (_s, _f, _i, _a, _p, defaultXG) => defaultXG,
  );

// ---------------------------------------------------------------------------
// Accès aux joueurs
// ---------------------------------------------------------------------------

/** Joueur par identifiant (indexation directe si `players[id].id === id`, sinon recherche). */
export function playerById(state: MatchState, id: number): Player | undefined {
  const p = state.players[id];
  if (p && p.id === id) return p;
  return state.players.find((q) => q.id === id);
}

/** Gardien de `team` (undefined dans les états partiels de test). */
export function keeperOf(state: MatchState, team: TeamId): Player | undefined {
  for (const p of state.players) if (p.team === team && p.role === 'GK') return p;
  return undefined;
}

/** Joueur le plus proche de q (optionnellement restreint à `team`, en excluant `excludeId`). */
export function nearestPlayer(state: MatchState, q: Vec2, team?: TeamId, excludeId?: number): Player | undefined {
  let best: Player | undefined;
  let bestD = Infinity;
  for (const p of state.players) {
    if (team !== undefined && p.team !== team) continue;
    if (p.id === excludeId) continue;
    const d = dist2(p.pos, q);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * Joueur de champ de `team` le plus proche de q (le gardien seulement s'il n'y a personne d'autre) :
 * remetteur d'une touche, d'un corner ou d'un coup franc — le gardien n'est jamais téléporté loin de son but.
 */
export function nearestOutfield(state: MatchState, q: Vec2, team?: TeamId, excludeId?: number): Player | undefined {
  let best: Player | undefined;
  let bestD = Infinity;
  for (const p of state.players) {
    if (team !== undefined && p.team !== team) continue;
    if (p.id === excludeId || p.role === 'GK') continue;
    const d = dist2(p.pos, q);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ?? nearestPlayer(state, q, team, excludeId);
}

/** Adversaire de `team` le plus proche de q. */
export function nearestOpponent(state: MatchState, q: Vec2, team: TeamId): Player | undefined {
  let best: Player | undefined;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.team === team) continue;
    const d = dist2(p.pos, q);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Le jeu est-il gelé (remise en jeu en attente) ? */
export const isFrozen = (state: MatchState): boolean => state.restart !== null && state.time < state.restart.resumeAt - 1e-9;

/** Nom court d'un joueur pour les libellés (« A9 »). */
export const playerLabel = (state: MatchState, id: number | null | undefined): string => {
  if (id === null || id === undefined) return '?';
  const p = playerById(state, id);
  return p ? p.name : `#${id}`;
};

/** Libellé français d'une équipe. */
export const teamLabel = (team: TeamId): string => (team === 'A' ? 'équipe A' : 'équipe B');
