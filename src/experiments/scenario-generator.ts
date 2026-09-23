/**
 * Générateur procédural de scénarios (§11.2) : formation × phase × bruit gaussien (3 m).
 * Chaque scénario place les deux blocs selon leurs formations, décale les blocs vers le tiers choisi,
 * ajoute un bruit gaussien sur les positions, une petite vitesse aléatoire, et donne le ballon
 * à un joueur de champ tiré au sort. Déterministe pour une graine donnée.
 */
import type { FormationId, MatchState, StyleId, TacticConfig, TeamId } from '../core/types';
import { FORMATION_IDS, STYLE_IDS, attackDir, otherTeam } from '../core/types';
import { PITCH, clampToPitch } from '../core/pitch';
import { buildFullState, emptyStats } from '../core/state-builder';
import { makeTactic } from '../tactics/styles';
import { Rng } from '../core/rng';
import type { Vec2 } from '../core/vec2';
import { ACTION_CLASSES, copyStateInto, type Scenario } from './scenarios';

export type Third = 'defensive' | 'middle' | 'attacking';
export const THIRDS: readonly Third[] = ['defensive', 'middle', 'attacking'] as const;
export const THIRD_LABELS: Record<Third, string> = { defensive: 'tiers défensif', middle: 'tiers médian', attacking: 'tiers offensif' };

export interface GeneratedScenarioInfo {
  seed: number;
  index: number;
  team: TeamId;
  third: Third;
  formations: Record<TeamId, FormationId>;
  styles: Record<TeamId, StyleId>;
}

export interface GeneratorOptions {
  /** Écart-type du bruit de position (m). */
  noise?: number;
  /** Nombre de scénarios marqués « réservés » en tête de liste. */
  reservedCount?: number;
  /** Préfixe des identifiants. */
  prefix?: string;
}

/** Centre (repère équipe, x') visé par le bloc en possession pour chaque tiers. */
const THIRD_CENTER_X: Record<Third, number> = { defensive: -30, middle: 0, attacking: 28 };

/**
 * Construit l'état d'un scénario généré à partir d'une graine et d'un indice (pur).
 */
export function buildGeneratedState(seed: number, index: number, noise = 3): { state: MatchState; info: GeneratedScenarioInfo } {
  const rng = new Rng((seed * 7919 + index * 104729 + 17) >>> 0);
  const team: TeamId = rng.next() < 0.5 ? 'A' : 'B';
  const opp = otherTeam(team);
  const third = rng.pick(THIRDS);
  const formations: Record<TeamId, FormationId> = { A: rng.pick(FORMATION_IDS), B: rng.pick(FORMATION_IDS) };
  const styles: Record<TeamId, StyleId> = { A: rng.pick(STYLE_IDS), B: rng.pick(STYLE_IDS) };
  const tactics: Record<TeamId, TacticConfig> = { A: makeTactic(formations.A, styles.A), B: makeTactic(formations.B, styles.B) };

  // Décalage des blocs : l'équipe en possession se centre sur le tiers visé (son bloc de référence est centré
  // vers x' ≈ −8), l'équipe adverse se replie d'autant (dans son propre repère, le ballon avance vers elle).
  const targetX = THIRD_CENTER_X[third] + rng.normal(0, 4);
  const attShiftTeam = targetX - (-8);
  const defShiftTeam = -attShiftTeam * 0.9;
  const lateral = rng.normal(0, 8);
  const dir = attackDir(team);
  const shift: Record<TeamId, Vec2> = {
    [team]: { x: dir * attShiftTeam, y: lateral },
    [opp]: { x: -dir * defShiftTeam, y: lateral },
  } as Record<TeamId, Vec2>;

  const base = buildFullState({ tactics, shift });
  // Bruit gaussien et vitesse aléatoire, joueurs maintenus dans le terrain.
  for (const p of base.players) {
    const isGk = p.role === 'GK';
    const n = isGk ? noise * 0.3 : noise;
    const pos = clampToPitch({ x: p.pos.x + rng.normal(0, n), y: p.pos.y + rng.normal(0, n) }, 1);
    // Le gardien reste dans sa surface.
    if (isGk) {
      const side = -attackDir(p.team);
      pos.x = side * Math.min(PITCH.halfLength - 1, Math.max(PITCH.halfLength - PITCH.penaltyAreaLength, side * pos.x));
    }
    p.pos = pos;
    const speed = rng.uniform(0, 3);
    const angle = rng.uniform(0, 2 * Math.PI);
    p.vel = { x: speed * Math.cos(angle), y: speed * Math.sin(angle) };
  }
  // Porteur : joueur de champ de `team` dont la position est la plus proche du tiers visé (parmi 3 tirés au sort).
  const outfield = base.players.filter((p) => p.team === team && p.role !== 'GK');
  const candidates = [rng.pick(outfield), rng.pick(outfield), rng.pick(outfield)];
  const targetTerrain = dir * targetX;
  const owner = candidates.reduce((best, p) => (Math.abs(p.pos.x - targetTerrain) < Math.abs(best.pos.x - targetTerrain) ? p : best));
  base.ball.pos = { ...owner.pos };
  base.ball.ownerId = owner.id;
  base.ball.lastTouchId = owner.id;
  base.possession = team;
  base.phase = { A: team === 'A' ? 'attack' : 'defence', B: team === 'B' ? 'attack' : 'defence' };
  base.stats = emptyStats();
  const info: GeneratedScenarioInfo = { seed, index, team, third, formations, styles };
  return { state: base, info };
}

/** Génère `n` scénarios procéduraux (déterministes) ; les `reservedCount` premiers sont réservés. */
export function generateScenarios(seed: number, n: number, options: GeneratorOptions = {}): Scenario[] {
  const noise = options.noise ?? 3;
  const reservedCount = options.reservedCount ?? 0;
  const prefix = options.prefix ?? `gen${seed}`;
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const { state: probe, info } = buildGeneratedState(seed, i, noise);
    const build = (): MatchState => buildGeneratedState(seed, i, noise).state;
    out.push({
      id: `${prefix}_${String(i).padStart(3, '0')}`,
      name: `Scénario généré ${i} (${info.formations[info.team]} ${info.styles[info.team]}, ${THIRD_LABELS[info.third]})`,
      description: `État procédural : équipe ${info.team} en ${info.formations[info.team]} (${info.styles[info.team]}) en possession dans le ${THIRD_LABELS[info.third]}, bruit gaussien de ${noise} m.`,
      category: 'generated',
      team: info.team,
      protagonistId: probe.ball.ownerId as number,
      acceptable: [...ACTION_CLASSES],
      kpi: info.third === 'attacking' ? 'xg' : info.third === 'middle' ? 'threat' : 'possession',
      reserved: i < reservedCount,
      generated: true,
      build,
      apply: (state) => copyStateInto(state, build()),
    });
  }
  return out;
}

/** Jeu de référence du banc : bibliothèque manuelle + scénarios générés (20 réservés au total par défaut). */
export function benchmarkScenarios(library: readonly Scenario[], generatedCount = 24, seed = 2024): Scenario[] {
  const manualReserved = library.filter((s) => s.reserved).length;
  const reservedCount = Math.max(0, 20 - manualReserved);
  return [...library, ...generateScenarios(seed, generatedCount, { reservedCount })];
}
