/**
 * Calibration des modèles probabilistes (§11.6) : `npx tsx scripts/calibrate.ts [--matches 6] [--minutes 5] [--seed 300]`
 * Auto-jeu séquentiel de N matchs (graines fixes) :
 *  1. paires (probabilité annoncée, issue) des passes et des tirs → Brier, tables de fiabilité avant/après recalibrage de Platt ;
 *  2. pour chaque passe exécutée, caractéristiques brutes de l'interception (avances Δ_{j,m} par défenseur et par échantillon),
 *     partie d'exécution σ(logit), distance, type ; grille η × σ_T × w minimisant le Brier de P_pass recalculée contre l'issue
 *     réelle, fiabilité avant/après, Brier par distance (0–10, 10–20, 20–30, 30+ m), par type et par vitesse d'arrivée.
 * Écrit results/calibration.md et results/calibration.json. L'exécution est séquentielle (le collecteur est un rappel).
 */
import { parseArgs, numFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, makeConfig, writeResult, gitHash, seedList, formatDuration, isNotImplemented } from '../src/experiments/cli';
import { STYLE_IDS, type StyleId } from '../src/core/types';
import { DEFAULT_PARAMS } from '../src/core/params';
import { naturalProfiles } from '../src/experiments/tournament';
import { runMatch, type MatchResult } from '../src/experiments/runner';
import { attachPassOutcomes, calibrateInterception, calibrationReport, collectCalibrationPairs, createPassFeatureCollector, fitPassCoefficients, fullCalibrationMarkdown, interceptionCalibrationMarkdown, binReports, distanceBinLabel, DISTANCE_BIN_ORDER, type PassFeatureRecord } from '../src/experiments/calibration';
import { fmt, fmtPct } from '../src/experiments/metrics';
import { Rng } from '../src/core/rng';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nMatches = numFlag(args, 'matches', 6);
  const minutes = numFlag(args, 'minutes', 5);
  const firstSeed = numFlag(args, 'seed', 300);
  console.log(`Calibration : ${nMatches} matchs d'auto-jeu de ${minutes} min (graines ${firstSeed}–${firstSeed + nMatches - 1})`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  const profiles = naturalProfiles(STYLE_IDS as readonly StyleId[]);
  const rng = new Rng(99);
  const t0 = performance.now();
  try {
    const results: MatchResult[] = [];
    const records: PassFeatureRecord[] = [];
    for (const seed of seedList(nMatches, firstSeed)) {
      const config = makeConfig({ seed, minutes, tacticA: rng.pick(profiles), tacticB: rng.pick(profiles) });
      const collector = createPassFeatureCollector(config.params);
      const r = runMatch(config, undefined, { collectEvents: true, onDecisions: collector.onDecisions });
      results.push(r);
      records.push(...attachPassOutcomes(collector.records, r.eventLog ?? []));
    }
    const samples = collectCalibrationPairs(results);
    const wall = performance.now() - t0;
    console.log(`Matchs joués en ${formatDuration(wall)} ; ${samples.passes.length} passes et ${samples.shots.length} tirs avec probabilité annoncée ; ${records.length} passes avec caractéristiques d'interception.`);
    const passes = calibrationReport(samples.passes, 'Passes');
    const shots = calibrationReport(samples.shots, 'Tirs');
    for (const rep of [passes, shots]) {
      if (!rep.n) { console.log(`\n${rep.label} : aucune paire.`); continue; }
      console.log(`\n${rep.label} : n = ${rep.n}, réussite observée ${fmtPct(rep.baseRate)}, Brier ${fmt(rep.before.brier, 4)} → ${fmt(rep.after.brier, 4)} après Platt (a = ${fmt(rep.platt.a, 3)}, b = ${fmt(rep.platt.b, 3)}), ECE ${fmt(rep.before.ece, 3)} → ${fmt(rep.after.ece, 3)}`);
      console.log('  classe        n   p̄ prédit   observé');
      for (const b of rep.before.table) if (b.count) console.log(`  [${fmt(b.low, 1)};${fmt(b.high, 1)})  ${String(b.count).padStart(5)}   ${fmt(b.meanPredicted, 3).padStart(8)}   ${fmt(b.observed, 3).padStart(7)}`);
    }

    // Interception : grille η × σ_T × w sur les passes jouées.
    const cal = calibrateInterception(records, DEFAULT_PARAMS);
    console.log(`\nInterception : ${cal.n} passes ; écart P annoncée / P recalculée (modèle courant) ${fmt(cal.rescoreGap, 3)}`);
    console.log(`  courant  η = ${fmt(cal.current.eta, 2)}, σ_T = ${fmt(cal.current.sigma, 2)}, w = ${cal.current.window} : Brier ${fmt(cal.current.brier, 4)}, ECE ${fmt(cal.current.ece, 3)}`);
    console.log(`  meilleur η = ${fmt(cal.best.eta, 2)}, σ_T = ${fmt(cal.best.sigma, 2)}, w = ${cal.best.window} : Brier ${fmt(cal.best.brier, 4)}, ECE ${fmt(cal.best.ece, 3)}`);
    for (const window of [...new Set(cal.grid.map((g) => g.window))]) for (const sigma of [...new Set(cal.grid.map((g) => g.sigma))]) {
      const row = cal.grid.filter((g) => g.window === window && g.sigma === sigma).map((g) => `${fmt(g.eta, 2)}:${fmt(g.brier, 4)}`).join('  ');
      console.log(`  w = ${window}, σ_T = ${fmt(sigma, 1)} : ${row}`);
    }
    // Coefficients logistiques (réajustement contraint, interception fixée au meilleur point) et Brier par distance.
    const fit = fitPassCoefficients(records, DEFAULT_PARAMS, cal.best);
    console.log(`  coefficients : passe base ${fmt(fit.before.pass.base, 2)} → ${fmt(fit.after.pass.base, 2)}, distance ${fmt(fit.before.pass.distance, 3)} → ${fmt(fit.after.pass.distance, 3)}, > 30 m ${fmt(fit.before.pass.longDistance, 3)} → ${fmt(fit.after.pass.longDistance, 3)} ; profondeur base ${fmt(fit.before.through.base, 2)} → ${fmt(fit.after.through.base, 2)}, distance ${fmt(fit.before.through.distance, 3)} → ${fmt(fit.after.through.distance, 3)} ; Brier ${fmt(fit.brierBefore, 4)} → ${fmt(fit.brierAfter, 4)}`);
    console.log(`  ancrages après : 15 m libre ${fmt(fit.anchors.pass15Free, 3)}, 35 m sous pression ${fmt(fit.anchors.pass35Pressed, 3)}, profondeur 20 m libre ${fmt(fit.anchors.through20Free, 3)}`);
    console.log('  par distance (n, observé, p̄ avant → après [interception + coefficients], Brier avant → après) :');
    for (const b of binReports(records, cal.current, cal.best, (r) => distanceBinLabel(r.distance), DISTANCE_BIN_ORDER, fit.after)) {
      console.log(`    ${b.label.padEnd(8)} ${String(b.n).padStart(4)}  ${fmtPct(b.observed).padStart(7)}  ${fmt(b.meanBefore, 3)} → ${fmt(b.meanAfter, 3)}  ${fmt(b.brierBefore, 4)} → ${fmt(b.brierAfter, 4)}`);
    }

    const header = `${nMatches} matchs d'auto-jeu de ${minutes} min (graines ${firstSeed}–${firstSeed + nMatches - 1}, git ${gitHash()}, ${new Date().toLocaleString('fr-FR')}), tactiques tirées parmi les profils naturels. Recalibrage de Platt p′ = σ(a·logit(p) + b) ajusté par Newton–Raphson (ridge 10⁻³) ; interception : grille η × σ_T × w minimisant le Brier de P_pass recalculée sur les caractéristiques brutes des passes jouées (§4.6, §11.6), puis réajustement contraint des coefficients logistiques.`;
    const markdown = [fullCalibrationMarkdown(samples, header), interceptionCalibrationMarkdown(cal, records, fit)].join('\n');
    const mdPath = writeResult('calibration.md', markdown);
    const jsonPath = writeResult('calibration.json', {
      git: gitHash(), date: new Date().toISOString(), matches: nMatches, minutes, seeds: seedList(nMatches, firstSeed),
      passes: { ...passes, markdown: undefined }, shots: { ...shots, markdown: undefined },
      interception: { n: cal.n, rescoreGap: cal.rescoreGap, current: cal.current, best: cal.best, grid: cal.grid, byDistance: binReports(records, cal.current, cal.best, (r) => distanceBinLabel(r.distance), DISTANCE_BIN_ORDER, fit.after) },
      coefficients: fit,
    });
    console.log(`\nRapport : ${mdPath}, ${jsonPath}`);
  } catch (err) {
    if (isNotImplemented(err)) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); return; }
    throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
