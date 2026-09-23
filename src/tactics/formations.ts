/**
 * Formations : positions de référence des 11 postes dans le repère équipe
 * (attaque vers +x, x ∈ [−52,5 ; 52,5], y ∈ [−34 ; 34], y < 0 = côté gauche).
 * Les positions sont celles d'une phase neutre (ballon au centre) ; le moteur de décision
 * les fait glisser vers le ballon (followX/followY) et selon la tactique (ligne défensive, largeur).
 */
import type { Formation, FormationId, FormationSlot, Role, Side } from '../core/types';

const slot = (label: string, role: Role, side: Side, x: number, y: number, followX = 0.5, followY = 0.35): FormationSlot => ({
  label, role, side, x, y, followX, followY,
});

const GK = slot('GK', 'GK', 'C', -48, 0, 0.05, 0.15);

export const FORMATIONS: Record<FormationId, Formation> = {
  '4-3-3': {
    id: '4-3-3',
    name: '4-3-3',
    slots: [
      GK,
      slot('LB', 'DF', 'L', -30, -24, 0.55, 0.3),
      slot('LCB', 'DF', 'C', -34, -8, 0.5, 0.3),
      slot('RCB', 'DF', 'C', -34, 8, 0.5, 0.3),
      slot('RB', 'DF', 'R', -30, 24, 0.55, 0.3),
      slot('DM', 'MF', 'C', -16, 0, 0.6, 0.4),
      slot('LCM', 'MF', 'L', -6, -12, 0.65, 0.4),
      slot('RCM', 'MF', 'R', -6, 12, 0.65, 0.4),
      slot('LW', 'FW', 'L', 14, -24, 0.55, 0.25),
      slot('ST', 'FW', 'C', 20, 0, 0.45, 0.35),
      slot('RW', 'FW', 'R', 14, 24, 0.55, 0.25),
    ],
  },
  '4-4-2': {
    id: '4-4-2',
    name: '4-4-2',
    slots: [
      GK,
      slot('LB', 'DF', 'L', -30, -22, 0.55, 0.3),
      slot('LCB', 'DF', 'C', -34, -8, 0.5, 0.3),
      slot('RCB', 'DF', 'C', -34, 8, 0.5, 0.3),
      slot('RB', 'DF', 'R', -30, 22, 0.55, 0.3),
      slot('LM', 'MF', 'L', -6, -24, 0.6, 0.3),
      slot('LCM', 'MF', 'C', -10, -7, 0.65, 0.4),
      slot('RCM', 'MF', 'C', -10, 7, 0.65, 0.4),
      slot('RM', 'MF', 'R', -6, 24, 0.6, 0.3),
      slot('LS', 'FW', 'L', 18, -7, 0.45, 0.35),
      slot('RS', 'FW', 'R', 18, 7, 0.45, 0.35),
    ],
  },
  '3-5-2': {
    id: '3-5-2',
    name: '3-5-2',
    slots: [
      GK,
      slot('LCB', 'DF', 'L', -33, -13, 0.5, 0.3),
      slot('CB', 'DF', 'C', -36, 0, 0.5, 0.3),
      slot('RCB', 'DF', 'R', -33, 13, 0.5, 0.3),
      slot('LWB', 'MF', 'L', -12, -27, 0.6, 0.25),
      slot('DM', 'MF', 'C', -16, 0, 0.6, 0.4),
      slot('LCM', 'MF', 'C', -5, -10, 0.65, 0.4),
      slot('RCM', 'MF', 'C', -5, 10, 0.65, 0.4),
      slot('RWB', 'MF', 'R', -12, 27, 0.6, 0.25),
      slot('LS', 'FW', 'L', 18, -7, 0.45, 0.35),
      slot('RS', 'FW', 'R', 18, 7, 0.45, 0.35),
    ],
  },
  '4-2-3-1': {
    id: '4-2-3-1',
    name: '4-2-3-1',
    slots: [
      GK,
      slot('LB', 'DF', 'L', -30, -23, 0.55, 0.3),
      slot('LCB', 'DF', 'C', -34, -8, 0.5, 0.3),
      slot('RCB', 'DF', 'C', -34, 8, 0.5, 0.3),
      slot('RB', 'DF', 'R', -30, 23, 0.55, 0.3),
      slot('LDM', 'MF', 'C', -16, -7, 0.6, 0.4),
      slot('RDM', 'MF', 'C', -16, 7, 0.6, 0.4),
      slot('LAM', 'MF', 'L', 6, -22, 0.6, 0.3),
      slot('CAM', 'MF', 'C', 6, 0, 0.6, 0.4),
      slot('RAM', 'MF', 'R', 6, 22, 0.6, 0.3),
      slot('ST', 'FW', 'C', 20, 0, 0.45, 0.35),
    ],
  },
  '3-4-3': {
    id: '3-4-3',
    name: '3-4-3',
    slots: [
      GK,
      slot('LCB', 'DF', 'L', -33, -13, 0.5, 0.3),
      slot('CB', 'DF', 'C', -36, 0, 0.5, 0.3),
      slot('RCB', 'DF', 'R', -33, 13, 0.5, 0.3),
      slot('LWB', 'MF', 'L', -10, -26, 0.6, 0.25),
      slot('LCM', 'MF', 'C', -12, -7, 0.65, 0.4),
      slot('RCM', 'MF', 'C', -12, 7, 0.65, 0.4),
      slot('RWB', 'MF', 'R', -10, 26, 0.6, 0.25),
      slot('LW', 'FW', 'L', 14, -20, 0.55, 0.3),
      slot('ST', 'FW', 'C', 20, 0, 0.45, 0.35),
      slot('RW', 'FW', 'R', 14, 20, 0.55, 0.3),
    ],
  },
};

export const getFormation = (id: FormationId): Formation => FORMATIONS[id];
