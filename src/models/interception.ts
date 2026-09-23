/**
 * Géométrie et probabilité d'interception d'une trajectoire de balle.
 */
import type { Vec2 } from '../core/vec2';
import type { BallFlightKind, MatchState, SimParams, TeamId } from '../core/types';

export interface InterceptionSample {
  point: Vec2;
  ballTime: number;
  /** Meilleur adversaire (id) et son temps d'arrivée. */
  opponentId: number;
  opponentTime: number;
  /** Probabilité d'arrivée à temps de cet adversaire (sigmoïde de la différence de temps). */
  phi: number;
}

export interface InterceptionAnalysis {
  /** Probabilité globale d'interception sur la trajectoire. */
  pIntercept: number;
  samples: InterceptionSample[];
  /** Adversaires dont φ ≥ 0,2 sur au moins un échantillon (pour la visualisation). */
  threats: number[];
  /** Vitesse initiale utilisée et temps de trajet total. */
  initialSpeed: number;
  travelTime: number;
}

/**
 * Analyse d'interception d'une passe de `from` vers `to` jouée par `team`
 * (les adversaires de `team` tentent d'intercepter).
 */
export function analyseInterception(state: MatchState, from: Vec2, to: Vec2, kind: BallFlightKind, team: TeamId, params: SimParams, arrivalSpeed?: number): InterceptionAnalysis {
  throw new Error('non implémenté');
}

/** Qualité géométrique d'une ligne de passe : distance minimale d'un adversaire au segment (m), pondérée par l'angle. */
export function passingLaneQuality(state: MatchState, from: Vec2, to: Vec2, team: TeamId): number {
  throw new Error('non implémenté');
}
