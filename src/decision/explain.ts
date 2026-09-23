/**
 * Génération des explications en français à partir de la décomposition additive des scores (§6.6).
 *
 * L'explication n'est jamais un texte libre : elle trie les termes additifs (`Candidate.components`)
 * et compare, pour chaque alternative, le terme qui creuse le plus grand écart avec l'action choisie.
 * Ce module ne dépend que des types partagés : il est utilisable par l'interface pour toute décision
 * (porteur, déplacement sans ballon, défense).
 */
import type { Vec2 } from '../core/vec2';
import type { Action, Candidate, Decision, MatchState, MoveIntent, ScoreComponent, TeamId } from '../core/types';
import { attackDir } from '../core/types';

// ---------------------------------------------------------------------------
// Formatage français
// ---------------------------------------------------------------------------
/** Nombre à `digits` décimales, virgule décimale, signe « − » typographique, « + » optionnel. */
export function fmtFr(x: number, digits = 2, signed = false): string {
  if (!Number.isFinite(x)) return '—';
  const abs = Math.abs(x).toFixed(digits).replace('.', ',');
  const zero = Number(Math.abs(x).toFixed(digits)) === 0;
  if (x < 0 && !zero) return '−' + abs;
  if (signed && x > 0 && !zero) return '+' + abs;
  return abs;
}

/** Pourcentage entier « 81 % ». */
export const fmtPct = (p: number): string => (Number.isFinite(p) ? `${Math.round(p * 100)} %` : '—');

/** Point « (12,3 ; −4,0) ». */
export const fmtPoint = (p: Vec2): string => `(${fmtFr(p.x, 1)} ; ${fmtFr(p.y, 1)})`;

/** « n°7 » du joueur `id` (ou « n°? » s'il est inconnu dans l'état). */
export function playerNumber(state: MatchState, id: number): string {
  const direct = state.players[id];
  const p = direct && direct.id === id ? direct : state.players.find((q) => q.id === id);
  return p ? `n°${p.number}` : 'n°?';
}

export const INTENT_LABELS: Record<MoveIntent, string> = {
  support: 'soutien',
  run: 'appel en profondeur',
  width: 'largeur',
  create_space: 'création d’espace',
  exploit_space: 'exploitation d’un espace',
  hold_shape: 'conservation de la structure',
  press: 'pressing',
  mark: 'marquage',
  cover: 'couverture',
  zone: 'zone',
  recover: 'repli',
  intercept: 'interception',
  chase: 'course au ballon',
  gk_position: 'placement du gardien',
  receive: 'réception',
};

// ---------------------------------------------------------------------------
// Directions (repère équipe : +x = vers le but adverse, y < 0 = gauche)
// ---------------------------------------------------------------------------
const DIRECTION_LABELS = ['vers l’avant', 'en diagonale avant droite', 'vers la droite', 'en diagonale arrière droite', 'vers l’arrière', 'en diagonale arrière gauche', 'vers la gauche', 'en diagonale avant gauche'];
const DIRECTION_ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

/** Secteur de 45° d'une direction dans le repère équipe (0 = avant, 2 = droite, 4 = arrière, 6 = gauche). */
function directionSector(direction: Vec2, team: TeamId): number {
  const dir = attackDir(team);
  const angle = Math.atan2(dir * direction.y, dir * direction.x);
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}

/** « vers l'avant », « en diagonale avant gauche »… */
export const directionLabel = (direction: Vec2, team: TeamId): string => DIRECTION_LABELS[directionSector(direction, team)];
/** Flèche compacte (→ = vers le but adverse). */
export const directionArrow = (direction: Vec2, team: TeamId): string => DIRECTION_ARROWS[directionSector(direction, team)];

/** Joueur `id` de l'état (indexation directe, sinon recherche), undefined s'il est inconnu. */
function findPlayer(state: MatchState, id: number): MatchState['players'][number] | undefined {
  const direct = state.players[id];
  return direct && direct.id === id ? direct : state.players.find((q) => q.id === id);
}

/** Équipe d'un candidat : celle du joueur `playerId` s'il est connu, sinon celle du porteur, sinon l'équipe en possession (A par défaut). */
function teamOf(state: MatchState, playerId: number | undefined): TeamId {
  if (playerId !== undefined) {
    const p = findPlayer(state, playerId);
    if (p) return p.team;
  }
  const owner = state.ball.ownerId !== null ? findPlayer(state, state.ball.ownerId) : undefined;
  return owner?.team ?? state.possession ?? 'A';
}

// ---------------------------------------------------------------------------
// Libellés d'action
// ---------------------------------------------------------------------------
/**
 * Libellé long d'une action : « PASSER → n°7 », « PASSE EN PROFONDEUR → n°9 », « DRIBBLER (vers l'avant) »,
 * « TIRER », « CONSERVER », « DÉGAGER », « SE DÉPLACER (soutien) ». `playerId` précise l'équipe (sens d'attaque
 * des directions) ; à défaut celle du porteur.
 */
