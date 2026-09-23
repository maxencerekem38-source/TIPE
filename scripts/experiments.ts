/**
 * Plan d'expériences (§11.4) : `npx tsx scripts/experiments.ts [--quick] [--seeds 32 --minutes 10] [--skip-tournament] [--sequential]`
 * 1. algorithme complet contre chaque baseline (graines appariées, côtés échangés) ;
 * 2. tournoi tactique des 7 styles avec leur formation naturelle (Elo, KPI structurels, exploitabilité) ;
 * 3. ablations de paramètres contre le réglage par défaut.
 * Écrit results/experiments.json et results/EXPERIENCES.md.
 */
import { parseArgs, numFlag, boolFlag, strFlag, engineStatus, ENGINE_UNAVAILABLE_MESSAGE, makeConfig, writeResult, gitHash, seedList, formatDuration, isNotImplemented } from '../src/experiments/cli';
import { STYLE_IDS, type StyleId } from '../src/core/types';
import * as baselinesModule from '../src/decision/baselines';
import { runBaselineComparison, runTournament, naturalProfiles, type PairedComparison, type TournamentResult } from '../src/experiments/tournament';
import { runAblations, DEFAULT_ABLATIONS, type AblationResult } from '../src/experiments/ablations';
import { holmCorrection, fmtSigned, fmtP, fmtPct, fmt } from '../src/experiments/metrics';
import { pairedComparisonMarkdown, comparisonsSummaryMarkdown, tournamentMarkdown, ablationsMarkdown } from '../src/experiments/report';
import { setSequential, lastBatchInfo } from '../src/experiments/worker-pool';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const quick = boolFlag(args, 'quick');
  const nSeeds = numFlag(args, 'seeds', quick ? 6 : 32);
  const minutes = numFlag(args, 'minutes', quick ? 3 : 10);
  if (boolFlag(args, 'sequential')) setSequential(true);
  const skipTournament = boolFlag(args, 'skip-tournament');
  const skipAblations = boolFlag(args, 'skip-ablations');
  const skipBaselines = boolFlag(args, 'skip-baselines');
  const only = strFlag(args, 'baselines', '');

  console.log(`Plan d'expériences${quick ? ' (mode rapide)' : ''} : ${nSeeds} graines × ${minutes} min`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  const seeds = seedList(nSeeds, 100);
  const mk = (seed: number) => makeConfig({ seed, minutes });
  const started = performance.now();
  const report: string[] = [`# Expériences`, '', `Généré le ${new Date().toLocaleString('fr-FR')} (git ${gitHash()}) — ${nSeeds} graines appariées × ${minutes} min par match. Différences appariées par graine, IC 95 % de Student et bootstrap (2 000 rééchantillonnages), test de Wilcoxon signé, δ de Cliff ; correction de Holm pour les familles de comparaisons.`, ''];
  const json: Record<string, unknown> = { git: gitHash(), date: new Date().toISOString(), seeds, minutes, quick };

  // 1. Baselines
  let baselines: PairedComparison[] = [];
  if (!skipBaselines) {
    const available = Object.keys(baselinesModule.BASELINES ?? {});
    const names = only ? only.split(',').filter((n) => available.includes(n)) : available;
    if (!names.length) console.log('Aucune baseline disponible (BASELINES non défini) : étape 1 ignorée.');
    else {
      console.log(`\n1. Algorithme complet contre ${names.length} baselines : ${names.join(', ')}`);
      try {
        baselines = await runBaselineComparison(names, seeds, { makeConfig: mk });
        const pHolm = holmCorrection(baselines.map((c) => c.summary.xG.wilcoxon.pValue));
        baselines.forEach((c, i) => console.log(`   ${c.label.padEnd(48)} ΔxG ${fmtSigned(c.summary.xG.meanDiff, 3)}  p=${fmtP(c.summary.xG.wilcoxon.pValue)} (Holm ${fmtP(pHolm[i])})  victoires ${fmtPct(c.summary.xG.winRate, 0)}  [${formatDuration(c.wallMs)}]`));
        report.push('## 1. Algorithme complet contre les baselines', '', comparisonsSummaryMarkdown(baselines, pHolm), '');
        for (const c of baselines) report.push(pairedComparisonMarkdown(c));
        json.baselines = baselines.map((c) => ({ label: c.label, x: c.x, y: c.y, goals: c.goals, summary: c.summary, perSeed: c.perSeed }));
      } catch (err) {
        if (isNotImplemented(err)) console.log(`   ${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); else throw err;
      }
    }
  }

  // 2. Tournoi tactique
  let tournament: TournamentResult | null = null;
  if (!skipTournament) {
    const styles = STYLE_IDS as readonly StyleId[];
    const profiles = naturalProfiles(styles);
    const tSeeds = quick ? seeds.slice(0, Math.max(2, Math.floor(nSeeds / 2))) : seeds;
    console.log(`\n2. Tournoi tactique : ${profiles.length} profils, ${tSeeds.length} graines (${(profiles.length * (profiles.length - 1)) * tSeeds.length} matchs)`);
    try {
      tournament = await runTournament(profiles, tSeeds, minutes);
      const order = tournament.profiles.map((_, i) => i).sort((a, b) => tournament!.elo[tournament!.profiles[b]] - tournament!.elo[tournament!.profiles[a]]);
      for (const i of order) { const p = tournament.profiles[i]; console.log(`   ${p.padEnd(22)} Elo ${fmt(tournament.elo[p], 0)}  points ${tournament.points[i]}  xG ${fmt(tournament.kpis[p].xGFor.mean, 2)}/${fmt(tournament.kpis[p].xGAgainst.mean, 2)}  exploitabilité ${fmtSigned(tournament.exploitability[p].value, 2)} (${tournament.exploitability[p].opponent})`); }
      console.log(`   [${formatDuration(tournament.wallMs)}, ${lastBatchInfo.mode}]`);
      report.push('## 2. Tournoi tactique', '', tournamentMarkdown(tournament));
      const { games, ...rest } = tournament;
      json.tournament = rest;
    } catch (err) {
      if (isNotImplemented(err)) console.log(`   ${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); else throw err;
    }
  }

  // 3. Ablations
  let ablations: AblationResult[] = [];
  if (!skipAblations) {
    const list = quick ? DEFAULT_ABLATIONS.slice(0, 4) : DEFAULT_ABLATIONS;
    console.log(`\n3. Ablations : ${list.length} variantes contre le réglage par défaut`);
    try {
      ablations = await runAblations(list, seeds, { makeConfig: mk });
      for (const a of ablations) console.log(`   ${a.ablation.label.padEnd(36)} ΔxG ${fmtSigned(a.comparison.summary.xG.meanDiff, 3)}  p=${fmtP(a.comparison.summary.xG.wilcoxon.pValue)}  Δregret ${fmtSigned(a.comparison.summary.regret.meanDiff, 4)}`);
      report.push('## 3. Ablations de paramètres', '', ablationsMarkdown(ablations));
      json.ablations = ablations.map((a) => ({ ablation: a.ablation, summary: a.comparison.summary, goals: a.comparison.goals, perSeed: a.comparison.perSeed }));
    } catch (err) {
      if (isNotImplemented(err)) console.log(`   ${ENGINE_UNAVAILABLE_MESSAGE} (${(err as Error).message})`); else throw err;
    }
  }

  report.push('## Limites', '', 'Les buts sont rares (≈ 2,5 par 10 min simulées) : les conclusions reposent sur ΔxG et la menace créée ; la différence de buts est indicative. Les p-values des familles de comparaisons sont corrigées par Holm.', '');
  const jsonPath = writeResult('experiments.json', json);
  const mdPath = writeResult('EXPERIENCES.md', report.join('\n'));
  console.log(`\nDurée totale ${formatDuration(performance.now() - started)}. Résultats : ${jsonPath}, ${mdPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
