/**
 * Coordonnateur (docs/CONCEPTION.md §13.2) : un cycle de décision complet pour les 22 joueurs.
 *  1. champs spatiaux : computeFields → state.fields (seule écriture dans l'état) ;
 *  2. équipe attaquante = équipe du porteur, sinon équipe en possession ;
 *  3. porteur de champ → onBall ; gardien → decideKeeper (relance §8.6 s'il est porteur, sinon placement) ;
 *     coéquipiers → offBall, puis règle collective « un seul coureur par bande latérale » (§7.2, allocateRuns) ;
 *     équipe adverse → defence (gardien inclus) ;
 *  4. ballon libre : receveur désigné d'une passe → « receive » (l'équipe du passeur n'a alors pas d'autre coureur) ;
 *     sortie du gardien (decideKeeper, ballon libre dans sa surface et gardien premier dessus) = chasseur de son équipe ;
 *     sinon, par équipe, le joueur au plus petit temps d'interception du ballon → « chase » / « intercept » (jusqu'à 2 par
 *     équipe si le ballon est disputé) ; le frappeur sous immunité (physics.kickerImmunity) ne court pas après sa passe ;
 *     les autres gardent leur comportement de phase ; les points de rencontre sont stables (conservés à < 3 m ou tant
 *     qu'ils restent atteignables avant le ballon, loose.stableMeetingPoint) ;
 *  5. gel de remise en jeu : tous les joueurs rejoignent leur poste (« hold_shape »), le remetteur conserve le ballon.
 * Écritures dans l'état : `state.fields` (champs) et `state.slotBallRef` (référence de ballon lissée des postes, §7.2).
 * Retourne une décision pour CHAQUE joueur.
 */
import type { Decision, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam, TEAMS } from '../core/types';
import type { Rng } from '../core/rng';
import { PITCH } from '../core/pitch';
import { computeFields } from '../models/fields';
import { fmtFr, fmtPoint } from './explain';
import { decideDefence } from './defence';
import { decideKeeper } from './keeper';
import { rankChasers, receiveMeeting, simpleHoldDecision, simpleMoveDecision, stableMeetingPoint, teamSlot, updateSlotBallRef } from './loose';
import { decideOffBall } from './offball';
import { decideOnBall } from './onball';
import type { DecisionInput, PolicySet } from './policy';

/** Écart (s) entre les meilleurs temps d'interception des deux équipes en deçà duquel le ballon est « disputé ». */
const CONTESTED_MARGIN = 0.5;
/** Vitesse (fraction de v_max) du retour au poste pendant un gel. */
const FREEZE_SPEED = 0.6;
/** Largeur de bande latérale (m) par défaut si `offBall.runBandWidth` est absent (0 = règle désactivée). */
const DEFAULT_RUN_BAND_WIDTH = 15;

/** La politique complète (algorithme principal). */
export const FULL_POLICY: PolicySet = {
  name: 'complet',
  onBall: decideOnBall,
  offBall: decideOffBall,
  defence: decideDefence,
};

const inputFor = (state: MatchState, params: SimParams, rng: Rng, team: TeamId): DecisionInput => ({
  state, fields: state.fields!, params, tactic: state.tactics[team], rng,
});

/** Décision de repli au poste pendant un gel de remise en jeu. */
function freezeDecision(input: DecisionInput, p: Player): Decision {
  const target = teamSlot(input.state, p);
  return simpleMoveDecision(input, p, target, 'hold_shape', p.maxSpeed * FREEZE_SPEED, `Remise en jeu : retour au poste ${fmtPoint(target)} pendant le gel.`);
}

/** Bande latérale (indice entier) d'un point : bandes de `width` m sur y, comptées depuis la ligne de touche y = −W/2. */
export const runBand = (y: number, width: number): number => Math.floor((y + PITCH.halfWidth) / width);

/**
 * Un seul coureur par bande latérale (§7.2) : parmi les joueurs de `team` dont l'action choisie est un appel en
 * profondeur (intention « run »), les appels sont attribués gloutonnement par utilité décroissante avec au plus un
 * appel par bande de `offBall.runBandWidth` m (bandes sur y, repère terrain, cible de l'appel). Les perdants gardent
 * leur meilleur candidat non-appel (le premier de leur liste triée qui n'est pas un appel), sinon le retour au poste.
 * Les décisions rétrogradées sont réécrites dans `out` ; retourne les identifiants des joueurs rétrogradés.
 */
