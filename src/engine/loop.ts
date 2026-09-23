/**
 * Boucle de simulation : décision (période params.decisionPeriod) → exécution → physique → règles.
 */
import type { MatchConfig, MatchState, Decision } from '../core/types';
import type { Rng } from '../core/rng';
import type { PolicySet } from '../decision/policy';

export interface StepOptions {
  /** Politiques de décision par équipe (par défaut : l'algorithme complet). */
  policies?: Record<'A' | 'B', PolicySet>;
  /** Appelé après chaque cycle de décision avec les décisions prises. */
  onDecisions?: (decisions: Map<number, Decision>, state: MatchState) => void;
}

export interface Simulation {
  state: MatchState;
  config: MatchConfig;
  rng: Rng;
  /** Avance d'un pas de physique (et lance un cycle de décision si nécessaire). */
  step(options?: StepOptions): void;
  /** Avance de `seconds` secondes. */
  advance(seconds: number, options?: StepOptions): void;
  /** Dernières décisions par joueur. */
  decisions: Map<number, Decision>;
}

export function createSimulation(config: MatchConfig): Simulation {
  throw new Error('non implémenté');
}
