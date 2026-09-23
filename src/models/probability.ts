/**
 * Modèles probabilistes de réussite des actions (logistiques sur des caractéristiques physiques).
 * Chaque fonction retourne la probabilité ET les caractéristiques nommées (pour l'explication).
 */
import type { Vec2 } from '../core/vec2';
import type { FieldSet, MatchState, ScoreComponent, SimParams } from '../core/types';
import type { InterceptionAnalysis } from './interception';

export interface ProbabilityResult {
  p: number;
  /** Caractéristiques nommées ayant servi au calcul (valeur brute + contribution au logit). */
  features: ScoreComponent[];
  interception?: InterceptionAnalysis;
}

/** Passe dans les pieds de `receiverId` (ou vers `targetPoint` si fourni : passe « devant »). */
export function passProbability(state: MatchState, fields: FieldSet, passerId: number, receiverId: number, targetPoint: Vec2, params: SimParams): ProbabilityResult {
  throw new Error('non implémenté');
}

/** Passe en profondeur vers le point `targetPoint`, destinée à `receiverId` (course). Inclut le hors-jeu. */
export function throughBallProbability(state: MatchState, fields: FieldSet, passerId: number, receiverId: number, targetPoint: Vec2, params: SimParams): ProbabilityResult {
  throw new Error('non implémenté');
}

/** Dribble du porteur `playerId` vers `targetPoint`. */
export function dribbleProbability(state: MatchState, fields: FieldSet, playerId: number, targetPoint: Vec2, params: SimParams): ProbabilityResult {
  throw new Error('non implémenté');
}

/** Tir de `shooterId` vers `aimPoint` (sur la ligne de but) : xG avec gardien et contreurs. */
export function shotProbability(state: MatchState, fields: FieldSet, shooterId: number, aimPoint: Vec2, params: SimParams): ProbabilityResult {
  throw new Error('non implémenté');
}

/** Conservation du ballon pendant un cycle de décision. */
export function holdProbability(state: MatchState, fields: FieldSet, playerId: number, params: SimParams): ProbabilityResult {
  throw new Error('non implémenté');
}