export function actionLabel(candidate: Candidate, state: MatchState, playerId?: number): string {
  const a = candidate.action;
  switch (a.type) {
    case 'pass': {
      const head = a.kind === 'through' ? 'PASSE EN PROFONDEUR' : a.kind === 'lob' ? 'PASSE LOBÉE' : 'PASSER';
      return `${head} → ${playerNumber(state, a.targetId)}`;
    }
    case 'dribble':
      return `DRIBBLER (${directionLabel(a.direction, teamOf(state, playerId))})`;
    case 'shoot':
      return 'TIRER';
    case 'hold':
      return 'CONSERVER';
    case 'clear':
      return 'DÉGAGER';
    case 'move':
      return `SE DÉPLACER (${INTENT_LABELS[a.intent] ?? a.intent})`;
  }
}

/** Libellé court pour les listes : « Passe → n°7 », « Dribble ↗ », « Tir », « Conservation »… */
export function shortLabel(candidate: Candidate, state: MatchState, playerId?: number): string {
  const a = candidate.action;
  switch (a.type) {
    case 'pass':
      return a.kind === 'through'
        ? `Profondeur → ${playerNumber(state, a.targetId)} vers ${fmtPoint(a.targetPoint)}`
        : `${a.kind === 'lob' ? 'Lob' : 'Passe'} → ${playerNumber(state, a.targetId)}`;
    case 'dribble':
      return `Dribble ${directionArrow(a.direction, teamOf(state, playerId))} ${fmtFr(a.distance, 0)} m`;
    case 'shoot':
      return 'Tir';
    case 'hold':
      return 'Conservation';
    case 'clear':
      return 'Dégagement';
    case 'move':
      return `Déplacement (${INTENT_LABELS[a.intent] ?? a.intent})`;
  }
}

/** Description de la cible d'une action (ligne « CIBLE »). */
export function targetLabel(action: Action, state: MatchState, playerId?: number): string {
  switch (action.type) {
    case 'pass':
      return `${playerNumber(state, action.targetId)} en ${fmtPoint(action.targetPoint)}`;
    case 'shoot':
      return `le but, visée y = ${fmtFr(action.targetPoint.y, 1, true)} m`;
    case 'dribble':
      return `${fmtFr(action.distance, 0)} m ${directionLabel(action.direction, teamOf(state, playerId))}`;
    case 'hold':
      return 'garder le ballon';
    case 'clear':
      return `dégagement vers ${fmtPoint(action.targetPoint)}`;
    case 'move':
      return `${fmtPoint(action.target)} — ${INTENT_LABELS[action.intent] ?? action.intent}`;
  }
}

// ---------------------------------------------------------------------------
// « Pourquoi pas » : terme de plus grand écart entre deux décompositions
// ---------------------------------------------------------------------------
/** Phrase associée à une clé de composante lorsque l'alternative y perd (écart en faveur de l'action choisie). */
const WHY_NOT_LABELS: Record<string, string> = {
  threat: 'zone d’arrivée moins dangereuse',
  control: 'zone d’arrivée moins bien contrôlée',
  progression: 'moins de progression vers le but',
  support: 'moins de soutien numérique',
  lines: 'moins de lignes franchies',
  risk: 'risque de perte plus élevé',
  possession: 'possession abandonnée plus précieuse',
  time: 'action plus lente',
  length: 'passe plus longue',
  offside: 'risque de hors-jeu',
  response: 'réponse adverse plus pénalisante',
  lookahead: 'suite moins prometteuse',
  tactic: 'moins conforme à la tactique',
  hysteresis: 'changement d’intention pénalisé',
  probability: 'probabilité de réussite plus faible',
  // clés génériques d'autres politiques (hors-ballon, défense)
  receivable: 'moins recevable',
  space: 'moins d’espace gagné',
  exposure: 'moins d’exposition créée',
  slot: 'trop loin du poste',
  separation: 'trop proche d’un coéquipier',
  priority: 'tâche moins prioritaire',
  shape: 'structure moins respectée',
};

const contributionOf = (c: Candidate, key: string): number => {
  let s = 0;
  for (const k of c.components) if (k.key === key) s += k.contribution;
  return s;
};

/** Clés « secondaires » : ne servent de « pourquoi pas » qu'à défaut d'un écart sur un terme physique. */
const SECONDARY_KEYS = new Set(['tactic', 'hysteresis']);

/**
 * Composante de plus grand écart (chosen − alt) entre deux candidats ; les termes physiques priment sur les bonus
 * tactiques et l'hystérésis (utilisés seulement si aucun terme physique n'est en faveur de l'action choisie).
 * null si aucune composante.
 */
