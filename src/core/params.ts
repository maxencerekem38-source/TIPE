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
    // --- Moteur (cinématique, prises de balle, duels, remises en jeu) ---
    speedNoise: 0.05,
    slowDownDistance: 2,
    playerSeparation: 0.6,
    controlSlowBonus: 0.3,
    controlSlowSpeed: 3,
    controlMaxHeight: 1.6,
    controlMaxRelSpeed: 12,
    kickerImmunity: 0.25,
    duelCooldown: 1.5,
    beatenFreeze: 1.0,
    duelBase: -1.1,
    duelGoalSide: 1.0,
    duelPressure: 0.6,
    duelSkill: 1.2,
    duelMinProb: 0.15,
    duelMaxProb: 0.6,
    tackleKeepProb: 0.5,
    tackleLooseDistance: 1.5,
    restartFreeze: 1.5,
    kickoffFreeze: 1.5,
    goalFreeze: 3,
    saveProb: 0.6,
    saveCornerProb: 0.3,
    keeperSaveRadius: 1.5,
    blockRadius: 0.7,
    blockWindow: 0.4,
    dribbleWonDelay: 1.5,
    defaultShotXG: 0.1,
    // --- Ajouts du moteur : déclenchement des duels, dribbles = prises à défaut, atterrissage des ballons aériens ---
    duelClosingSpeed: 0.8,
    duelCarrierGrace: 0.4,
    duelContactTime: 0.8,
    takeOnRadius: 3,
    lobLandingSpeed: 3.5,
    lobBounce: 0.2,
    steeringTau: 0.3,
    restartClearance: 3,
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
    // η : une chance par défenseur (§4.6) ; calibré sur l'auto-jeu (scripts/calibrate.ts, §11.6 et §15.2).
    interceptEfficiency: 0.35,
    // Termes de distance réajustés sur les issues du moteur (§11.6, scripts/calibrate.ts ; §15.2) : la réussite observée
    // dépend peu de la distance (les échecs sont surtout des réceptions manquées) ; le réajustement complet (distance −0,02,
    // > 30 m 0) n'est pas un point fixe de l'auto-jeu (biais de sélection) et dégrade le banc de scénarios : demi-pas
    // amorti distance −0,04 → −0,03, > 30 m −0,02 → −0,01. Base, pressions, vitesse, lob et modèle de profondeur inchangés.
    pass: { base: 2.4, distance: -0.03, longDistance: -0.01, passerPressure: -0.9, receiverPressure: -0.6, arrivalSpeed: -0.1, lobPenalty: -1.5 },
    through: { base: 1.8, distance: -0.03, passerPressure: -0.8, reachSlack: 0.6 },
    dribble: { base: 1.5, pathPressure: -1.2, distance: -0.15, control: 0.8, race: 1.0 },
    shot: { base: -1.1, angle: 3.0, distance: -0.08, keeperCoverage: -1.5, blockers: -0.9, pressure: -0.5 },
    hold: { base: 2.5, pressure: -1.6, closeOpponents: -0.3 },
    keeperReachBase: 0.5,
    keeperReachPerSecond: 2.0,
    pressureClosing: 0.5,
    threatKeeperCoverage: 0.57,
    keeperReachMax: 1.2,
    keeperBodyWidth: 1.8,
    attributeInfluence: 0.6,
    superiorityHorizon: 2.5,
    spaceRadius: 8,
    interceptLandingEfficiency: 0.6,
    interceptLandingWindow: 0.3,
    interceptWindow: 0,
  },
  decision: {
    wProgress: 0.15,
    wSupport: 0.02,
    lambdaRisk: 1.0,
    wTime: 0.005,
    wOffside: 0.02,
    gamma: 0.5,
    topK: 5,
    hysteresis: 0.002,
    softmaxTemperature: 0.01,
    dribbleDirections: 8,
    dribbleDistances: [4, 8],
    throughDistances: [6, 12, 18],
    shotMaxDistance: 35,
    holdBias: 0.0,
    wLineBreaks: 0.02,
    epsilonTie: 0.002,
    epsilonGame: 0.02,
    holdDuration: 0.4,
    passArrivalSpeeds: [4, 6, 9, 10],
    shotMinXg: 0.06,
    wLength: 0.1,
    wShotPossession: 0.4,
    wPossession: 1.0,
    // Réponses défensives de la profondeur 2 (§6.3) : 4 = {hold, press, cover, drop} ; 5 candidats × 4 réponses × jeu réduit.
    responseCount: 4,
    responseReevaluate: 4,
    gameCommitMin: 1.0,
    ownGoalMargin: 1.0,
    // Cibles longues (§6.1) : passe appuyée (10 m/s : 12 m/s serait refusée par la prise de balle du moteur,
    // controlMaxRelSpeed = 12 strict, bruit de vitesse ±5 %) et lob toujours évalués au-delà de 25 m.
    longPassDistance: 25,
    // Pression du temps de possession (§15.2 « jeu figé ») : coût temporel des actions qui gardent le ballon multiplié
    // par (1 + κ·min(6, max(0, t_held − 2))) ; lignes franchies comptées sur l'état anticipé avec 2 m de marge.
    holdTimeKappa: 4,
    holdTimeDelay: 2,
    holdTimeMax: 6,
    holdTimePassMin: 0.4,
    holdTimePassFull: 0.6,
    lineBreakMargin: 2,
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
    candidateDistances: [6, 12, 20],
    candidateDirections: 8,
    hysteresis: 0.15,
    runBandWidth: 15,
    reexamineEvery: 2,
    wSupport: 0.1,
    // --- Ajouts de la décision hors-ballon : vitesses par intention, maintien de la place, lissage des postes ---
    minSpeed: 2,
    intentSpeed: { hold_shape: 0.35, support: 0.5, width: 0.5, exploit_space: 0.6, create_space: 0.6 },
    standDistance: 1.5,
    slotFollowRate: 5,
    wMove: 0.015,
    transitionHysteresis: 0.5,
    meetingKeepGain: 0.5,
    slotFloorX: -38,
    // Soutien urgent (§15.3 « jeu figé ») : u ∈ [1, 3] selon le temps de possession du porteur et l'absence de passe à P ≥ 0,6.
    supportUrgencyMax: 3,
    supportUrgencyDelay: 2,
    supportUrgencyRamp: 3,
    supportUrgencyPass: 0.6,
    supportUrgencyRadius: 30,
    wSupportUrgency: 0.4,
    supportUrgencyRelax: 1,
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
    // --- Ajouts de la décision défensive : contain modulé par pressIntensity, vitesses de tâche, maintien sur place ---
    containSlack: 6,
    taskSpeed: { contain: 0.7, zone: 0.3, markBase: 0.45, markGain: 0.3, recoverBase: 0.25, recoverGain: 0.3 },
    standDistance: 3,
    lineHoldSlack: 1,
    // Déclencheur « porteur bloqué » (§15.3) : pressing forcé après 3 s de possession continue sans solution de passe.
    pressHoldTime: 3,
    pressHoldPass: 0.75,
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