export function allocateRuns(state: MatchState, params: SimParams, out: Map<number, Decision>, team: TeamId, input: DecisionInput): number[] {
  const w = params.offBall.runBandWidth ?? DEFAULT_RUN_BAND_WIDTH;
  if (!(w > 0)) return []; // 0 = règle désactivée (comparaisons avant / après)
  const width = w;
  const runners: { p: Player; d: Decision; band: number }[] = [];
  for (const p of state.players) {
    if (p.team !== team) continue;
    const d = out.get(p.id);
    const a = d?.chosen.action;
    if (!d || !a || a.type !== 'move' || a.intent !== 'run') continue;
    runners.push({ p, d, band: runBand(a.target.y, width) });
  }
  if (runners.length < 2) return [];
  runners.sort((a, b) => b.d.chosen.score - a.d.chosen.score || a.p.id - b.p.id);
  const taken = new Map<number, { p: Player; score: number }>();
  const demoted: number[] = [];
  for (const r of runners) {
    const winner = taken.get(r.band);
    if (!winner) { taken.set(r.band, { p: r.p, score: r.d.chosen.score }); continue; }
    const alt = r.d.candidates.find((c) => c.action.type === 'move' && c.action.intent !== 'run');
    const note = `Appel en profondeur cédé à ${winner.p.name} (même bande latérale de ${fmtFr(width, 0)} m, utilité ${fmtFr(winner.score, 3)} ≥ ${fmtFr(r.d.chosen.score, 3)})`;
    if (alt) out.set(r.p.id, { ...r.d, chosen: alt, keptByHysteresis: undefined, explanation: `${r.d.explanation}\n${note} : repli sur ${alt.reason}` });
    else {
      const slot = teamSlot(state, r.p);
      const d = simpleMoveDecision(input, r.p, slot, 'hold_shape', r.p.maxSpeed * FREEZE_SPEED, `${note} : retour au poste ${fmtPoint(slot)}.`);
      out.set(r.p.id, { ...d, explanation: `${r.d.explanation}\n${d.explanation}` });
    }
    demoted.push(r.p.id);
  }
  return demoted;
}

