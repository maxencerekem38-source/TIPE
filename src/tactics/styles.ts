/**
 * Profils tactiques : chaque style est un vecteur de paramètres qui module les poids
 * et seuils de l'algorithme de décision (voir docs/CONCEPTION.md, section « Couche tactique »).
 * Les valeurs sont dans les unités déclarées dans `TacticParams`.
 */
import type { FormationId, StyleId, TacticConfig, TacticParams } from '../core/types';

export const BALANCED_PARAMS: TacticParams = {
  riskTolerance: 0.5,
  progressionBias: 1.0,
  tempo: 0.5,
  directness: 0.4,
  widthUsage: 0.5,
  shotEagerness: 0.5,
  supportDistance: 14,
  runFrequency: 0.4,
  pressIntensity: 0.5,
  pressLine: 0,
  defensiveLine: -25,
  compactness: 0.5,
  markingTightness: 0.4,
  counterPressWindow: 4,
  counterAttackBias: 0.5,
  recoverPriority: 0.5,
  pressTriggerCount: 2,
  restDefenders: 2,
};

/** Écarts par rapport au profil équilibré. */
const STYLE_OVERRIDES: Record<StyleId, Partial<TacticParams>> = {
  balanced: {},
  possession: {
    riskTolerance: 0.3, progressionBias: 0.7, tempo: 0.35, directness: 0.2, widthUsage: 0.6,
    shotEagerness: 0.4, supportDistance: 11, runFrequency: 0.3, pressIntensity: 0.6, pressLine: 5,
    defensiveLine: -18, compactness: 0.55, markingTightness: 0.3, counterPressWindow: 6, counterAttackBias: 0.3, recoverPriority: 0.4, pressTriggerCount: 2, restDefenders: 3,
  },
  counter: {
    riskTolerance: 0.6, progressionBias: 1.4, tempo: 0.8, directness: 0.7, widthUsage: 0.4,
    shotEagerness: 0.6, supportDistance: 16, runFrequency: 0.7, pressIntensity: 0.3, pressLine: -15,
    defensiveLine: -32, compactness: 0.7, markingTightness: 0.5, counterPressWindow: 2, counterAttackBias: 0.9, recoverPriority: 0.7, pressTriggerCount: 3, restDefenders: 2,
  },
  high_press: {
    riskTolerance: 0.55, progressionBias: 1.1, tempo: 0.7, directness: 0.45, widthUsage: 0.5,
    shotEagerness: 0.55, supportDistance: 12, runFrequency: 0.5, pressIntensity: 0.95, pressLine: 20,
    defensiveLine: -10, compactness: 0.65, markingTightness: 0.6, counterPressWindow: 7, counterAttackBias: 0.6, recoverPriority: 0.4, pressTriggerCount: 1, restDefenders: 2,
  },
  low_block: {
    riskTolerance: 0.4, progressionBias: 1.0, tempo: 0.5, directness: 0.6, widthUsage: 0.35,
    shotEagerness: 0.5, supportDistance: 14, runFrequency: 0.5, pressIntensity: 0.2, pressLine: -25,
    defensiveLine: -36, compactness: 0.85, markingTightness: 0.5, counterPressWindow: 1.5, counterAttackBias: 0.7, recoverPriority: 0.9, pressTriggerCount: 3, restDefenders: 3,
  },
  wide: {
    riskTolerance: 0.5, progressionBias: 0.9, tempo: 0.55, directness: 0.45, widthUsage: 0.95,
    shotEagerness: 0.5, supportDistance: 15, runFrequency: 0.5, pressIntensity: 0.5, pressLine: 0,
    defensiveLine: -25, compactness: 0.4, markingTightness: 0.4, counterPressWindow: 4, counterAttackBias: 0.5, recoverPriority: 0.5, pressTriggerCount: 2, restDefenders: 2,
  },
  direct: {
    riskTolerance: 0.7, progressionBias: 1.5, tempo: 0.85, directness: 0.9, widthUsage: 0.45,
    shotEagerness: 0.7, supportDistance: 18, runFrequency: 0.8, pressIntensity: 0.5, pressLine: 0,
    defensiveLine: -28, compactness: 0.6, markingTightness: 0.5, counterPressWindow: 3, counterAttackBias: 0.8, recoverPriority: 0.6, pressTriggerCount: 2, restDefenders: 2,
  },
};

/** Ajustements liés à la formation (une 3-5-2 utilise naturellement plus la largeur, etc.). */
const FORMATION_OVERRIDES: Record<FormationId, Partial<TacticParams>> = {
  '4-3-3': { widthUsage: 0.6 },
  '4-4-2': { compactness: 0.6 },
  '3-5-2': { widthUsage: 0.65, defensiveLine: -27 },
  '4-2-3-1': { supportDistance: 12 },
  '3-4-3': { widthUsage: 0.7, pressIntensity: 0.6 },
};

export const STYLE_LABELS: Record<StyleId, string> = {
  balanced: 'Équilibré',
  possession: 'Conservation / possession',
  counter: 'Contre-attaque',
  high_press: 'Pressing haut',
  low_block: 'Bloc bas',
  wide: 'Jeu en largeur',
  direct: 'Jeu direct',
};

export const STYLE_DESCRIPTIONS: Record<StyleId, string> = {
  balanced: 'Poids par défaut : compromis entre risque et progression.',
  possession: 'Passes courtes sûres, soutien rapproché, patience, contre-pressing long.',
  counter: 'Bloc médian-bas, verticalité immédiate à la récupération, appels fréquents.',
  high_press: 'Pressing agressif dans le camp adverse, ligne défensive haute, marquage serré.',
  low_block: 'Bloc très bas et compact, peu de pressing, repli prioritaire, relances directes.',
  wide: 'Exploitation des couloirs, bloc étiré, ailiers fixés sur la largeur.',
  direct: 'Passes longues et en profondeur, tirs précoces, tempo élevé.',
};

/** Résout un vecteur de paramètres tactiques à partir d'une formation et d'un style. */
export function resolveTacticParams(formation: FormationId, style: StyleId, manual: Partial<TacticParams> = {}): TacticParams {
  const base: TacticParams = { ...BALANCED_PARAMS };
  const formationOverride = FORMATION_OVERRIDES[formation];
  const styleOverride = STYLE_OVERRIDES[style];
  // Le style l'emporte sur la formation : la formation n'ajuste que les paramètres non fixés par le style.
  for (const k of Object.keys(formationOverride) as (keyof TacticParams)[]) if (!(k in styleOverride)) base[k] = formationOverride[k]!;
  Object.assign(base, styleOverride, manual);
  return base;
}

export function makeTactic(formation: FormationId, style: StyleId, manual: Partial<TacticParams> = {}): TacticConfig {
  return { formation, style, params: resolveTacticParams(formation, style, manual) };
}
