/**
 * Optimisation des poids par la méthode d'entropie croisée (§10) :
 * `npx tsx scripts/optimize.ts --generations 10 --population 16 --elites 4 --matches 4 --minutes 3 [--optimizer cem|random|es] [--sequential]`
 * Écrit results/learning/cem-<horodatage>.json, results/learning/learning-curve.md et results/params-optimized.json.
 */
import { parseArgs, numFlag, strFlag, boolFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, writeResult, gitHash, timestamp, formatDuration, isNotImplemented } from '../src/experiments/cli';
import { optimizeParams, DEFAULT_OPTIM_PATHS, type OptimizerName } from '../src/experiments/cem';
import { learningCurveMarkdown } from '../src/experiments/report';
import { fmt, fmtCi } from '../src/experiments/metrics';
import { setSequential } from '../src/experiments/worker-pool';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const generations = numFlag(args, 'generations', 10);
  const population = numFlag(args, 'population', 16);
  const elites = numFlag(args, 'elites', Math.max(2, Math.round(population / 4)));
  const matches = numFlag(args, 'matches', 4);
  const minutes = numFlag(args, 'minutes', 3);
  const seed = numFlag(args, 'seed', 2024);
  const optimizer = strFlag(args, 'optimizer', 'cem') as OptimizerName;
  if (boolFlag(args, 'sequential')) setSequential(true);

  console.log(`Optimisation ${optimizer.toUpperCase()} : ${generations} générations × ${population} candidats (${elites} élites), ${matches} matchs de ${minutes} min par évaluation, ${DEFAULT_OPTIM_PATHS.length} paramètres`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  const t0 = performance.now();
  try {
    const out = await optimizeParams({
      optimizer, generations, population, elites, matches, minutes, seed,
      onGeneration: (rec) => console.log(`  génération ${String(rec.generation + 1).padStart(2)} : fitness moyenne ${fmt(rec.meanFitness, 4)} IC ${fmtCi(rec.ci, 4)}, meilleure ${fmt(rec.bestFitness, 4)}, ${rec.evaluations} évaluations, ${formatDuration(rec.wallMs)}`),
    });
    const header = `Optimiseur ${optimizer}, ${generations} générations × ${population} candidats (${elites} élites), ${matches} matchs de ${minutes} min par évaluation (graines communes par génération), git ${gitHash()}, graine ${seed}, durée ${formatDuration(performance.now() - t0)}.`;
    const stamp = timestamp();
    const jsonPath = writeResult(`learning/${optimizer}-${stamp}.json`, { git: gitHash(), date: new Date().toISOString(), optimizer, generations, population, elites, matches, minutes, seed, paths: out.paths, defaultFlat: out.defaultFlat, bestFlat: out.bestFlat, bestFitness: out.result.bestFitness, history: out.result.history });
    const mdPath = writeResult('learning/learning-curve.md', learningCurveMarkdown(out.result.history, out.paths, out.defaultFlat, out.bestFlat, header));
    const paramsPath = writeResult('params-optimized.json', { git: gitHash(), date: new Date().toISOString(), optimizer, bestFitness: out.result.bestFitness, flat: out.bestFlat, params: out.bestParams });
    console.log(`\nMeilleure fitness : ${fmt(out.result.bestFitness, 4)}. Fichiers : ${jsonPath}, ${mdPath}, ${paramsPath}`);
  } catch (err) {
    if (isNotImplemented(err)) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); return; }
    throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
