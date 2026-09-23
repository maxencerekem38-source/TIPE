/**
 * Calibration des modèles probabilistes (§11.6) : `npx tsx scripts/calibrate.ts [--matches 8] [--minutes 5] [--sequential]`
 * Auto-jeu de N matchs, collecte des paires (probabilité attendue, issue) pour les passes et les tirs,
 * score de Brier et tables de fiabilité avant/après recalibrage de Platt. Écrit results/calibration.md et results/calibration.json.
 */
import { parseArgs, numFlag, boolFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, makeConfig, writeResult, gitHash, seedList, formatDuration, isNotImplemented, FULL_POLICY_NAME } from '../src/experiments/cli';
import { STYLE_IDS, type StyleId } from '../src/core/types';
import { naturalProfiles } from '../src/experiments/tournament';
import { runBatch, setSequential, lastBatchInfo } from '../src/experiments/worker-pool';
import { runMatchTask, type MatchTask } from '../src/experiments/runner';
import { collectCalibrationPairs, calibrationReport, fullCalibrationMarkdown } from '../src/experiments/calibration';
import { fmt, fmtPct } from '../src/experiments/metrics';
import { Rng } from '../src/core/rng';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nMatches = numFlag(args, 'matches', 8);
  const minutes = numFlag(args, 'minutes', 5);
  if (boolFlag(args, 'sequential')) setSequential(true);
  console.log(`Calibration : ${nMatches} matchs d'auto-jeu de ${minutes} min`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  const profiles = naturalProfiles(STYLE_IDS as readonly StyleId[]);
  const rng = new Rng(99);
  const tasks: MatchTask[] = seedList(nMatches, 300).map((seed) => ({
    config: makeConfig({ seed, minutes, tacticA: rng.pick(profiles), tacticB: rng.pick(profiles) }),
    policies: { A: FULL_POLICY_NAME, B: FULL_POLICY_NAME },
    options: { collectEvents: true },
  }));
  const t0 = performance.now();
  try {
    const results = await runBatch(tasks, runMatchTask, { workerTask: 'match' });
    const samples = collectCalibrationPairs(results);
    const wall = performance.now() - t0;
    console.log(`Matchs joués en ${formatDuration(wall)} (${lastBatchInfo.mode}) ; ${samples.passes.length} passes et ${samples.shots.length} tirs avec probabilité attendue.`);
    if (!samples.passes.length && !samples.shots.length) console.log('Aucune probabilité attendue n’est exposée par le moteur (flight.expectedP / event.value) : tables vides.');
    const passes = calibrationReport(samples.passes, 'Passes');
    const shots = calibrationReport(samples.shots, 'Tirs');
    for (const rep of [passes, shots]) {
      if (!rep.n) { console.log(`\n${rep.label} : aucune paire.`); continue; }
      console.log(`\n${rep.label} : n = ${rep.n}, réussite observée ${fmtPct(rep.baseRate)}, Brier ${fmt(rep.before.brier, 4)} → ${fmt(rep.after.brier, 4)} après Platt (a = ${fmt(rep.platt.a, 3)}, b = ${fmt(rep.platt.b, 3)}), ECE ${fmt(rep.before.ece, 3)} → ${fmt(rep.after.ece, 3)}`);
      console.log('  classe        n   p̄ prédit   observé');
      for (const b of rep.before.table) if (b.count) console.log(`  [${fmt(b.low, 1)};${fmt(b.high, 1)})  ${String(b.count).padStart(5)}   ${fmt(b.meanPredicted, 3).padStart(8)}   ${fmt(b.observed, 3).padStart(7)}`);
    }
    const header = `${nMatches} matchs d'auto-jeu de ${minutes} min (git ${gitHash()}, ${new Date().toLocaleString('fr-FR')}), tactiques tirées parmi les profils naturels. Recalibrage de Platt p′ = σ(a·logit(p) + b) ajusté par Newton–Raphson (ridge 10⁻³).`;
    const mdPath = writeResult('calibration.md', fullCalibrationMarkdown(samples, header));
    const jsonPath = writeResult('calibration.json', { git: gitHash(), date: new Date().toISOString(), matches: nMatches, minutes, passes: { ...passes, markdown: undefined }, shots: { ...shots, markdown: undefined } });
    console.log(`\nRapport : ${mdPath}, ${jsonPath}`);
  } catch (err) {
    if (isNotImplemented(err)) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); return; }
    throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