export function largestGap(chosen: Candidate, alt: Candidate): { key: string; label: string; gap: number } | null {
  const keys = new Set<string>();
  for (const k of chosen.components) keys.add(k.key);
  for (const k of alt.components) keys.add(k.key);
  let best: { key: string; label: string; gap: number } | null = null;
  let bestSecondary: { key: string; label: string; gap: number } | null = null;
  for (const key of keys) {
    const gap = contributionOf(chosen, key) - contributionOf(alt, key);
    const comp: ScoreComponent | undefined = chosen.components.find((k) => k.key === key) ?? alt.components.find((k) => k.key === key);
    const entry = { key, label: comp?.label ?? key, gap };
    if (SECONDARY_KEYS.has(key)) { if (!bestSecondary || gap > bestSecondary.gap) bestSecondary = entry; }
    else if (!best || gap > best.gap) best = entry;
  }
  if (best && best.gap > 1e-9) return best;
  if (bestSecondary && bestSecondary.gap > 1e-9) return bestSecondary;
  return best ?? bestSecondary;
}

/**
 * Pourquoi l'alternative `alt` a perdu face à `chosen` : le terme de plus grande différence entre les deux
 * décompositions (§6.6, point 4). Une différence de probabilité marquée est nommée comme telle, car elle
 * pèse sur toutes les composantes de récompense.
 */
export function whyNot(chosen: Candidate, alt: Candidate): string {
  const gap = largestGap(chosen, alt);
  if (!gap || gap.gap <= 1e-9) return 'score équivalent';
  const rewardKeys = new Set(['threat', 'control', 'progression', 'support', 'lines', 'lookahead']);
  if (rewardKeys.has(gap.key) && alt.probability < chosen.probability - 0.15) {
    return `probabilité de réussite plus faible (${fmtPct(alt.probability)})`;
  }
  if (gap.key === 'risk' && alt.threats && alt.threats.length > 0 && alt.action.type === 'pass') {
    return 'risque d’interception trop élevé';
  }
  if (gap.key === 'threat' && alt.action.type === 'dribble') return 'pression sur le trajet trop forte';
  return WHY_NOT_LABELS[gap.key] ?? `${gap.label.toLowerCase()} moins favorable`;
}

// ---------------------------------------------------------------------------
// Explication complète
// ---------------------------------------------------------------------------
/** Nombre maximal d'alternatives listées. */
const MAX_ALTERNATIVES = 3;

/**
 * Explication multi-lignes (≤ 12 lignes) d'une décision :
 *   ACTION CHOISIE / CIBLE / SCORE — PROBABILITÉ / RAISON / Alternatives (3, avec « pourquoi pas ») / Menaces.
 * Fonctionne pour toute décision, y compris les déplacements sans ballon (intention étiquetée en français).
 * Lorsque l'action choisie n'est pas le premier candidat (départage à ε près par P puis T, ou réponse quantale),
 * la raison le signale — l'explication reste une lecture exacte de la décomposition.
 */
export function explainDecision(decision: Decision, state: MatchState): string {
  const c = decision.chosen;
  const pid = decision.playerId;
  const lines: string[] = [];
  lines.push(`ACTION CHOISIE : ${actionLabel(c, state, pid)}`);
  lines.push(`CIBLE : ${targetLabel(c.action, state, pid)}`);
  lines.push(`SCORE : ${fmtFr(c.score, 2)} — PROBABILITÉ : ${fmtPct(c.probability)}`);
  let reason = c.reason && c.reason.length > 0 ? c.reason : 'aucune justification disponible';
  if (decision.keptByHysteresis) reason += ' (intention conservée par hystérésis)';
  else if (decision.candidates.length > 0 && c !== decision.candidates[0]) reason += ' (départage quantal)';
  lines.push(`RAISON : ${reason}`);
  if (c.response && c.response.delta > 1e-4) {
    const kind = { hold: 'tenir la forme', press: 'presser le receveur', cover: 'couvrir la ligne', drop: 'reculer' }[c.response.kind];
    lines.push(`RÉPONSE ADVERSE : ${kind} (dégrade la menace de ${fmtFr(c.response.delta, 3)})`);
  }
  const alternatives = decision.candidates.filter((k) => k !== c).slice(0, MAX_ALTERNATIVES);
  if (alternatives.length > 0) {
    lines.push('Alternatives :');
    for (const alt of alternatives) lines.push(`  – ${shortLabel(alt, state, pid)} (${fmtFr(alt.score, 2)}) : ${whyNot(c, alt)}`);
  }
  if (c.threats && c.threats.length > 0) lines.push(`Menaces : ${c.threats.map((id) => playerNumber(state, id)).join(', ')}`);
  return lines.slice(0, 12).join('\n');
}
