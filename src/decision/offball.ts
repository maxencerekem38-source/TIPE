/**
 * Déplacement des attaquants sans ballon (docs/CONCEPTION.md §7) : optimisation d'une utilité sur des
 * positions candidates (poste instancié, 8 directions × {6, 12, 20} m, points de course derrière la ligne
 * défensive), étiquette d'intention par terme dominant, hystérésis de cible, explication.
 *
 *   U(q) = w₁·P_pass(b→q)·xT(q) + w_sup·G(‖q−b‖ ; d_support) + w₂·[PC(q) − PC(p)] + w₃·ΔE_local(q)
 *          − w₄·‖q−s‖²/r_slot² − w₅·Σ_k e^{−‖q−p_k‖²/2r_sep²} − w₆·1[hors-jeu(q)] + w_run·2·runFrequency·1[course]
 *          − w_move·‖q − p‖
 *
 * Modulation tactique : widthUsage (élargit le poste, via slotPosition), supportDistance (bonus gaussien),
 * counterAttackBias (renforce les candidats vers l'avant en transition offensive), tempo (vitesse de consigne),
 * runFrequency (poids des appels), restDefenders (§7.2 : défenseurs de repos limités à leur poste).
 * Coût de déplacement w_move·‖q − p‖ (réalisme) : rester sur place est un vrai candidat, un déplacement n'est entrepris
 * que s'il rapporte plus que son coût (moins de kilomètres, cibles stables).
 * Hystérésis (§7.2) : la cible choisie est engagée pendant `reexamineEvery` s (`Decision.committedUntil`) avec le bonus
 * h_off ; atteinte (≤ 1,5 m), elle devient « tenir sa place » (le candidat sur place porte le bonus) jusqu'au ré-examen
 * forcé ; une cible au poste non atteinte suit le poste instancié (qui glisse avec le ballon). À la récupération du
 * ballon, la cible de la tâche défensive précédente garde une fraction `transitionHysteresis` du bonus pendant
 * `reexamineEvery` s (le joueur termine son mouvement au lieu de changer de cible à chaque bascule de possession).
 * Vitesse de consigne par intention (§7.2, réalisme) : appels au sprint, soutien / largeur / espace à une fraction de la
 * vitesse de tempo, conservation de la structure au trot (une cible lointaine accélère) ; une cible de conservation à
 * moins de `standDistance` m est remplacée par la position courante (le joueur tient sa place au lieu de ramper).
 * Repère : coordonnées terrain, direction d'attaque `dir` explicite (symétrie miroir A/B).
 */
