/**
 * Coordonnateur (docs/CONCEPTION.md §13.2) : un cycle de décision complet pour les 22 joueurs.
 *  1. champs spatiaux : computeFields → state.fields (seule écriture dans l'état) ;
 *  2. équipe attaquante = équipe du porteur, sinon équipe en possession ;
 *  3. porteur → onBall ; coéquipiers → offBall (gardien → decideKeeper) ; équipe adverse → defence (gardien inclus) ;
 *  4. ballon libre : receveur désigné d'une passe → « receive » ; par équipe, le joueur au plus petit temps
 *     d'interception du ballon → « chase » / « intercept » (jusqu'à 2 par équipe si le ballon est disputé) ;
 *     les autres gardent leur comportement de phase ;
 *  5. gel de remise en jeu : tous les joueurs rejoignent leur poste (« hold_shape »), le remetteur conserve le ballon.
 * Retourne une décision pour CHAQUE joueur.
 */
import type { Decision, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam, TEAMS } from '../core/types';
import type { Rng } from '../core/rng';
import { computeFields } from '../models/fields';
import { slotPosition } from '../engine/match';
import { fmtFr, fmtPoint } from './explain';
import { decideDefence } from './defence';
import { decideKeeper } from './keeper';
import { rankChasers, receiveTarget, simpleHoldDecision, simpleMoveDecision } from './loose';
import { decideOffBall } from './offball';
import { decideOnBall } from './onball';
import type { DecisionInput, PolicySet } from './policy';

/** Écart (s) entre les meilleurs temps d'interception des deux équipes en deçà duquel le ballon est « disputé ». */
const CONTESTED_MARGIN = 0.5;
/** Vitesse (fraction de v_max) du retour au poste pendant un gel. */
const FREEZE_SPEED = 0.6;

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
  const target = slotPosition(input.state, p);
  return simpleMoveDecision(input, p, target, 'hold_shape', p.maxSpeed * FREEZE_SPEED, `Remise en jeu : retour au poste ${fmtPoint(target)} pendant le gel.`);
}

export function decideAll(state: MatchState, params: SimParams, policies: Record<TeamId, PolicySet>, previous: Map<number, Decision>, rng: Rng): Map<number, Decision> {
  state.fields = computeFields(state, params);
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
    if (owner && p.id === owner.id) out.set(p.id, policies[attacking].onBall(att, p.id, previous.get(p.id) ?? null));
    else if (p.role === 'GK') out.set(p.id, decideKeeper(att, p.id, previous.get(p.id) ?? null));
    else out.set(p.id, policies[attacking].offBall(att, p.id, previous.get(p.id) ?? null));
  }

  // --- Équipe défendante (gardien inclus par decideDefence ; sinon ajouté) ---
  const def = inputs[defending];
  const defence = policies[defending].defence(def, defending, previous);
  for (const [id, d] of defence) out.set(id, d);
  for (const p of state.players) {
    if (p.team !== defending || out.has(p.id)) continue;
    out.set(p.id, p.role === 'GK' ? decideKeeper(def, p.id, previous.get(p.id) ?? null) : freezeDecision(def, p));
  }

  // --- Ballon libre : receveur, chasseurs ---
  if (!owner) {
    const flight = ball.flight;
    const isPass = !!flight && (flight.kind === 'pass' || flight.kind === 'through' || flight.kind === 'lob');
    let receiverId: number | null = null;
    if (isPass && flight!.targetId !== null) {
      const r = state.players.find((p) => p.id === flight!.targetId);
      if (r) {
        receiverId = r.id;
        const target = receiveTarget(state, params, r);
        out.set(r.id, simpleMoveDecision(inputs[r.team], r, target, 'receive', r.maxSpeed, `Passe en cours vers ${r.name} : course au point de rencontre ${fmtPoint(target)}.`));
      }
    }
    const ranked: Record<TeamId, ReturnType<typeof rankChasers>> = { A: rankChasers(state, params, 'A'), B: rankChasers(state, params, 'B') };
    const bestA = ranked.A[0]?.time ?? Infinity, bestB = ranked.B[0]?.time ?? Infinity;
    const contested = Math.abs(bestA - bestB) < CONTESTED_MARGIN;
    const chasers = new Set<number>();
    for (const team of TEAMS) {
      const n = contested ? 2 : 1;
      const kickerTeam = flight ? state.players.find((p) => p.id === flight.kickerId)?.team ?? null : null;
      const intercepting = isPass && kickerTeam !== null && kickerTeam !== team;
      for (const c of ranked[team].slice(0, n)) {
        if (c.id === receiverId) continue;
        const p = state.players.find((q) => q.id === c.id)!;
        const intent = intercepting ? 'intercept' : 'chase';
        const other = team === 'A' ? bestB : bestA;
        const reason = `${intent === 'intercept' ? 'Interception' : 'Course au ballon libre'} : ${p.name} rejoint le ballon en ${fmtFr(c.time, 1)} s (adversaire le plus rapide : ${Number.isFinite(other) ? fmtFr(other, 1) + ' s' : 'aucun'})${contested ? ', ballon disputé' : ''}.`;
        out.set(p.id, simpleMoveDecision(inputs[team], p, c.point, intent, p.maxSpeed, reason));
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
