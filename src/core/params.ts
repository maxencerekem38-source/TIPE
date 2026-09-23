/**
 * Valeurs par défaut de tous les paramètres du système (source de vérité).
 * Chaque paramètre est documenté dans docs/CONCEPTION.md. Les poids marqués « optimisable »
 * sont ceux que la méthode d'entropie croisée (scripts/optimize.ts) peut ajuster.
 */
import type { SimParams } from './types';

export const DEFAULT_PARAMS: SimParams = {
  physics: {
    dt: 1 / 30,
    playerMaxSpeed: 8.0,
    playerMaxAccel: 5.0,
    playerReactionTime: 0.25,
    controlRadius: 1.0,
    ballFriction: 1.5,
    ballBounce: 0.5,
    passArrivalSpeed: 6,
    throughArrivalSpeed: 9,
    passSpeedMax: 25,
    shotSpeed: 25,
    dribbleSpeedFactor: 0.75,
    kickCooldown: 0.45,
    executionNoiseDeg: 3,
    executionNoisePressure: 2,
  },
  models: {
    reactionTime: 0.3,
    arrivalSigma: 0.4,
    controlBeta: 1.0,
    controlBallSpeed: 14,
    pressureRadius: 3.5,
    pressureDirectional: 0.5,
    threatKappa: 0.22,
    threatRhoX: 25,
    threatRhoY: 22,
    interceptSamples: 12,
    interceptEfficiency: 0.35,
    pass: { base: 2.4, distance: -0.04, longDistance: -0.02, passerPressure: -0.9, receiverPressure: -0.6 },
    through: { base: 1.8, distance: -0.03, passerPressure: -0.8 },
    dribble: { base: 1.5, pathPressure: -1.2, distance: -0.15, control: 0.8 },
    shot: { base: -1.1, angle: 3.0, distance: -0.08, keeperCoverage: -1.5, blockers: -0.9, pressure: -0.5 },
    hold: { base: 2.5, pressure: -1.6, closeOpponents: -0.3 },
    keeperReachBase: 0.5,
    keeperReachPerSecond: 2.0,
  },
  decision: {
    wProgress: 0.15,
    wSupport: 0.02,
    lambdaRisk: 1.0,
    wTime: 0.005,
    wOffside: 0.05,
    gamma: 0.5,
    topK: 5,
    hysteresis: 0.02,
    softmaxTemperature: 0.01,
    dribbleDirections: 8,
    dribbleDistances: [4, 8],
    throughDistances: [6, 12, 18],
    shotMaxDistance: 35,
    holdBias: 0.0,
    wLineBreaks: 0.02,
    epsilonTie: 0.005,
    epsilonGame: 0.02,
    holdDuration: 0.4,
    passArrivalSpeeds: [4, 6, 9],
  },
  offBall: {
    wReceivable: 1.0,
    wSpace: 0.3,
    wTeamExposure: 0.3,
    wSlot: 0.2,
    wSeparation: 0.4,
    wOffside: 0.5,
    wRun: 0.4,
    slotRadius: 12,
    separationRadius: 8,
    candidateDistances: [3, 8, 15],
    candidateDirections: 8,
    hysteresis: 0.15,
    runBandWidth: 15,
    reexamineEvery: 2,
  },
  defence: {
    muPriority: 6,
    nuShape: 8,
    xiHysteresis: 0.4,
    markGoalSideOffset: 1.5,
    maxMarkTasks: 5,
    maxZoneTasks: 4,
    pressTriggerTime: 2.0,
    keeperDepthFactor: 0.2,
    keeperMaxDepth: 5.5,
    muRole: 1.5,
    maxTaskTime: 6,
    minReassignGain: 0.5,
    containOffset: 2,
    tackleRadius: 1.2,
  },
  decisionPeriod: 0.2,
  fieldCellSize: 2,
  transitionWindow: 3,
};

/** Copie profonde des paramètres (les objets sont de simples données JSON). */
export const cloneParams = (p: SimParams): SimParams => JSON.parse(JSON.stringify(p));

/**
 * Aplatit les paramètres en un dictionnaire chemin → valeur (« decision.wProgress »),
 * utilisé par l'optimiseur et l'interface de réglage.
 */
export function flattenParams(p: SimParams, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (obj: unknown, path: string): void => {
    if (typeof obj === 'number') { out[path] = obj; return; }
    if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(p, prefix);
  return out;
}

/** Applique un dictionnaire chemin → valeur sur une copie des paramètres. */
export function applyFlatParams(p: SimParams, flat: Record<string, number>): SimParams {
  const out = cloneParams(p);
  for (const [path, value] of Object.entries(flat)) {
    const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur: any = out;
    for (let i = 0; i < tokens.length - 1; i++) cur = cur[tokens[i]];
    cur[tokens[tokens.length - 1]] = value;
  }
  return out;
}
