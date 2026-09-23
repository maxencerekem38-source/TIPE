/**
 * Gardien de but (docs/CONCEPTION.md §8.6) :
 *  - sans le ballon, équipe adverse en possession : placement sur la bissectrice de l'angle de tir, à une
 *    profondeur d_gk = min(keeperMaxDepth, keeperDepthFactor · d_ballon) de sa ligne, jamais hors de la surface de but ;
 *  - ballon libre dans sa surface de réparation et gardien premier dessus : sortie (« chase ») ;
 *  - équipe en possession : appui à 8 m de sa ligne dans l'axe (intention `gk_position`) ;
 *  - en possession du ballon : relance = passe vers l'un des 3 défenseurs les mieux placés (meilleure probabilité
 *    de passe) ou long ballon vers l'attaquant de pointe, choix par probabilité × menace ; jamais de dribble ni de sortie
 *    de la surface avec le ballon.
 * Repère : coordonnées terrain, direction d'attaque explicite (symétrie miroir A/B).
 */
import type { Vec2 } from '../core/vec2';
import { dist, normalize, add, sub } from '../core/vec2';
import { PITCH, goalPosts, ownGoalCentre, isInGoalArea, isInPenaltyArea } from '../core/pitch';
import { rollsIntoOwnGoal } from './candidates';
import type { Candidate, Decision, Player } from '../core/types';
import { attackDir } from '../core/types';
import { threatFor } from '../models/fields';
import { analyseInterception } from '../models/interception';
import { getPlayer, passProbability } from '../models/probability';
import { timeToArrive } from '../models/motion';
import { fmtFr, fmtPoint } from './explain';
import { component, decisionContext, makeDecision, simpleHoldDecision, simpleMoveDecision, timeToBall } from './loose';
import type { DecisionInput } from './policy';

/** Avance (m) du gardien devant sa ligne lorsque son équipe attaque. */
const SUPPORT_DEPTH = 8;
/** Profondeur minimale (m) devant la ligne (ne pas se coller au filet). */
const MIN_DEPTH = 0.8;
/** Nombre de défenseurs candidats à la relance courte. */
const SHORT_OPTIONS = 3;
/** Probabilité de conserver un long ballon aérien non intercepté (duel aérien 50/50, ballon aérien hors périmètre §13.6). */
const LONG_BALL_RETENTION = 0.5;
/** Vitesse d'arrivée (m/s) d'une relance courte. */
const SHORT_ARRIVAL = 6;
/** Vitesse de placement (fraction de v_max) hors urgence. */
const POSITION_SPEED = 0.8;

/** Point de placement sur la bissectrice de l'angle de tir (§8.6) : profondeur `depth` devant la ligne de but de `team`. */
export function bisectorPosition(ballPos: Vec2, team: Parameters<typeof attackDir>[0], depth: number): Vec2 {
  const dir = attackDir(team);
  const ownDir = (-dir) as 1 | -1; // but défendu = but « attaqué » dans la direction opposée
  const [p1, p2] = goalPosts(ownDir);
  const u = normalize(add(normalize(sub(p1, ballPos)), normalize(sub(p2, ballPos))));
  const goalX = -dir * PITCH.halfLength;
  const targetX = goalX + dir * Math.max(MIN_DEPTH, depth);
  let y: number;
  if (Math.abs(u.x) < 1e-6 || dir * (ballPos.x - targetX) <= 0) {
    // Ballon derrière la ligne cible (ou à sa hauteur) : on couvre le poteau le plus proche.
    y = Math.max(-PITCH.goalHalfWidth, Math.min(PITCH.goalHalfWidth, ballPos.y));
  } else {
    const t = (targetX - ballPos.x) / u.x;
    y = ballPos.y + t * u.y;
  }
  // Jamais hors de la surface de but.
  y = Math.max(-PITCH.goalAreaHalfWidth, Math.min(PITCH.goalAreaHalfWidth, y));
  return { x: targetX, y };
}