import type { Vec2 } from '../core/vec2';
import { dist, dist2, sigmoid } from '../core/vec2';
import { PITCH, clampToPitch } from '../core/pitch';
import { ScalarField } from '../core/grid';
import type { Candidate, Decision, FieldSet, MatchState, MoveIntent, Player, ScoreComponent, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import { controlFor, threatFor, pressureOn } from '../models/fields';
import { arrivalLogistic } from '../models/interception';
import { ballTravelTime, launchSpeed, runTime } from '../models/motion';
import { getPlayer } from '../models/probability';
import { OFFSIDE_TOLERANCE, offsideLine } from '../models/structure';
import { FORMATIONS } from '../tactics/formations';
import { fmtFr, fmtPoint, INTENT_LABELS } from './explain';
import { component, decisionContext, makeDecision, moveCandidate, receiveMeeting, simpleMoveDecision, stableMeetingPoint, TARGET_MARGIN, teamSlot } from './loose';
import type { DecisionInput } from './policy';

// ---------------------------------------------------------------------------
// Constantes (§7)
// ---------------------------------------------------------------------------
/** Échantillons d'interception pour la valeur recevable (§7.1 : 6 au lieu de 12). */
const OFFBALL_INTERCEPT_SAMPLES = 6;
/** Nombre de candidats conservés dans la décision (les meilleurs). */
const KEPT_CANDIDATES = 6;
/** Bande des points de course derrière la ligne défensive : x' ∈ [ligne + RUN_MIN, ligne + RUN_MAX] (m). */
const RUN_MIN = 2;
const RUN_MAX = 16;
/** Distance maximale d'un point de course au joueur (m) et distance minimale (sinon c'est un candidat ordinaire). */
const RUN_REACH = 20;
const RUN_MIN_DIST = 5;
/** Nombre de points de course, séparation minimale entre eux (m). */
const RUN_POINTS = 2;
const RUN_SEPARATION = 6;
/** Rayon (m) du voisinage d'un candidat pour l'exposition locale. */
const EXPOSURE_RADIUS = 4;
/** Rayon (cellules) du voisinage lorsque les champs de danger sont absents. */
const PATCH_CELLS = 2;
/** Distance (m) sous laquelle le joueur est « déjà en place » (intention conservation de la structure). */
const IN_PLACE_DISTANCE = 2;
/** Cible atteinte (hystérésis, §7.2). */
const REACHED_DISTANCE = 1.5;
/** Une cible « conservation de la structure » à moins de cette distance (m) du poste courant suit le poste (qui glisse avec le ballon). */
const SLOT_TRACK_DISTANCE = 3;
/** Distance maximale (m) des candidats d'un défenseur de repos. */
const REST_RADIUS = 5;
/** Un candidat « en avant » du ballon de plus de cette avance (m) est un appel, pas un soutien. */
const AHEAD_FOR_RUN = 10;
/** Largeur (m, repère équipe) et distance au ballon au-delà desquelles le poste est une intention « largeur ». */
const WIDTH_MIN_Y = 15;
const WIDTH_MIN_BALL_DIST = 15;
/** Vitesse de tempo : v_max·(SPEED_BASE + SPEED_TEMPO·tempo) ; appels au sprint ; défauts des paramètres optionnels. */
const SPEED_BASE = 0.5;
const SPEED_TEMPO = 0.5;
const DEFAULT_MIN_SPEED = 2;
const DEFAULT_INTENT_SPEED: NonNullable<SimParams['offBall']['intentSpeed']> = { hold_shape: 0.35, support: 0.5, width: 0.5, exploit_space: 0.6, create_space: 0.6 };
const DEFAULT_STAND_DISTANCE = 1.5;
/** Une cible au-delà de SPEED_FAR_START m accélère linéairement jusqu'à la vitesse de tempo à SPEED_FAR_FULL m. */
const SPEED_FAR_START = 5;
const SPEED_FAR_FULL = 20;
/** Renforcement des candidats vers l'avant en transition offensive : (1 + COUNTER_GAIN·counterAttackBias). */
const COUNTER_GAIN = 1.5;
/** w_run ← w_run · RUN_FREQ_GAIN · runFrequency (§13.3). */
const RUN_FREQ_GAIN = 2;
/** Écart-type relatif du bonus de soutien (σ = supportDistance·SUPPORT_SIGMA, au moins SUPPORT_SIGMA_MIN m). */
const SUPPORT_SIGMA = 0.5;
const SUPPORT_SIGMA_MIN = 3;
const DEFAULT_W_SUPPORT = 0.1;
/** Un ailier est un milieu dont le poste est à au moins cette distance de l'axe (m). */
const WINGER_MIN_Y = 20;
/** Seuil de gain d'un terme pour être « dominant » (sinon : conservation de la structure). */
const DOMINANCE_EPS = 1e-4;
/** Défauts des paramètres optionnels : coût de déplacement (utilité/m), fraction d'hystérésis à la récupération du ballon. */
const DEFAULT_W_MOVE = 0.015;
const DEFAULT_TRANSITION_HYSTERESIS = 0.5;

type CandidateKind = 'stay' | 'slot' | 'move' | 'run' | 'previous';

interface Point { q: Vec2; kind: CandidateKind }

const LABELS: Record<string, string> = {
  receivable: 'Valeur recevable (P_passe × menace)',
  support: 'Distance de soutien',
  space: 'Gain d’espace (contrôle)',
  exposure: 'Exposition créée (danger local)',
  slot: 'Rappel au poste',
  separation: 'Séparation des coéquipiers',
  offside: 'Hors-jeu',
  run: 'Appel en profondeur',
  hysteresis: 'Hystérésis (cible engagée)',
  move: 'Coût de déplacement',
};

// ---------------------------------------------------------------------------
// Valeur recevable : probabilité de passe rapide (§5.1 avec 6 échantillons, §7.1)
// ---------------------------------------------------------------------------
/** Zone de travail réutilisée (aucune allocation par candidat) : temps balle et points d'échantillonnage. */
const sampleT = new Float64Array(OFFBALL_INTERCEPT_SAMPLES);
const sampleX = new Float64Array(OFFBALL_INTERCEPT_SAMPLES);
const sampleY = new Float64Array(OFFBALL_INTERCEPT_SAMPLES);
/** Un adversaire dont le meilleur temps d'arrivée sur la ligne dépasse T_b + PRUNE_SIGMAS·σ_T a un Φ négligeable partout. */
const PRUNE_SIGMAS = 3;

/**
 * Probabilité de passe « rapide » de `from` vers `q` pour `team` (§5.1) : mêmes formules que passProbability
 * (interception produit sur M = 6 échantillons, logistique distance/pressions) mais pressions lues sur la grille,
 * sans terme d'attribut du passeur, sans allocation, avec élagage des adversaires trop loin de la ligne de passe.
 */
export function quickPassProbability(state: MatchState, fields: FieldSet, from: Vec2, q: Vec2, team: TeamId, params: SimParams): { p: number; pIntercept: number } {
  const m = params.models;
  const ph = params.physics;
  const dx = q.x - from.x, dy = q.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const c = m.pass;
  const M = Math.max(1, Math.min(OFFBALL_INTERCEPT_SAMPLES, Math.floor(m.interceptSamples)));
  const s0 = launchSpeed(d, ph.passArrivalSpeed, ph);
  const total = ballTravelTime(d, s0, ph);
  for (let s = 0; s < M; s++) {
    const f = (s + 1) / M;
    sampleT[s] = ballTravelTime(f * d, s0, ph);
    sampleX[s] = from.x + dx * f;
    sampleY[s] = from.y + dy * f;
  }
  const eta = m.interceptEfficiency;
  const invSigma = 1 / Math.max(1e-6, m.arrivalSigma);
  const tau = m.reactionTime;
  const limit = total + PRUNE_SIGMAS * m.arrivalSigma;
  const invL2 = d > 1e-9 ? 1 / (d * d) : 0;
  let survive = 1;
  const players = state.players;
  for (let k = 0; k < players.length; k++) {
    const o = players[k];
    if (o.team === team) continue;
    // Élagage : distance du point de départ effectif (p + τ v) au segment [from, q].
    const px = o.pos.x + tau * o.vel.x, py = o.pos.y + tau * o.vel.y;
    let t = invL2 > 0 ? ((px - from.x) * dx + (py - from.y) * dy) * invL2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = from.x + dx * t - px, ey = from.y + dy * t - py;
    if (tau + runTime(Math.sqrt(ex * ex + ey * ey), o.maxSpeed, o.maxAccel) > limit) continue;
    for (let s = 0; s < M; s++) {
      // Temps d'arrivée inliné (= timeToArrive depuis le départ effectif p + τ v, sans allocation).
      const sx = sampleX[s] - px, sy = sampleY[s] - py;
      const T = tau + runTime(Math.sqrt(sx * sx + sy * sy), o.maxSpeed, o.maxAccel);
      survive *= 1 - eta * arrivalLogistic((sampleT[s] - T) * invSigma);
    }
  }
  const pIntercept = Math.min(1, Math.max(0, 1 - survive));
  const logit = c.base + c.distance * d + c.longDistance * Math.max(0, d - 30) + c.passerPressure * pressureOn(fields, from, team) + c.receiverPressure * pressureOn(fields, q, team);
  return { p: (1 - pIntercept) * sigmoid(logit), pIntercept };
}

/** Danger moyen (xT·PC_att) sur un voisinage carré autour de q, lu sur la grille (exposition locale). */
function localDanger(fields: FieldSet, q: Vec2, team: TeamId): number {
  const field: ScalarField | undefined = team === 'A' ? fields.dangerA : fields.dangerB;
  if (!field) return threatFor(fields, q, team) * controlFor(fields, q, team);
  const cs = field.cellSize;
  const r = Math.max(1, Math.round(EXPOSURE_RADIUS / cs)) || PATCH_CELLS;
  const ci = Math.round((q.x + PITCH.halfLength) / cs);
  const cj = Math.round((q.y + PITCH.halfWidth) / cs);
  const i0 = Math.max(0, ci - r), i1 = Math.min(field.cols - 1, ci + r);
  const j0 = Math.max(0, cj - r), j1 = Math.min(field.rows - 1, cj + r);
  let s = 0, n = 0;
  const data = field.data;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { s += data[j * field.cols + i]; n++; }
  return n > 0 ? s / n : 0;
}

/** Le joueur est-il un « défenseur de repos » (§7.2) : parmi les `n` joueurs de champ les plus reculés de son équipe ? */
export function isRestDefender(state: MatchState, player: Player, n: number): boolean {
  if (n <= 0 || player.role === 'GK') return false;
  const dir = attackDir(player.team);
  const mine = dir * player.pos.x;
  let behind = 0;
  for (const p of state.players) {
    if (p.team !== player.team || p.role === 'GK' || p.id === player.id) continue;
    const x = dir * p.pos.x;
    if (x < mine || (x === mine && p.id < player.id)) behind++;
  }
  return behind < n;
}

/** Attaquant ou ailier (candidat aux appels en profondeur). */
export function isRunner(state: MatchState, player: Player): boolean {
  if (player.role === 'FW') return true;
  if (player.role !== 'MF') return false;
  const slot = FORMATIONS[state.tactics[player.team].formation].slots[player.slotIndex];
  return !!slot && Math.abs(slot.y) >= WINGER_MIN_Y;
}

/**
 * Points de course derrière la ligne défensive (§7.1) : cellules de plus grand danger dans la bande
 * x' ∈ [ligne + 2, ligne + 16] (repère équipe), devant le ballon, à ≤ 20 m du joueur, séparées d'au moins 6 m.
 */
export function deepRunPoints(state: MatchState, fields: FieldSet, player: Player, max = RUN_POINTS): Vec2[] {
  const team = player.team;
  const dir = attackDir(team);
  const lineTeam = dir * offsideLine(state, team);
  const ballTeam = dir * state.ball.pos.x;
  const danger = team === 'A' ? fields.dangerA : fields.dangerB;
  const field = danger ?? fields.controlA;
  const threat = team === 'A' ? fields.threatA : fields.threatB;
  const cs = field.cellSize;
  const xMin = lineTeam + RUN_MIN, xMax = Math.min(lineTeam + RUN_MAX, PITCH.halfLength - TARGET_MARGIN);
  if (xMin >= xMax) return [];
  const best: { x: number; y: number; d: number }[] = [];
  const reach2 = RUN_REACH * RUN_REACH, minD2 = RUN_MIN_DIST * RUN_MIN_DIST;
  // Fenêtre de cellules : bande en x (repère terrain) × portée du joueur en y.
  const xLo = dir > 0 ? Math.max(xMin, ballTeam) : -xMax, xHi = dir > 0 ? xMax : Math.min(-xMin, -ballTeam);
  const i0 = Math.max(0, Math.ceil((xLo + PITCH.halfLength) / cs)), i1 = Math.min(field.cols - 1, Math.floor((xHi + PITCH.halfLength) / cs));
  const j0 = Math.max(0, Math.ceil((player.pos.y - RUN_REACH + PITCH.halfWidth) / cs)), j1 = Math.min(field.rows - 1, Math.floor((player.pos.y + RUN_REACH + PITCH.halfWidth) / cs));
  for (let j = j0; j <= j1; j++) {
    const y = field.yOf(j);
    if (Math.abs(y) > PITCH.halfWidth - TARGET_MARGIN) continue;
    for (let i = i0; i <= i1; i++) {
      const x = field.xOf(i);
      const xt = dir * x;
      if (xt < xMin || xt > xMax || xt <= ballTeam) continue;
      const dx = x - player.pos.x, dy = y - player.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2 || d2 < minD2) continue;
      const idx = j * field.cols + i;
      const d = danger ? danger.data[idx] : threat.data[idx] * (team === 'A' ? field.data[idx] : 1 - field.data[idx]);
      // Insertion dans la liste des meilleurs (au plus `max`), avec séparation minimale.
      let k = best.length;
      while (k > 0 && best[k - 1].d < d) k--;
      if (k >= max) continue;
      let tooClose = false;
      for (let m = 0; m < k; m++) if (dist2(best[m], { x, y }) < RUN_SEPARATION * RUN_SEPARATION) { tooClose = true; break; }
      if (tooClose) continue;
      best.splice(k, 0, { x, y, d });
      // Retire les suivants trop proches du nouveau point.
      for (let m = best.length - 1; m > k; m--) if (dist2(best[m], { x, y }) < RUN_SEPARATION * RUN_SEPARATION) best.splice(m, 1);
      if (best.length > max) best.length = max;
    }
  }
  return best.map((b) => ({ x: b.x, y: b.y }));
}

