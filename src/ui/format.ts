/**
 * Formatage des nombres en français (virgule décimale, pourcentages, chrono mm:ss)
 * et tables de libellés pour les actions / intentions de déplacement.
 */
import type { Action, ActionType, GamePhase, MoveIntent, Role, TeamId } from '@/core/types';

/** Nombre avec `digits` décimales, virgule décimale, signe optionnel. */
export function fmtNumber(x: number, digits = 2, signed = false): string {
  if (!Number.isFinite(x)) return '—';
  const abs = Math.abs(x).toFixed(digits).replace('.', ',');
  if (x < 0 && Number(abs.replace(',', '.')) !== 0) return '−' + abs;
  if (signed && x > 0) return '+' + abs;
  return abs;
}

/** Pourcentage entier « 81 % » à partir d'une fraction dans [0,1]. */
export function fmtPercent(p: number, digits = 0): string {
  if (!Number.isFinite(p)) return '—';
  return fmtNumber(p * 100, digits) + ' %';
}

/** Chrono de match « mm:ss ». */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Millisecondes « 1,4 ms ». */
export function fmtMs(ms: number): string {
  return fmtNumber(ms, ms < 10 ? 2 : 1) + ' ms';
}

/** Valeur avec unité optionnelle. */
export function fmtValue(value: number, unit?: string): string {
  if (unit === '%') return fmtPercent(value);
  if (unit === 'm') return fmtNumber(value, 1) + ' m';
  if (unit === 's') return fmtNumber(value, 2) + ' s';
  if (unit === 'm/s') return fmtNumber(value, 1) + ' m/s';
  if (unit === 'joueurs') return `${fmtNumber(value, 0)} ${value < 2 ? 'joueur' : 'joueurs'}`;
  const s = fmtNumber(value, Math.abs(value) >= 10 ? 1 : 2);
  return unit ? `${s} ${unit}` : s;
}

export const ACTION_LABELS: Record<ActionType, string> = {
  pass: 'Passer',
  dribble: 'Dribbler',
  hold: 'Conserver',
  shoot: 'Tirer',
  clear: 'Dégager',
  move: 'Se déplacer',
};

export const PASS_KIND_LABELS: Record<'ground' | 'through' | 'lob', string> = {
  ground: 'Passe au sol',
  through: 'Passe en profondeur',
  lob: 'Passe lobée',
};

/** Libellé d'une action, éventuellement précisé par son type de passe. */
export function actionLabel(a: Action): string {
  if (a.type === 'pass') return a.kind === 'ground' ? 'Passer' : a.kind === 'through' ? 'Passe en profondeur' : 'Passe lobée';
  return ACTION_LABELS[a.type];
}

export const INTENT_LABELS: Record<MoveIntent, string> = {
  support: 'soutien',
  run: 'appel',
  width: 'largeur',
  create_space: 'créer espace',
  exploit_space: 'exploiter espace',
  hold_shape: 'structure',
  press: 'pressing',
  mark: 'marquage',
  cover: 'couverture',
  zone: 'zone',
  recover: 'repli',
  intercept: 'interception',
  chase: 'ballon',
  gk_position: 'gardien',
  receive: 'réception',
};

export const PHASE_LABELS: Record<GamePhase, string> = {
  attack: 'Attaque placée',
  defence: 'Défense placée',
  transition_attack: 'Transition off.',
  transition_defence: 'Transition déf.',
};

export const ROLE_LABELS: Record<Role, string> = { GK: 'GB', DF: 'DF', MF: 'MF', FW: 'AT' };

export const TEAM_LABELS: Record<TeamId, string> = { A: 'Équipe A', B: 'Équipe B' };

/** Description courte de la cible d'une action : « Joueur 9 », « vers le but »… */
export function actionTargetLabel(a: Action, numberOf: (id: number) => string): string {
  switch (a.type) {
    case 'pass':
      return `Joueur ${numberOf(a.targetId)}`;
    case 'shoot':
      return 'Le but';
    case 'dribble':
      return `${fmtNumber(a.distance, 0)} m`;
    case 'hold':
      return '—';
    case 'clear':
      return 'Dégagement';
    case 'move':
      return INTENT_LABELS[a.intent];
  }
}
