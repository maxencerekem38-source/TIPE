/**
 * Banc de performance (§12) : `npx tsx scripts/bench.ts [--states 100] [--minutes 5] [--seed 7]`
 * 1. latence de `decideAll` (cycle complet des 22 joueurs) sur `states` états générés : p50 / p95 / p99 ;
 * 2. temps de calcul d'un match complet de `minutes` minutes et facteur temps réel.
 */
import { parseArgs, numFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, makeConfig, isNotImplemented, formatDuration, resolvePolicy } from '../src/experiments/cli';
import { DEFAULT_PARAMS } from '../src/core/params';
import { Rng } from '../src/core/rng';
import * as coordinator from '../src/decision/coordinator';
import { buildGeneratedState } from '../src/experiments/scenario-generator';
import { runMatch } from '../src/experiments/runner';
import { latencyPercentiles, fmt } from '../src/experiments/metrics';
import { consoleTable } from '../src/experiments/report';
import type { Decision } from '../src/core/types';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nStates = numFlag(args, 'states', 100);
  const minutes = numFlag(args, 'minutes', 5);
  const seed = numFlag(args, 'seed', 7);
  console.log(`Banc de performance : ${nStates} états générés, puis un match de ${minutes} min (graine ${seed})`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  // 1. decideAll sur des états générés
  try {
    const policy = resolvePolicy('full');
    const policies = { A: policy, B: policy };
    const rng = new Rng(seed);
    const lat: number[] = [];
    let previous = new Map<number, Decision>();
    // Échauffement (JIT)
    for (let i = 0; i < 5; i++) coordinator.decideAll(buildGeneratedState(seed + 1000, i).state, DEFAULT_PARAMS, policies, new Map(), rng);
    for (let i = 0; i < nStates; i++) {
      const { state } = buildGeneratedState(seed, i);
      const t0 = performance.now();
      previous = coordinator.decideAll(state, DEFAULT_PARAMS, policies, previous, rng);
      lat.push(performance.now() - t0);
    }
    const p = latencyPercentiles(lat);
    console.log('\nLatence d’un cycle de décision complet (22 joueurs, champs inclus), ms :');
    console.log(consoleTable(['n', 'moyenne', 'p50', 'p95', 'p99', 'max'], [[p.count, fmt(p.mean, 2), fmt(p.p50, 2), fmt(p.p95, 2), fmt(p.p99, 2), fmt(p.max, 2)]]));
    const budget = DEFAULT_PARAMS.decisionPeriod * 1000;
    console.log(`Budget par cycle (période ${DEFAULT_PARAMS.decisionPeriod} s) : ${fmt(budget, 0)} ms — p95 ${p.p95 <= budget ? 'dans' : 'HORS'} budget.`);
  } catch (err) {
    if (isNotImplemented(err)) console.log(`decideAll : ${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); else throw err;
  }

  // 2. Match complet
  try {
    const config = makeConfig({ seed, minutes });
    const r = runMatch(config);
    const simMs = minutes * 60 * 1000;
    console.log(`\nMatch de ${minutes} min : ${formatDuration(r.wallMs)} de calcul, facteur temps réel ×${fmt(simMs / Math.max(1, r.wallMs), 0)} ; score ${r.score.A}–${r.score.B}, ${r.events ?? 0} événements.`);
    if (r.latency) console.log(`Latence par cycle en match (ms) : moyenne ${fmt(r.latency.cycleMean, 2)}, p50 ${fmt(r.latency.cycleP50, 2)}, p95 ${fmt(r.latency.cycleP95, 2)}, p99 ${fmt(r.latency.cycleP99, 2)} ; par décision p95 ${fmt(r.latency.p95, 3)} ms.`);
  } catch (err) {
    if (isNotImplemented(err)) console.log(`match : ${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); else throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