export function decideKeeper(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  void previous;
  const t0 = performance.now();
  const { state, params } = input;
  const keeper = getPlayer(state, playerId);
  const team = keeper.team;
  const dir = attackDir(team);
  const ball = state.ball;
  const ownGoal = ownGoalCentre(dir);

  // --- Relance ---
  if (ball.ownerId === playerId) return distribute(input, keeper, t0);

  const ownerTeam = ball.ownerId !== null ? getPlayer(state, ball.ownerId).team : null;
  const ownsBall = ownerTeam === team;

  // --- Ballon libre dans la surface : sortie si le gardien arrive le premier ---
  if (ball.ownerId === null && isInPenaltyArea(ball.pos, (-dir) as 1 | -1)) {
    const mine = timeToBall(keeper, ball, params);
    let opp = Infinity;
    for (const p of state.players) {
      if (p.team === team) continue;
      const t = timeToArrive(p.pos, p.vel, mine.point, p.maxSpeed, p.maxAccel, params.models);
      if (t < opp) opp = t;
    }
    // Sortie si le gardien arrive le premier, ou si le point de rencontre est dans sa surface de but : un ballon qui
    // traverse les six mètres est toujours attaqué (dernier rempart ; sinon un centre au sol roulait jusque dans le but).
    const inGoalArea = isInGoalArea(mine.point, (-dir) as 1 | -1);
    if (mine.time < opp || inGoalArea) {
      return simpleMoveDecision(input, keeper, mine.point, 'chase', keeper.maxSpeed,
        inGoalArea && mine.time >= opp
          ? `Ballon libre dans la surface de but : sortie systématique (gardien en ${fmtFr(mine.time, 1)} s, adversaire le plus rapide en ${fmtFr(Math.min(opp, 99), 1)} s).`
          : `Ballon libre dans la surface : le gardien arrive en ${fmtFr(mine.time, 1)} s, l’adversaire le plus rapide en ${fmtFr(Math.min(opp, 99), 1)} s.`, t0);
    }
  }

  // --- Équipe en possession : appui dans l'axe à 8 m de la ligne ---
  if (ownsBall || (ball.ownerId === null && state.possession === team && !(ball.flight && getPlayer(state, ball.flight.kickerId).team !== team))) {
    const target = { x: ownGoal.x + dir * SUPPORT_DEPTH, y: 0 };
    return simpleMoveDecision(input, keeper, target, 'gk_position', keeper.maxSpeed * POSITION_SPEED,
      `Équipe en possession : appui à ${SUPPORT_DEPTH} m de la ligne, dans l’axe.`, t0);
  }

  // --- Adversaire en possession (ou ballon libre chez l'adversaire) : bissectrice de l'angle de tir ---
  const dw = params.defence;
  const dBall = dist(ball.pos, ownGoal);
  const depth = Math.min(dw.keeperMaxDepth, dw.keeperDepthFactor * dBall);
  const target = bisectorPosition(ball.pos, team, depth);
  const urgent = dBall < 30;
  return simpleMoveDecision(input, keeper, target, 'gk_position', urgent ? keeper.maxSpeed : keeper.maxSpeed * POSITION_SPEED,
    `Bissectrice de l’angle de tir depuis ${fmtPoint(ball.pos)} (ballon à ${fmtFr(dBall, 0)} m), profondeur ${fmtFr(depth, 1)} m = min(${fmtFr(dw.keeperMaxDepth, 1)} ; ${fmtFr(dw.keeperDepthFactor, 2)} × ${fmtFr(dBall, 0)}).`, t0);
}

