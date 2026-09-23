/**
 * Exécution headless de matchs et de scénarios ; collecte des métriques.
 */
import type { MatchConfig, MatchStats, TeamId } from '../core/types';
import type { PolicySet } from '../decision/policy';

export interface MatchResult {
  seed: number;
  score: Record<TeamId, number>;
  stats: MatchStats;
  durationSec: number;
  wallMs: number;
}

export function runMatch(config: MatchConfig, policies?: Record<TeamId, PolicySet>): MatchResult {
  throw new Error('non implémenté');
}
