/**
 * Interface des politiques de décision. L'algorithme complet et les baselines
 * (aléatoire, glouton, sans lookahead...) implémentent cette interface, ce qui permet
 * de les comparer dans le même moteur.
 */
import type { Decision, FieldSet, MatchState, SimParams, TacticConfig, TeamId } from '../core/types';
import type { Rng } from '../core/rng';

/**
 * Contexte du porteur, calculé UNE fois par cycle par le coordonnateur (§7.1, §15.3 « jeu figé ») et partagé par les
 * décisions sans ballon de son équipe : temps de possession continue, meilleure passe au sol (modèle rapide) et
 * multiplicateur d'urgence du soutien u ∈ [1, offBall.supportUrgencyMax].
 */
export interface CarrierContext {
  playerId: number;
  team: TeamId;
  /** Temps de possession continue du porteur (s), hors gel de remise en jeu. */
  heldFor: number;
  /** max_r P_pass(b → p_r) sur les coéquipiers de champ (modèle rapide `quickPassProbability`). */
  bestPassP: number;
  /** Urgence du soutien u = 1 + (u_max − 1)·max(f_t, f_P) (offball.ts, `supportUrgency`). */
  supportUrgency: number;
}

export interface DecisionInput {
  state: MatchState;
  fields: FieldSet;
  params: SimParams;
  tactic: TacticConfig;
  /** Générateur aléatoire à graine (réponse quantale / stratégies mixtes) — déterministe. */
  rng: Rng;
  /** (append-only, optionnel) Contexte du porteur de l'équipe en possession, calculé par le coordonnateur ; absent
   * (appel direct d'une politique, ballon libre, gardien porteur) ⇒ recalculé localement ou neutre (u = 1). */
  carrier?: CarrierContext | null;
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