/** Relance du gardien : passes courtes vers les 3 défenseurs les mieux placés + long ballon vers l'attaquant de pointe. */
function distribute(input: DecisionInput, keeper: Player, t0: number): Decision {
  const { state, fields, params } = input;
  const team = keeper.team;
  const dir = attackDir(team);
  const candidates: Candidate[] = [];

  // Passes courtes : défenseurs (à défaut, n'importe quel coéquipier de champ), meilleures probabilités.
  const defenders = state.players.filter((p) => p.team === team && p.role === 'DF');
  const pool = defenders.length ? defenders : state.players.filter((p) => p.team === team && p.id !== keeper.id && p.role !== 'GK');
  // Une relance dont la course résiduelle franchirait la ligne de but (receveur collé au but) n'est pas une option.
  const shorts = pool.filter((p) => !rollsIntoOwnGoal(keeper.pos, p.pos, SHORT_ARRIVAL, team, params))
    .map((p) => ({ p, prob: passProbability(state, fields, keeper.id, p.id, p.pos, params, SHORT_ARRIVAL) }))
    .sort((a, b) => b.prob.p - a.prob.p)
    .slice(0, SHORT_OPTIONS);
  for (const s of shorts) {
    const threat = threatFor(fields, s.p.pos, team);
    const comps = [
      component('value', `Probabilité × menace (relance vers ${s.p.name})`, s.prob.p * threat, 1, 'but'),
    ];
    candidates.push({
      action: { type: 'pass', targetId: s.p.id, targetPoint: { x: s.p.pos.x, y: s.p.pos.y }, kind: 'ground', speed: SHORT_ARRIVAL },
      score: comps[0].contribution,
      probability: s.prob.p,
      valueIfSuccess: threat,
      valueIfFailure: 0,
      components: comps,
      reason: `Relance courte vers ${s.p.name} (${fmtFr(dist(keeper.pos, s.p.pos), 0)} m) : P ${fmtFr(s.prob.p)}, menace ${fmtFr(threat, 3)}`,
      threats: s.prob.interception?.threats,
      duration: s.prob.interception?.travelTime,
      successPoint: { x: s.p.pos.x, y: s.p.pos.y },
    });
  }

  // Long ballon vers l'attaquant de pointe (le coéquipier le plus avancé), ballon aérien.
  let striker: Player | null = null;
  for (const p of state.players) {
    if (p.team !== team || p.id === keeper.id || p.role === 'GK') continue;
    if (!striker || dir * p.pos.x > dir * striker.pos.x) striker = p;
  }
  if (striker) {
    const target = { x: striker.pos.x, y: striker.pos.y };
    const inter = analyseInterception(state, keeper.pos, target, 'lob', team, params);
    const p = (1 - inter.pIntercept) * LONG_BALL_RETENTION;
    const threat = threatFor(fields, target, team);
    const comps = [component('value', `Probabilité × menace (long ballon vers ${striker.name})`, p * threat, 1, 'but')];
    candidates.push({
      action: { type: 'pass', targetId: striker.id, targetPoint: target, kind: 'lob', speed: 0 },
      score: comps[0].contribution,
      probability: p,
      valueIfSuccess: threat,
      valueIfFailure: 0,
      components: comps,
      reason: `Long ballon vers ${striker.name} (${fmtFr(dist(keeper.pos, target), 0)} m) : P ${fmtFr(p)} (duel aérien), menace ${fmtFr(threat, 3)}`,
      threats: inter.threats,
      duration: inter.travelTime,
      successPoint: target,
    });
  }

  if (!candidates.length) return simpleHoldDecision(input, keeper, 'Aucune option de relance : conservation du ballon.', t0);
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const bestAction = best.action as Extract<Candidate['action'], { type: 'pass' }>;
  const alt = candidates[1];
  const lines = [
    `Relance : ${bestAction.kind === 'lob' ? 'long ballon' : 'passe courte'} vers ${getPlayer(state, bestAction.targetId).name} en ${fmtPoint(bestAction.targetPoint)} (score ${fmtFr(best.score, 3)} = P ${fmtFr(best.probability)} × menace ${fmtFr(best.valueIfSuccess, 3)}).`,
    `Options : ${candidates.length} (${shorts.length} passes courtes vers les défenseurs les mieux placés${striker ? ' + 1 long ballon' : ''}), critère probabilité × menace.`,
    alt ? `Alternative : ${alt.reason} (écart ${fmtFr(best.score - alt.score, 3)}).` : 'Aucune alternative.',
    'Le gardien ne quitte jamais sa surface avec le ballon (ni dribble ni tir).',
  ];
  return makeDecision(keeper.id, state.time, best, candidates, decisionContext(input, keeper), lines.join('\n'), t0);
}
