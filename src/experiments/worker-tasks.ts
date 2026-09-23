/**
 * Tâches exécutables dans un worker (entrées et sorties sérialisables).
 */
import { runMatchTask, runScenario, type MatchTask, type MatchResult, type ScenarioRunResult } from './runner';
import { resolvePolicy } from './cli';
import { SCENARIO_BY_ID, type Scenario } from './scenarios';
import { generateScenarios } from './scenario-generator';

export interface ScenarioTask {
  /** Identifiant d'un scénario de la bibliothèque, ou description d'un scénario généré. */
  scenarioId: string;
  generated?: { seed: number; index: number; noise?: number };
  policy: string;
  seed: number;
  horizonSec: number;
}

/** Retrouve le scénario désigné par une tâche (bibliothèque ou générateur). */
export function resolveScenario(task: ScenarioTask): Scenario {
  if (task.generated) {
    const list = generateScenarios(task.generated.seed, task.generated.index + 1, { noise: task.generated.noise });
    return list[task.generated.index];
  }
  const s = SCENARIO_BY_ID[task.scenarioId];
  if (!s) throw new Error(`scénario inconnu : ${task.scenarioId}`);
  return s;
}

export function runScenarioTask(task: ScenarioTask): ScenarioRunResult {
  const scenario = resolveScenario(task);
  const r = runScenario(scenario, resolvePolicy(task.policy), task.seed, task.horizonSec);
  // On allège la décision (les candidats complets ne sont pas nécessaires côté agrégation).
  if (r.decision) r.decision = { ...r.decision, candidates: r.decision.candidates.slice(0, 5) };
  return r;
}

export const WORKER_TASKS = {
  match: (t: MatchTask): MatchResult => runMatchTask(t),
  scenario: (t: ScenarioTask): ScenarioRunResult => runScenarioTask(t),
};

export type WorkerTaskName = keyof typeof WORKER_TASKS;
