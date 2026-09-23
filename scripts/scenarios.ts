/**
 * Banc de scénarios : `npx tsx scripts/scenarios.ts --policy full --seeds 8 --horizon 6 [--generated 24] [--sequential]`
 * Joue chaque scénario de la bibliothèque (et les scénarios générés) sur `seeds` graines, affiche par scénario
 * si la première décision est acceptable, le regret et le KPI, puis l'accord top-1 global.
 * Écrit results/scenarios-<politique>.json et results/scenarios.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, numFlag, strFlag, boolFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, resolvePolicy, writeResult, gitHash, seedList, policyNames, RESULTS_DIR, formatDuration } from '../src/experiments/cli';
import { SCENARIOS, SCENARIO_CATEGORIES, describeAcceptable } from '../src/experiments/scenarios';
import { benchmarkScenarios } from '../src/experiments/scenario-generator';
import { runScenario, summarizeScenarioRuns, type ScenarioRunResult } from '../src/experiments/runner';
import { runBatch, setSequential, lastBatchInfo } from '../src/experiments/worker-pool';
import { runScenarioTask, type ScenarioTask } from '../src/experiments/worker-tasks';
import { scenarioSummaryMarkdown, consoleTable } from '../src/experiments/report';
import { fmt, fmtPct } from '../src/experiments/metrics';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy = strFlag(args, 'policy', 'full');
  const nSeeds = numFlag(args, 'seeds', 8);
  const horizon = numFlag(args, 'horizon', 6);
  const nGenerated = numFlag(args, 'generated', 0);
  const genSeed = numFlag(args, 'gen-seed', 2024);
  if (boolFlag(args, 'sequential')) setSequential(true);
  const listOnly = boolFlag(args, 'list');

  const scenarios = nGenerated > 0 ? benchmarkScenarios(SCENARIOS, nGenerated, genSeed) : [...SCENARIOS];
  if (listOnly) {
    console.log(consoleTable(['Identifiant', 'Catégorie', 'Équipe', 'Porteur', 'KPI', 'Réservé', 'Actions acceptables'],
      scenarios.map((s) => [s.id, SCENARIO_CATEGORIES[s.category], s.team, s.protagonistId, s.kpi, s.reserved ? 'oui' : '', describeAcceptable(s.acceptable)])));
    return;
  }
  console.log(`Banc de scénarios : ${scenarios.length} scénarios (${SCENARIOS.length} manuels, ${scenarios.length - SCENARIOS.length} générés), politique « ${policy} », ${nSeeds} graines, horizon ${horizon} s`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }
  try { resolvePolicy(policy); } catch (err) { console.log(`Politique indisponible : ${err instanceof Error ? err.message : err} — politiques : ${policyNames().join(', ')}`); return; }

  const seeds = seedList(nSeeds, 1);
  const tasks: ScenarioTask[] = [];
  scenarios.forEach((s, i) => {
    const generated = s.generated ? { seed: genSeed, index: i - SCENARIOS.length } : undefined;
    for (const seed of seeds) tasks.push({ scenarioId: s.id, generated, policy, seed, horizonSec: horizon });
  });
  const t0 = performance.now();
  let results: ScenarioRunResult[];
  try {
    results = await runBatch(tasks, runScenarioTask, { workerTask: 'scenario' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('non implémenté')) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${err.message})`); return; }
    throw err;
  }
  const wall = performance.now() - t0;
  const summary = summarizeScenarioRuns(scenarios, results, policy);
  console.log(`Exécution : ${formatDuration(wall)} (${lastBatchInfo.mode}${lastBatchInfo.workers ? `, ${lastBatchInfo.workers} workers` : ''}${lastBatchInfo.fallbackReason ? ` ; ${lastBatchInfo.fallbackReason}` : ''})\n`);

  console.log(consoleTable(['Scénario', 'Acceptable', 'Regret', 'KPI', 'Action la plus fréquente'], summary.perScenario.map((p) => {
    const top = Object.entries(p.actions).sort((a, b) => b[1] - a[1])[0];
    return [p.reserved ? `${p.id} †` : p.id, fmtPct(p.acceptableRate, 0), fmt(p.meanRegret, 4), `${p.kpi}=${fmt(p.meanKpi, 3)}`, top ? `${top[0]} (${top[1]}/${nSeeds})` : '—'];
  })));
  console.log(`\nAccord top-1 (première décision acceptable) : ${fmtPct(summary.top1Agreement, 1)} sur ${summary.runs} exécutions ; regret moyen ${fmt(summary.meanRegret, 4)}.`);
  const reserved = summary.perScenario.filter((p) => p.reserved);
  if (reserved.length) console.log(`Scénarios réservés (†) : accord ${fmtPct(reserved.reduce((s, p) => s + p.acceptableRate, 0) / reserved.length, 1)}.`);

  const light = results.map((r) => ({ ...r, decision: r.decision ? { time: r.decision.time, chosen: r.decision.chosen.action, score: r.decision.chosen.score, best: r.decision.candidates[0]?.score ?? r.decision.chosen.score, reason: r.decision.chosen.reason, computeMs: r.decision.computeMs } : null }));
  const jsonPath = writeResult(`scenarios-${policy}.json`, { git: gitHash(), date: new Date().toISOString(), policy, seeds, horizon, summary, results: light });

  // Rapport Markdown : une section par politique déjà évaluée (fusion des JSON existants).
  const sections: string[] = [`# Banc de scénarios`, '', `Généré le ${new Date().toLocaleString('fr-FR')} (git ${gitHash()}). Chaque scénario est joué ${horizon} s sur ${nSeeds} graines ; on juge la première décision du porteur (accord top-1 avec l’ensemble acceptable), son regret (meilleur score − score choisi) et le KPI du scénario.`, ''];
  for (const name of policyNames()) {
    const p = resolve(RESULTS_DIR, `scenarios-${name}.json`);
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      sections.push(`## Politique « ${name} »`, '', scenarioSummaryMarkdown(data.summary, scenarios));
    } catch { /* fichier illisible : ignoré */ }
  }
  const mdPath = writeResult('scenarios.md', sections.join('\n'));
  console.log(`\nRésultats écrits : ${jsonPath}, ${mdPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