/** Passeur virtuel : le porteur s'il est de l'équipe, sinon le coéquipier le plus proche du ballon (ballon libre). */
function passerOf(state: MatchState, player: Player): Player | null {
  const owner = state.ball.ownerId;
  if (owner !== null) {
    const o = getPlayer(state, owner);
    return o.team === player.team && o.id !== player.id ? o : null;
  }
  let best: Player | null = null, bestD = Infinity;
  for (const p of state.players) {
    if (p.team !== player.team || p.id === player.id) continue;
    const d = dist2(p.pos, state.ball.pos);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Position de départ de la passe : le ballon si le passeur le possède, sinon la position du passeur. */
const passOrigin = (state: MatchState, passer: Player): Vec2 => (state.ball.ownerId === passer.id ? state.ball.pos : passer.pos);

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------
/** Intentions produites par la décision hors-ballon (engagement porté par `committedUntil`). */
const OFFBALL_INTENTS = new Set<MoveIntent>(['support', 'run', 'width', 'create_space', 'exploit_space', 'hold_shape']);
/** Tâches défensives dont la cible est terminée (bonus réduit) après une récupération du ballon ; les courses au ballon
 * (chase / intercept / receive) et le gardien n'en font pas partie. */
const DEFENSIVE_INTENTS = new Set<MoveIntent>(['recover', 'zone', 'mark', 'cover', 'press']);

export function decideOffBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  const t0 = performance.now();
  const { state, fields, params, tactic } = input;
  const w = params.offBall;
  const tp = tactic.params;
  const player = getPlayer(state, playerId);
  const team = player.team;
  const dir = attackDir(team);
  const ball = state.ball.pos;
  const phase = state.phase[team];
  const pos = player.pos;

  // Receveur d'une passe en cours : intention « réception » (le coordonnateur l'impose aussi).
  const flight = state.ball.flight;
  if (state.ball.ownerId === null && flight && flight.targetId === playerId && (flight.kind === 'pass' || flight.kind === 'through' || flight.kind === 'lob')) {
    return decideReceive(input, playerId, previous);
  }

  const passer = passerOf(state, player);
  const origin = passer ? passOrigin(state, passer) : ball;
  const slot = teamSlot(state, player);
  const rest = isRestDefender(state, player, tp.restDefenders);
  // Ligne de hors-jeu (repère équipe) calculée une fois : hors-jeu(q) ⇔ x'_q > 0 et x'_q > ligne + tolérance (§3.4).
  const offLine = dir * offsideLine(state, team) + OFFSIDE_TOLERANCE;
  const offside = (q: Vec2): boolean => dir * q.x > 0 && dir * q.x > offLine;
  const runner = !rest && isRunner(state, player) && !offside(pos);
  const counter = phase === 'transition_attack' ? 1 + COUNTER_GAIN * tp.counterAttackBias : 1;
  const wRun = w.wRun * RUN_FREQ_GAIN * tp.runFrequency * counter;
  const wSupport = w.wSupport ?? DEFAULT_W_SUPPORT;
  const sigmaSupport = Math.max(SUPPORT_SIGMA_MIN, SUPPORT_SIGMA * tp.supportDistance);
  const invTwoSigma2 = 1 / (2 * sigmaSupport * sigmaSupport);
  const invSlot2 = 1 / (w.slotRadius * w.slotRadius);
  const invTwoSep2 = 1 / (2 * w.separationRadius * w.separationRadius);
  const wMove = w.wMove ?? DEFAULT_W_MOVE;
  const ballDistPos = dist(pos, ball);

  // --- 1. Positions candidates ---
  const points: Point[] = [{ q: { x: pos.x, y: pos.y }, kind: 'stay' }];
  const pushPoint = (q: Vec2, kind: CandidateKind): void => {
    const c = clampToPitch(q, TARGET_MARGIN);
    for (const p of points) if (dist2(p.q, c) < 0.25) return;
    points.push({ q: c, kind });
  };
  if (!rest || dist(slot, pos) <= REST_RADIUS) pushPoint(slot, 'slot');
  else pushPoint({ x: pos.x + (slot.x - pos.x) * (REST_RADIUS / dist(slot, pos)), y: pos.y + (slot.y - pos.y) * (REST_RADIUS / dist(slot, pos)) }, 'slot');
  const nDir = Math.max(1, Math.floor(w.candidateDirections));
  for (const d of w.candidateDistances) {
    if (rest && d > REST_RADIUS) continue;
    for (let k = 0; k < nDir; k++) {
      const a = (2 * Math.PI * k) / nDir;
      pushPoint({ x: pos.x + d * Math.cos(a), y: pos.y + d * Math.sin(a) }, 'move');
    }
  }
  if (runner) for (const q of deepRunPoints(state, fields, player)) pushPoint(q, 'run');

  // Hystérésis (§7.2) : la cible précédente reste engagée (bonus h_off) jusqu'à `committedUntil` (ré-examen forcé toutes
  // les reexamineEvery s, échéance portée par la décision et héritée tant que la cible est conservée). Atteinte (≤ 1,5 m),
  // elle devient « rester sur place » : le candidat sur place porte alors le bonus, le joueur tient sa position (il ne
  // rampe pas derrière le poste qui glisse) ; une cible au poste non atteinte suit le poste instancié.
  // Récupération du ballon : la tâche défensive précédente (repli, zone, marquage…) est terminée avec un bonus réduit.
  let prevTarget: Vec2 | null = null;
  let inheritedDeadline: number | undefined;
  let hysteresisBonus = w.hysteresis;
  const prevAction = previous && previous.playerId === playerId ? previous.chosen.action : null;
  if (prevAction && prevAction.type === 'move') {
    const transitionGain = w.transitionHysteresis ?? DEFAULT_TRANSITION_HYSTERESIS;
    if (OFFBALL_INTENTS.has(prevAction.intent)) {
      if (previous!.committedUntil !== undefined && state.time < previous!.committedUntil) inheritedDeadline = previous!.committedUntil;
    } else if (transitionGain > 0 && DEFENSIVE_INTENTS.has(prevAction.intent) && state.time - previous!.time < w.reexamineEvery) {
      inheritedDeadline = previous!.time + w.reexamineEvery;
      hysteresisBonus *= transitionGain;
    }
    if (inheritedDeadline !== undefined) {
      if (dist(prevAction.target, pos) <= REACHED_DISTANCE) prevTarget = points[0].q;
      else if (prevAction.intent === 'hold_shape' && dist(prevAction.target, slot) <= SLOT_TRACK_DISTANCE) {
        // Cible au poste (conservation de la structure) : elle suit le poste instancié, qui glisse continûment avec le ballon.
        prevTarget = slot;
        for (const p of points) if (p.kind === 'slot') { p.kind = 'previous'; break; }
      } else {
        prevTarget = prevAction.target;
        const kind: CandidateKind = prevAction.intent === 'run' ? 'run' : 'previous';
        let dup = false;
        for (const p of points) if (dist2(p.q, prevTarget) < 0.25) { p.kind = p.kind === 'stay' ? 'stay' : kind === 'run' ? 'run' : p.kind; dup = true; break; }
        if (!dup) points.push({ q: clampToPitch(prevTarget, TARGET_MARGIN), kind });
      }
    }
  }

  // --- 2. Évaluation ---
  const controlPos = controlFor(fields, pos, team);
  const dangerPos = localDanger(fields, pos, team);
  const evaluated: { c: Candidate; kind: CandidateKind; q: Vec2; pPass: number }[] = [];
  for (const pt of points) {
    const q = pt.q;
    const isRun = pt.kind === 'run';
    const forward = dir * (q.x - ball.x) > 0;
    const pass = passer ? quickPassProbability(state, fields, origin, q, team, params) : { p: 0, pIntercept: 1 };
    const threat = threatFor(fields, q, team);
    const dBall = dist(q, ball);
    const support = isRun ? 0 : Math.exp(-((dBall - tp.supportDistance) ** 2) * invTwoSigma2);
    const space = controlFor(fields, q, team) - controlPos;
    const exposure = localDanger(fields, q, team) - dangerPos;
    const slotPen = dist2(q, slot) * invSlot2;
    let sep = 0;
    for (const p of state.players) {
      if (p.team !== team || p.id === playerId) continue;
      sep += Math.exp(-dist2(q, p.pos) * invTwoSep2);
    }
    const off = isRun ? 0 : offside(q) ? 1 : 0;
    const wRecv = w.wReceivable * (forward ? counter : 1);
    const comps: ScoreComponent[] = [
      component('receivable', LABELS.receivable, pass.p * threat, wRecv, 'but'),
      component('support', LABELS.support, support, wSupport),
      component('space', LABELS.space, space, w.wSpace),
      component('exposure', LABELS.exposure, exposure, w.wTeamExposure),
      component('slot', LABELS.slot, slotPen, -w.wSlot),
      component('separation', LABELS.separation, sep, -w.wSeparation),
      component('offside', LABELS.offside, off, -w.wOffside),
      component('run', LABELS.run, isRun ? 1 : 0, wRun),
      component('move', LABELS.move, dist(q, pos), -wMove, 'm'),
    ];
    if (prevTarget && dist2(q, prevTarget) < 0.25) comps.push(component('hysteresis', LABELS.hysteresis, 1, hysteresisBonus));
    const c = moveCandidate(q, 'hold_shape', 0, comps, '', {
      probability: pass.p,
      valueIfSuccess: threat,
      valueIfFailure: 0,
      successPoint: q,
    });
    evaluated.push({ c, kind: pt.kind, q, pPass: pass.p });
  }

  // --- 3. Sélection, intention, vitesse ---
  evaluated.sort((a, b) => b.c.score - a.c.score);
  const stay = evaluated.find((e) => e.kind === 'stay')!;
  const best = evaluated[0];
  const keptByHysteresis = !!prevTarget && best.c.components.some((c) => c.key === 'hysteresis');
  const intent = classifyIntent(best, stay, pos, ball, dir, slot);
  const standDistance = w.standDistance ?? DEFAULT_STAND_DISTANCE;

  // Intentions, vitesses et raisons construites pour les seuls candidats conservés (coût maîtrisé, §7.1).
  const kept = evaluated.slice(0, KEPT_CANDIDATES);
  for (const e of kept) {
    const it = e === best ? intent : classifyIntent(e, stay, pos, ball, dir, slot);
    const dTarget = dist(e.q, pos);
    // Conservation de la structure à moins de standDistance : le joueur tient sa place (cible = position courante).
    const target = it === 'hold_shape' && dTarget < standDistance ? { x: pos.x, y: pos.y } : e.c.action.type === 'move' ? e.c.action.target : e.q;
    e.c.action = { type: 'move', target, intent: it, speed: offBallSpeed(player, it, dTarget, tp.tempo, params, e.kind === 'run') };
    e.c.reason = candidateReason(e.c, it, e.q, pos, ball, e.pPass);
  }
  const candidates = kept.map((e) => e.c);
  const explanation = explain(best.c, evaluated[1]?.c, intent, pos, ball, keptByHysteresis, ballDistPos, hysteresisBonus);
  // Engagement (§7.2) : une cible conservée hérite de son échéance, une nouvelle cible ouvre une fenêtre de reexamineEvery s.
  const committedUntil = keptByHysteresis && inheritedDeadline !== undefined ? inheritedDeadline : state.time + w.reexamineEvery;
  return makeDecision(playerId, state.time, best.c, candidates, decisionContext(input, player), explanation, t0, { keptByHysteresis: keptByHysteresis || undefined, committedUntil });
}

/**
 * Vitesse de consigne (m/s) d'un déplacement sans ballon : appel derrière la ligne (`deepRun`) et réception = sprint ;
 * sinon fraction `intentSpeed[intent]` de la vitesse de tempo v_max·(0,5 + 0,5·tempo) (1 pour un appel ordinaire devant
 * le ballon), fraction qui tend linéairement vers 1 entre SPEED_FAR_START et SPEED_FAR_FULL m (une cible lointaine est une
 * course, une cible proche un replacement), bornée par `minSpeed`.
 */
export function offBallSpeed(player: Player, intent: MoveIntent, distance: number, tempo: number, params: SimParams, deepRun = intent === 'run'): number {
  if (deepRun || intent === 'receive') return player.maxSpeed;
  const w = params.offBall;
  const tempoSpeed = player.maxSpeed * (SPEED_BASE + SPEED_TEMPO * tempo);
  const table = w.intentSpeed ?? DEFAULT_INTENT_SPEED;
  const base = (table as Partial<Record<MoveIntent, number>>)[intent] ?? 1;
  const far = Math.max(0, Math.min(1, (distance - SPEED_FAR_START) / (SPEED_FAR_FULL - SPEED_FAR_START)));
  const factor = base + (1 - base) * far;
  return Math.min(player.maxSpeed, Math.max(w.minSpeed ?? DEFAULT_MIN_SPEED, tempoSpeed * factor));
}

/** Décision « réception » : le receveur désigné court vers le point de rencontre avec le ballon. */
export function decideReceive(input: DecisionInput, playerId: number, previous: Decision | null = null): Decision {
  const player = getPlayer(input.state, playerId);
  const meet = receiveMeeting(input.state, input.params, player);
  const target = stableMeetingPoint(previous, 'receive', meet.point, { player, ball: input.state.ball, params: input.params, time: meet.time });
  return simpleMoveDecision(input, player, target, 'receive', player.maxSpeed, `Passe en cours vers ${player.name} : course au point de rencontre ${fmtPoint(target)}.`);
}

/** Étiquette de mouvement = terme dont le gain par rapport au maintien sur place est le plus grand (§7.1). */
function classifyIntent(e: { c: Candidate; kind: CandidateKind; q: Vec2 }, stay: { c: Candidate }, pos: Vec2, ball: Vec2, dir: 1 | -1, slot: Vec2): MoveIntent {
  if (e.kind === 'stay' || dist(e.q, pos) < IN_PLACE_DISTANCE) return 'hold_shape';
  if (e.kind === 'run') return 'run';
  let bestKey = 'slot', bestGain = -Infinity;
  for (const c of e.c.components) {
    if (c.key === 'hysteresis' || c.key === 'offside' || c.key === 'run') continue;
    const s = stay.c.components.find((x) => x.key === c.key);
    const gain = c.contribution - (s ? s.contribution : 0);
    if (gain > bestGain) { bestGain = gain; bestKey = c.key; }
  }
  if (bestGain < DOMINANCE_EPS) bestKey = 'slot';
  switch (bestKey) {
    case 'receivable':
    case 'support':
      return dir * (e.q.x - ball.x) > AHEAD_FOR_RUN ? 'run' : 'support';
    case 'space':
      return 'exploit_space';
    case 'exposure':
    case 'separation':
      return dist(e.q, ball) > dist(pos, ball) ? 'create_space' : 'exploit_space';
    default: {
      const wide = Math.abs(dir * e.q.y) >= WIDTH_MIN_Y && dist(e.q, ball) > WIDTH_MIN_BALL_DIST && dist2(e.q, slot) < 1;
      return wide ? 'width' : 'hold_shape';
    }
  }
}

function candidateReason(c: Candidate, intent: MoveIntent, q: Vec2, pos: Vec2, ball: Vec2, pPass: number): string {
  let main = c.components[0];
  for (const x of c.components) if (x.key !== 'hysteresis' && Math.abs(x.contribution) > Math.abs(main.contribution)) main = x;
  return `${INTENT_LABELS[intent]} à ${Math.round(dist(q, pos))} m (${Math.round(dist(q, ball))} m du ballon) : P_passe ${fmtFr(pPass)} ; ${main.label} ${fmtFr(main.contribution, 3, true)}`.slice(0, 140);
}

function explain(best: Candidate, second: Candidate | undefined, intent: MoveIntent, pos: Vec2, ball: Vec2, kept: boolean, ballDist: number, bonus: number): string {
  const target = best.action.type === 'move' ? best.action.target : pos;
  const sorted = [...best.components].sort((a, b) => b.contribution - a.contribution);
  const positives = sorted.filter((c) => c.contribution > 1e-6).slice(0, 2);
  const negatives = sorted.filter((c) => c.contribution < -1e-6).slice(-2).reverse();
  const lines: string[] = [];
  lines.push(`Intention : ${INTENT_LABELS[intent]} — cible ${fmtPoint(target)}, à ${fmtFr(dist(target, pos), 1)} m (ballon à ${fmtFr(ballDist, 0)} m), utilité ${fmtFr(best.score, 3)}.`);
  lines.push(positives.length
    ? `Pour : ${positives.map((c) => `${fmtFr(c.contribution, 3, true)} ${c.label.toLowerCase()}`).join(', ')}.`
    : 'Pour : aucun terme attractif, le poste prime.');
  lines.push(negatives.length
    ? `Contre : ${negatives.map((c) => `${fmtFr(c.contribution, 3, true)} ${c.label.toLowerCase()}`).join(', ')}.`
    : 'Contre : aucune pénalité notable.');
  if (kept) lines.push(`Cible conservée par hystérésis (engagement jusqu’à l’arrivée, au ré-examen forcé ou à un meilleur candidat de +${fmtFr(bonus, 2)}).`);
  else if (second && second.action.type === 'move') lines.push(`Alternative : ${INTENT_LABELS[second.action.intent]} vers ${fmtPoint(second.action.target)} (écart ${fmtFr(best.score - second.score, 3)}).`);
  return lines.join('\n');
}
