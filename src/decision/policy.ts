/**
 * Interface des politiques de décision. L'algorithme complet et les baselines
 * (aléatoire, glouton, sans lookahead...) implémentent cette interface, ce qui permet
 * de les comparer dans le même moteur.
 */
import type { Decision, FieldSet, MatchState, SimParams, TacticConfig, TeamId } from '../core/types';
import type { Rng } from '../core/rng';

export interface DecisionInput {
  state: MatchState;
  fields: FieldSet;
  params: SimParams;
  tactic: TacticConfig;
  /** Générateur aléatoire à graine (réponse quantale / stratégies mixtes) — déterministe. */
  rng: Rng;
}

export interface PolicySet {
  name: string;
  /** Décision du porteur de balle. */
  onBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision;
  /** Décision d'un joueur sans ballon de l'équipe en possession (mouvement). */
  offBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision;
  /** Décisions coordonnées de l'équipe qui défend (10 joueurs de champ + gardien). */
  defence(input: DecisionInput, team: TeamId, previous: Map<number, Decision>): Map<number, Decision>;
}
