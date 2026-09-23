/**
 * Simulation headless d'un match : `npx tsx scripts/sim.ts --seed 1 --minutes 10 --tacticA 4-3-3:possession --tacticB 4-4-2:counter`
 * Options : --policyA / --policyB (full | random | greedy_progress | …), --events 10, --json (sortie JSON brute).
 */
import { parseArgs, numFlag, strFlag, boolFlag, parseTactic, makeConfig, withEngine, tacticLabel, resolvePolicy, formatDuration, engineStatus, ENGINE_UNAVAILABLE_MESSAGE } from '../src/experiments/cli';
import { runMatch } from '../src/experiments/runner';
import { matchStatsTable, consoleTable } from '../src/experiments/report';
import { fmt } from '../src/experiments/metrics';
import type { TeamId } from '../src/core/types';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seed = numFlag(args, 'seed', 1);
  const minutes = numFlag(args, 'minutes', 10);
  const tacticA = parseTactic(strFlag(args, 'tacticA', '4-3-3:balanced'));
  const tacticB = parseTactic(strFlag(args, 'tacticB', '4-4-2:balanced'));
  const policyA = strFlag(args, 'policyA', 'full'), policyB = strFlag(args, 'policyB', 'full');
  const nEvents = numFlag(args, 'events', 12);
  const config = makeConfig({ seed, minutes, tacticA, tacticB, teamNames: { A: `A (${tacticLabel(tacticA)})`, B: `B (${tacticLabel(tacticB)})` } });

  console.log(`Match simulé : ${config.teamNames!.A} contre ${config.teamNames!.B}, ${minutes} min, graine ${seed}, politiques ${policyA} / ${policyB}`);
  const status = engineStatus();
  if (!status.ok) { console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${status.reason})`); return; }

  const result = await withEngine(() => {
    const policies = policyA === 'full' && policyB === 'full' ? undefined : { A: resolvePolicy(policyA), B: resolvePolicy(policyB) };
    return runMatch(config, policies, { collectEvents: true });
  });
  if (!result) return;

  if (boolFlag(args, 'json')) { const { eventLog, flightLog, ...rest } = result; console.log(JSON.stringify({ ...rest, events: eventLog?.length ?? 0 }, null, 2)); return; }

  console.log(`\nScore final : ${result.score.A} – ${result.score.B}`);
  console.log(`Temps de calcul : ${formatDuration(result.wallMs)} pour ${minutes} min simulées (facteur temps réel ×${fmt((minutes * 60 * 1000) / Math.max(1, result.wallMs), 0)})\n`);
  console.log(matchStatsTable(result, config.teamNames!));

  const lat = result.latency;
  if (lat) {
    console.log('\nLatence de décision (ms) :');
    console.log(consoleTable(['', 'moyenne', 'p50', 'p95', 'p99', 'max'], [
      ['par décision', fmt(lat.mean, 3), fmt(lat.p50, 3), fmt(lat.p95, 3), fmt(lat.p99, 3), fmt(lat.max, 3)],
      ['par cycle (22 joueurs)', fmt(lat.cycleMean, 2), fmt(lat.cycleP50, 2), fmt(lat.cycleP95, 2), fmt(lat.cycleP99, 2), '—'],
    ]));
  }

  const events = result.eventLog ?? [];
  const important = events.filter((e) => ['goal', 'shot', 'save', 'pass_intercepted', 'tackle', 'dribble', 'turnover'].includes(e.kind));
  const top = important.sort((a, b) => (b.kind === 'goal' ? 3 : b.kind === 'shot' ? 2 : 1) - (a.kind === 'goal' ? 3 : a.kind === 'shot' ? 2 : 1) || a.time - b.time).slice(0, nEvents).sort((a, b) => a.time - b.time);
  const KIND_FR: Record<string, string> = { goal: 'BUT', shot: 'tir', save: 'arrêt', pass_intercepted: 'interception', tackle: 'tacle', dribble: 'dribble', turnover: 'perte' };
  console.log(`\nÉvénements marquants (${important.length} sur ${events.length}) :`);
  for (const e of top) {
    const mm = Math.floor(e.time / 60), ss = Math.floor(e.time % 60);
    const who = e.playerId !== undefined ? ` joueur ${e.playerId}` : '';
    const val = e.value !== undefined ? ` (${e.kind === 'shot' ? 'xG ' : 'p '}${fmt(e.value, 2)})` : '';
    console.log(`  ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}  ${(KIND_FR[e.kind] ?? e.kind).padEnd(13)} équipe ${e.team as TeamId}${who}${val}${e.label ? ` — ${e.label}` : ''}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