export function decideAll(state: MatchState, params: SimParams, policies: Record<TeamId, PolicySet>, previous: Map<number, Decision>, rng: Rng): Map<number, Decision> {
  state.fields = computeFields(state, params);
  updateSlotBallRef(state, params);
  const out = new Map<number, Decision>();
  const inputs: Record<TeamId, DecisionInput> = { A: inputFor(state, params, rng, 'A'), B: inputFor(state, params, rng, 'B') };
  const ball = state.ball;
  const ownerId = ball.ownerId;
  const owner = ownerId !== null ? state.players.find((p) => p.id === ownerId) ?? null : null;

  // --- Gel de remise en jeu : retour aux postes, le remetteur conserve ---
  if (state.restart && state.time < state.restart.resumeAt - 1e-9) {
    for (const p of state.players) {
      out.set(p.id, owner && p.id === owner.id
        ? simpleHoldDecision(inputs[p.team], p, `Remise en jeu (${state.restart.kind}) : ${p.name} attend la reprise à ${fmtFr(state.restart.resumeAt, 1)} s.`)
        : freezeDecision(inputs[p.team], p));
    }
    return out;
  }

  const attacking: TeamId = owner ? owner.team : state.possession ?? 'A';
  const defending = otherTeam(attacking);

  // --- Équipe attaquante ---
  const att = inputs[attacking];
  for (const p of state.players) {
    if (p.team !== attacking) continue;
    const prev = previous.get(p.id) ?? null;
    if (p.role === 'GK') out.set(p.id, decideKeeper(att, p.id, prev)); // relance §8.6 s'il est porteur, sinon placement
    else if (owner && p.id === owner.id) out.set(p.id, policies[attacking].onBall(att, p.id, prev));
    else out.set(p.id, policies[attacking].offBall(att, p.id, prev));
  }
  // Règle collective §7.2 : au plus un appel en profondeur par bande latérale (les perdants gardent leur meilleur
  // candidat non-appel).
  allocateRuns(state, params, out, attacking, att);

  // --- Équipe défendante (gardien inclus par decideDefence ; sinon ajouté) ---
  const def = inputs[defending];
  const defence = policies[defending].defence(def, defending, previous);
  for (const [id, d] of defence) out.set(id, d);
  for (const p of state.players) {
    if (p.team !== defending || out.has(p.id)) continue;
    out.set(p.id, p.role === 'GK' ? decideKeeper(def, p.id, previous.get(p.id) ?? null) : freezeDecision(def, p));
  }

  // --- Ballon libre : receveur, sortie du gardien, chasseurs ---
  if (!owner) {
    const flight = ball.flight;
    const isPass = !!flight && (flight.kind === 'pass' || flight.kind === 'through' || flight.kind === 'lob');
    const kicker = flight ? state.players.find((p) => p.id === flight.kickerId) ?? null : null;
    const kickerTeam: TeamId | null = kicker ? kicker.team : null;
    let receiverId: number | null = null;
    if (isPass && flight!.targetId !== null) {
      const r = state.players.find((p) => p.id === flight!.targetId);
      if (r) {
        receiverId = r.id;
        const meet = receiveMeeting(state, params, r);
        const target = stableMeetingPoint(previous.get(r.id), 'receive', meet.point, { player: r, ball, params, time: meet.time });
        out.set(r.id, simpleMoveDecision(inputs[r.team], r, target, 'receive', r.maxSpeed, `Passe en cours vers ${r.name} : course au point de rencontre ${fmtPoint(target)}.`));
      }
    }
    // Sortie du gardien (decideKeeper : ballon libre dans sa surface, gardien premier dessus) : chasseur de son équipe.
    const chasers = new Set<number>();
    const keeperChasing: Record<TeamId, boolean> = { A: false, B: false };
    for (const p of state.players) {
      if (p.role !== 'GK') continue;
      const a = out.get(p.id)?.chosen.action;
      if (a?.type === 'move' && a.intent === 'chase') { chasers.add(p.id); keeperChasing[p.team] = true; }
    }
    // Classement des joueurs de champ ; le frappeur d'une passe encore sous immunité ne court pas après son propre ballon.
    const immune = isPass && kicker && state.time - flight!.startTime < params.physics.kickerImmunity ? kicker.id : -1;
    const ranked: Record<TeamId, ReturnType<typeof rankChasers>> = {
      A: rankChasers(state, params, 'A').filter((c) => c.id !== immune),
      B: rankChasers(state, params, 'B').filter((c) => c.id !== immune),
    };
    const bestA = ranked.A[0]?.time ?? Infinity, bestB = ranked.B[0]?.time ?? Infinity;
    const contested = Math.abs(bestA - bestB) < CONTESTED_MARGIN;
    for (const team of TEAMS) {
      // Passe avec receveur désigné : le receveur est le coureur de l'équipe du passeur, pas de second chasseur.
      if (receiverId !== null && kickerTeam === team) continue;
      const n = (contested ? 2 : 1) - (keeperChasing[team] ? 1 : 0);
      const intercepting = isPass && kickerTeam !== null && kickerTeam !== team;
      for (const c of ranked[team].slice(0, Math.max(0, n))) {
        if (c.id === receiverId) continue;
        const p = state.players.find((q) => q.id === c.id)!;
        const intent = intercepting ? 'intercept' : 'chase';
        const other = team === 'A' ? bestB : bestA;
        const reason = `${intent === 'intercept' ? 'Interception' : 'Course au ballon libre'} : ${p.name} rejoint le ballon en ${fmtFr(c.time, 1)} s (adversaire le plus rapide : ${Number.isFinite(other) ? fmtFr(other, 1) + ' s' : 'aucun'})${contested ? ', ballon disputé' : ''}.`;
        const target = stableMeetingPoint(previous.get(p.id), intent, c.point, { player: p, ball, params, time: c.time });
        out.set(p.id, simpleMoveDecision(inputs[team], p, target, intent, p.maxSpeed, reason));
        chasers.add(p.id);
      }
    }
    // Les tâches « chase / intercept » attribuées par la défense à d'autres joueurs sont rétrogradées vers leur meilleure
    // autre tâche (un seul chasseur par équipe, deux si le ballon est disputé).
    for (const p of state.players) {
      if (chasers.has(p.id) || p.id === receiverId) continue;
      const d = out.get(p.id)!;
      const a = d.chosen.action;
      if (a.type !== 'move' || (a.intent !== 'chase' && a.intent !== 'intercept')) continue;
      const alt = d.candidates.find((c) => c.action.type === 'move' && c.action.intent !== 'chase' && c.action.intent !== 'intercept');
      out.set(p.id, alt
        ? { ...d, chosen: alt, explanation: `${d.explanation}\nTâche de course au ballon confiée à un coéquipier plus rapide : repli sur ${alt.reason}.` }
        : freezeDecision(inputs[p.team], p));
    }
  }

  // --- Sécurité : chaque joueur a une décision ---
  for (const p of state.players) if (!out.has(p.id)) out.set(p.id, freezeDecision(inputs[p.team], p));
  return out;
}

/** Équipe attaquante courante (porteur, sinon possession), utile aux tests et à l'interface. */
export const attackingTeam = (state: MatchState): TeamId => {
  const o = state.ball.ownerId;
  if (o !== null) { const p = state.players.find((q) => q.id === o); if (p) return p.team; }
  return state.possession ?? 'A';
};

/** Direction d'attaque de l'équipe attaquante (ré-export pratique). */
export const attackingDir = (state: MatchState): 1 | -1 => attackDir(attackingTeam(state));
