/**
 * CONTRAT DE TYPES PARTAGÉ — toutes les couches (moteur, modèles, décision, tactiques, UI, expériences)
 * ne communiquent qu'à travers ces types. Ne pas ajouter de dépendance vers d'autres modules ici.
 *
 * Conventions :
 *  - Unités SI (m, s, m/s, rad). Origine au centre du terrain.
 *  - L'équipe A attaque vers +x, l'équipe B vers −x (voir `attackDir`).
 *  - « Repère équipe » : coordonnées multipliées par la direction d'attaque, de sorte que
 *    chaque équipe attaque vers +x' dans son propre repère (utile pour formations et tactiques).
 */
import type { Vec2 } from './vec2';
import type { AttackDir } from './pitch';
import type { ScalarField } from './grid';

// ---------------------------------------------------------------------------
// Équipes, rôles, formations
// ---------------------------------------------------------------------------
export type TeamId = 'A' | 'B';
export const TEAMS: readonly TeamId[] = ['A', 'B'] as const;
export const otherTeam = (t: TeamId): TeamId => (t === 'A' ? 'B' : 'A');
export const attackDir = (t: TeamId): AttackDir => (t === 'A' ? 1 : -1);

export type Role = 'GK' | 'DF' | 'MF' | 'FW';
export type Side = 'L' | 'C' | 'R';

export type FormationId = '4-3-3' | '4-4-2' | '3-5-2' | '4-2-3-1' | '3-4-3';
export const FORMATION_IDS: readonly FormationId[] = ['4-3-3', '4-4-2', '3-5-2', '4-2-3-1', '3-4-3'] as const;

export type StyleId = 'balanced' | 'possession' | 'counter' | 'high_press' | 'low_block' | 'wide' | 'direct';
export const STYLE_IDS: readonly StyleId[] = ['balanced', 'possession', 'counter', 'high_press', 'low_block', 'wide', 'direct'] as const;

/** Position de référence d'un poste dans le repère équipe (attaque vers +x), ballon au centre. */
export interface FormationSlot {
  label: string; // 'GK', 'LB', 'CB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST', ...
  role: Role;
  side: Side;
  x: number; // m, repère équipe
  y: number; // m, repère équipe (y<0 = gauche quand on attaque vers +x)
  /** Amplitude d'ajustement : combien la position de référence suit le ballon en x et y (0..1). */
  followX: number;
  followY: number;
}

export interface Formation {
  id: FormationId;
  name: string;
  slots: FormationSlot[]; // 11 éléments, slots[0] est toujours le gardien
}

/**
 * Vecteur de paramètres tactiques. Toute tactique = formation + style ⇒ un TacticParams résolu.
 * Ces paramètres modulent les poids de la fonction d'évaluation et les seuils de décision.
 */
export interface TacticParams {
  // --- Attaque ---
  /** 0..1 : tolérance au risque (pondération de la valeur en cas d'échec). */
  riskTolerance: number;
  /** 0..2 : poids de la progression vers le but adverse. */
  progressionBias: number;
  /** 0..1 : vitesse d'exécution voulue (pénalise la conservation, favorise les passes rapides). */
  tempo: number;
  /** 0..1 : préférence pour les passes longues / en profondeur. */
  directness: number;
  /** 0..1 : utilisation de la largeur (positions des ailiers, poids des options larges). */
  widthUsage: number;
  /** 0..1 : propension à tirer (abaisse le seuil de xG pour tenter sa chance). */
  shotEagerness: number;
  /** m : distance de soutien idéale au porteur pour les joueurs sans ballon. */
  supportDistance: number;
  /** 0..1 : proportion de joueurs autorisés à faire des appels en profondeur. */
  runFrequency: number;
  // --- Défense ---
  /** 0..1 : intensité du pressing (nombre de presseurs, rayon de déclenchement). */
  pressIntensity: number;
  /** m, repère équipe : ligne x au-delà de laquelle le pressing sur le porteur se déclenche. */
  pressLine: number;
  /** m, repère équipe : hauteur de la ligne défensive en défense placée. */
  defensiveLine: number;
  /** 0..1 : compacité du bloc (contraction des positions vers le ballon). */
  compactness: number;
  /** 0..1 : 0 = zone pure, 1 = marquage individuel strict. */
  markingTightness: number;
  /** s : fenêtre de contre-pressing après une perte de balle. */
  counterPressWindow: number;
  // --- Transitions ---
  /** 0..1 : verticalité immédiate après récupération (contre-attaque). */
  counterAttackBias: number;
  /** 0..1 : priorité au repli après une perte. */
  recoverPriority: number;
  /** Nombre de conditions de déclenchement du pressing requises (1 = pressing haut agressif, 3 = bloc bas). */
  pressTriggerCount: number;
  /** Nombre de « défenseurs de repos » qui restent sur leur poste pendant l'attaque. */
  restDefenders: number;
}

export interface TacticConfig {
  formation: FormationId;
  style: StyleId;
  /** Paramètres résolus (formation + style + éventuels réglages manuels). */
  params: TacticParams;
}

// ---------------------------------------------------------------------------
// Joueurs et ballon
// ---------------------------------------------------------------------------
/** Attributs individuels (0..1, 0,5 = joueur moyen). Modulent vitesses et probabilités. */
export interface PlayerAttributes {
  pace: number;
  acceleration: number;
  passing: number;
  shooting: number;
  dribbling: number;
  defending: number;
  goalkeeping: number;
}

export type GamePhase = 'attack' | 'defence' | 'transition_attack' | 'transition_defence';

export interface Player {
  id: number; // 0..21, unique dans le match (A : 0..10, B : 11..21)
  team: TeamId;
  number: number; // numéro de maillot 1..11
  name: string;
  role: Role;
  slotIndex: number; // indice dans formation.slots
  attrs: PlayerAttributes;
  pos: Vec2;
  vel: Vec2;
  /** Vitesse maximale et accélération effectives (m/s, m/s²), issues des attributs. */
  maxSpeed: number;
  maxAccel: number;
  /** Cible de déplacement courante (null = immobile). */
  target: Vec2 | null;
  /** Vitesse désirée vers la cible (m/s), permet de trottiner vs sprinter. */
  targetSpeed: number;
  /** Dernière décision prise par l'algorithme (pour l'affichage et l'hystérésis). */
  decision: Decision | null;
  lastDecisionTime: number;
  /** Instant de la dernière touche de balle (contrôle du rythme des actions). */
  lastKickTime: number;
}

export type BallFlightKind = 'pass' | 'through' | 'lob' | 'shot' | 'clearance' | 'loose';

export interface BallFlight {
  kind: BallFlightKind;
  kickerId: number;
  /** Destinataire visé (passe) ou null (tir, dégagement). */
  targetId: number | null;
  /** Point visé. */
  targetPoint: Vec2;
  origin: Vec2;
  startTime: number;
  initialSpeed: number;
}

export interface Ball {
  pos: Vec2;
  vel: Vec2;
  /** Hauteur (m) et vitesse verticale — utilisées pour les lobs et tirs (rendu et interceptions). */
  z: number;
  vz: number;
  /** Joueur qui contrôle le ballon (null si libre). */
  ownerId: number | null;
  lastTouchId: number | null;
  /** Description de la trajectoire en cours si le ballon est libre après une frappe. */
  flight: BallFlight | null;
}

// ---------------------------------------------------------------------------
// Actions et décisions
// ---------------------------------------------------------------------------
export type MoveIntent =
  | 'support' // se rendre disponible pour une passe courte
  | 'run' // appel en profondeur
  | 'width' // offrir la largeur
  | 'create_space' // s'écarter pour libérer une zone
  | 'exploit_space' // se déplacer vers un espace libre à forte valeur
  | 'hold_shape' // conserver sa position de structure
  | 'press' // presser le porteur
  | 'mark' // marquer un adversaire
  | 'cover' // couvrir (deuxième rideau derrière le presseur)
  | 'zone' // défendre une zone
  | 'recover' // se replier vers son bloc
  | 'intercept' // aller vers le point d'interception d'une passe
  | 'chase' // aller au ballon libre
  | 'gk_position' // positionnement du gardien
  | 'receive'; // se placer pour recevoir la passe en cours

export type Action =
  | { type: 'pass'; targetId: number; targetPoint: Vec2; kind: 'ground' | 'through' | 'lob'; speed: number }
  | { type: 'dribble'; direction: Vec2; distance: number }
  | { type: 'hold' }
  | { type: 'shoot'; targetPoint: Vec2; power: number; xg?: number }
  | { type: 'clear'; targetPoint: Vec2 }
  | { type: 'move'; target: Vec2; intent: MoveIntent; speed: number; markId?: number };

export type ActionType = Action['type'];

/** Une contribution nommée à un score (permet l'explication et le débogage). */
export interface ScoreComponent {
  /** Identifiant stable (ex. 'progression', 'danger', 'risk', 'pressure', 'space'). */
  key: string;
  /** Libellé français pour l'affichage. */
  label: string;
  /** Valeur brute de la caractéristique (unité indiquée par `unit`). */
  value: number;
  unit?: string;
  /** Poids appliqué (après modulation tactique). */
  weight: number;
  /** Contribution = f(value)·weight, homogène au score. */
  contribution: number;
}

export interface Candidate {
  action: Action;
  /** Score final (utilité espérée) — plus haut = meilleur. */
  score: number;
  /** Probabilité de réussite estimée de l'action, dans [0,1]. */
  probability: number;
  /** Valeur de l'état résultant en cas de succès / échec (même échelle que score). */
  valueIfSuccess: number;
  valueIfFailure: number;
  components: ScoreComponent[];
  /** Phrase d'explication en français (≤ 140 caractères). */
  reason: string;
  /** Adversaires susceptibles d'intercepter / contrer (pour la visualisation). */
  threats?: number[];
  /** Durée estimée de l'action (s). */
  duration?: number;
  /** Point d'arrivée en cas de succès et point de perte en cas d'échec (visualisation). */
  successPoint?: Vec2;
  failurePoint?: Vec2;
  /** Meilleure réponse défensive (minimax, profondeur 2) et dégradation de valeur associée. */
  response?: { kind: DefensiveResponse; delta: number };
  /** Points d'échantillonnage de l'interception (point, probabilité φ, adversaire) pour le rendu. */
  samples?: { point: Vec2; phi: number; opponentId: number }[];
}

export type DefensiveResponse = 'hold' | 'press' | 'cover' | 'drop';

/** Jeu 2×2 à somme nulle résolu lorsqu'un dilemme apparaît (§6.4 de la conception). */
export interface Game2x2 {
  actions: [string, string];
  responses: [DefensiveResponse, DefensiveResponse];
  matrix: [[number, number], [number, number]];
  pure: boolean;
  /** Probabilité de jouer la première action à l'équilibre. */
  pi1: number;
  value: number;
}

export interface DecisionContext {
  phase: GamePhase;
  style: StyleId;
  formation: FormationId;
  /** Pression subie par le joueur (0..1). */
  pressure: number;
  /** Nombre de coéquipiers disponibles (lignes de passe ouvertes). */
  availableTeammates: number;
  /** Supériorité numérique locale autour du ballon (positif = avantage). */
  localSuperiority: number;
}

export interface Decision {
  playerId: number;
  time: number;
  chosen: Candidate;
  /** Tous les candidats évalués, triés par score décroissant (chosen inclus). */
  candidates: Candidate[];
  context: DecisionContext;
  /** Explication multi-lignes en français. */
  explanation: string;
  /** Temps de calcul (ms). */
  computeMs: number;
  /** L'intention précédente a été conservée par hystérésis. */
  keptByHysteresis?: boolean;
  /** Instant jusqu'auquel l'action est engagée (pas de re-décision avant). */
  committedUntil?: number;
  /** Jeu 2×2 résolu le cas échéant (stratégie mixte). */
  game?: Game2x2;
}

// ---------------------------------------------------------------------------
// Champs spatiaux calculés une fois par cycle de décision
// ---------------------------------------------------------------------------
export interface FieldSet {
  time: number;
  /** Probabilité que l'équipe A contrôle chaque point du terrain (B = 1 − A). */
  controlA: ScalarField;
  /** Menace (valeur d'une position) pour l'équipe A attaquant vers +x, et pour B attaquant vers −x. */
  threatA: ScalarField;
  threatB: ScalarField;
  /** Pression exercée par l'équipe A (resp. B) en chaque point (0..1). */
  pressureByA: ScalarField;
  pressureByB: ScalarField;
}

// ---------------------------------------------------------------------------
// État du match
// ---------------------------------------------------------------------------
export type RestartKind = 'kickoff' | 'goal_kick' | 'throw_in' | 'corner' | 'free_kick';

export interface Restart {
  kind: RestartKind;
  team: TeamId;
  pos: Vec2;
  /** Instant de reprise (le jeu est gelé jusque-là). */
  resumeAt: number;
}

export type MatchEventKind =
  | 'goal' | 'shot' | 'pass' | 'pass_complete' | 'pass_intercepted' | 'pass_failed'
  | 'dribble' | 'dribble_failed' | 'tackle' | 'turnover' | 'out' | 'restart' | 'save' | 'possession_change';

export interface MatchEvent {
  time: number;
  kind: MatchEventKind;
  team: TeamId;
  playerId?: number;
  targetId?: number;
  pos?: Vec2;
  /** Valeur associée (xG d'un tir, probabilité d'une passe...). */
  value?: number;
  label?: string;
}

export interface TeamStats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  xG: number;
  passes: number;
  passesCompleted: number;
  throughBalls: number;
  dribbles: number;
  dribblesWon: number;
  tackles: number;
  interceptions: number;
  turnovers: number;
  /** Temps de possession (s). */
  possessionTime: number;
  /** Menace créée (somme des Δ menace des actions réussies). */
  threatCreated: number;
  /** Nombre de décisions et temps cumulé (ms) pour mesurer la latence. */
  decisions: number;
  decisionMs: number;
  /** Regret cumulé : Σ (meilleur score − score de l'action réellement exécutée) — 0 pour l'algorithme optimal. */
  regret: number;
}

export interface MatchStats {
  A: TeamStats;
  B: TeamStats;
}

export interface MatchState {
  time: number; // s
  tick: number;
  players: Player[]; // 22
  ball: Ball;
  /** Équipe en possession (dernière équipe à avoir contrôlé le ballon). */
  possession: TeamId | null;
  possessionSince: number;
  phase: Record<TeamId, GamePhase>;
  phaseSince: Record<TeamId, number>;
  score: Record<TeamId, number>;
  restart: Restart | null;
  tactics: Record<TeamId, TacticConfig>;
  stats: MatchStats;
  /** Journal des événements récents (borné). */
  events: MatchEvent[];
  /** Champs spatiaux du dernier cycle de décision (null avant le premier). */
  fields: FieldSet | null;
  /** Équipe qui a engagé au dernier coup d'envoi. */
  lastKickoff: TeamId;
}

// ---------------------------------------------------------------------------
// Paramètres globaux des modèles (physique, probabilités, poids de décision)
// Toutes les valeurs par défaut sont dans src/core/params.ts (source de vérité).
// ---------------------------------------------------------------------------
export interface PhysicsParams {
  dt: number; // s, pas de simulation
  playerMaxSpeed: number; // m/s (joueur moyen, attribut pace = 0,5)
  playerMaxAccel: number; // m/s² (joueur moyen)
  playerReactionTime: number; // s, délai avant de réagir à une nouvelle cible
  controlRadius: number; // m, rayon de prise de balle
  ballFriction: number; // m/s², décélération du ballon au sol
  ballBounce: number; // coefficient de restitution vertical (lobs)
  passArrivalSpeed: number; // m/s, vitesse voulue à l'arrivée d'une passe dans les pieds
  throughArrivalSpeed: number; // m/s, vitesse voulue à l'arrivée d'une passe en profondeur
  passSpeedMax: number; // m/s
  shotSpeed: number; // m/s
  dribbleSpeedFactor: number; // fraction de la vitesse max avec le ballon
  kickCooldown: number; // s, délai minimal entre deux touches de balle
  executionNoiseDeg: number; // °, écart-type angulaire de l'erreur d'exécution (sans pression)
  executionNoisePressure: number; // °, supplément par unité de pression
}

/** Coefficients d'un modèle logistique P = σ(base + Σ coef·feature). */
export interface PassModel { base: number; distance: number; longDistance: number; passerPressure: number; receiverPressure: number }
export interface ThroughModel { base: number; distance: number; passerPressure: number }
export interface DribbleModel { base: number; pathPressure: number; distance: number; control: number }
export interface ShotModel { base: number; angle: number; distance: number; keeperCoverage: number; blockers: number; pressure: number }
export interface HoldModel { base: number; pressure: number; closeOpponents: number }

export interface ModelParams {
  // Temps d'arrivée et contrôle du terrain
  reactionTime: number; // s
  arrivalSigma: number; // s, incertitude de la sigmoïde d'arrivée
  controlBeta: number; // s, température du softmin (β→0 ⇒ Voronoi)
  controlBallSpeed: number; // m/s, vitesse nominale de passe utilisée pour le temps de trajet
  // Pression
  pressureRadius: number; // m
  pressureDirectional: number; // pondération directionnelle (défenseur côté but compte plus)
  // Menace (valeur d'une position)
  threatKappa: number;
  threatRhoX: number; // m
  threatRhoY: number; // m
  // Interception
  interceptSamples: number;
  interceptEfficiency: number; // η, efficacité de capture par échantillon
  // Modèles de réussite
  pass: PassModel;
  through: ThroughModel;
  dribble: DribbleModel;
  shot: ShotModel;
  hold: HoldModel;
  /** Rayon de couverture du gardien (m) : base + gain·temps de vol. */
  keeperReachBase: number;
  keeperReachPerSecond: number;
}

/** Poids de la fonction d'évaluation du porteur (modulés ensuite par les paramètres tactiques). */
export interface DecisionWeights {
  wProgress: number; // progression vers le but (par longueur de terrain)
  wSupport: number; // options suivantes disponibles pour le receveur
  lambdaRisk: number; // pondération de la valeur adverse en cas de perte
  wTime: number; // coût par seconde d'exécution
  wOffside: number; // pénalité de risque de hors-jeu
  gamma: number; // poids du lookahead (profondeur 2)
  topK: number; // nombre de candidats développés en profondeur 2
  hysteresis: number; // bonus pour conserver l'intention courante
  softmaxTemperature: number; // température de la réponse quantale (0 = déterministe)
  dribbleDirections: number;
  dribbleDistances: number[]; // m
  throughDistances: number[]; // m
  shotMaxDistance: number; // m
  holdBias: number; // biais additif de conservation
  wLineBreaks: number; // valeur d'une ligne défensive franchie
  epsilonTie: number; // seuil d'égalité pour le départage
  epsilonGame: number; // seuil de déclenchement du jeu 2×2
  holdDuration: number; // s, durée d'une conservation
  passArrivalSpeeds: number[]; // m/s, vitesses d'arrivée candidates
}

/** Poids de l'utilité de déplacement sans ballon (attaque). */
export interface OffBallWeights {
  wReceivable: number; // P_pass · xT
  wSpace: number; // gain de contrôle
  wTeamExposure: number; // gain d'exposition collective
  wSlot: number; // rappel vers la position de structure
  wSeparation: number; // répulsion entre coéquipiers
  wOffside: number;
  wRun: number; // bonus des appels en profondeur
  slotRadius: number; // m
  separationRadius: number; // m
  candidateDistances: number[]; // m
  candidateDirections: number;
  hysteresis: number; // gain minimal pour changer de cible
  runBandWidth: number; // m, largeur des bandes (un seul coureur par bande)
  reexamineEvery: number; // s, ré-examen forcé de la cible
}

/** Coûts de l'affectation défensive. */
export interface DefenceWeights {
  muPriority: number; // s par unité de priorité
  nuShape: number; // s par longueur de terrain d'écart à la structure
  xiHysteresis: number; // s, bonus pour conserver sa tâche
  markGoalSideOffset: number; // m
  maxMarkTasks: number;
  maxZoneTasks: number;
  pressTriggerTime: number; // s, temps d'arrivée max pour déclencher un pressing
  keeperDepthFactor: number; // fraction de la distance au tireur
  keeperMaxDepth: number; // m
  muRole: number; // s, pénalité d'une tâche hors de la zone naturelle du rôle
  maxTaskTime: number; // s, temps d'arrivée maximal pour une tâche non « recover »
  minReassignGain: number; // s, gain minimal de coût total pour changer l'affectation
  containOffset: number; // m, distance côté but du porteur en mode « contain »
  tackleRadius: number; // m
}

export interface SimParams {
  physics: PhysicsParams;
  models: ModelParams;
  decision: DecisionWeights;
  offBall: OffBallWeights;
  defence: DefenceWeights;
  /** Période de re-décision (s). */
  decisionPeriod: number;
  /** Résolution des champs (m). */
  fieldCellSize: number;
  /** Durée de la fenêtre de transition après un changement de possession (s). */
  transitionWindow: number;
}

export interface MatchConfig {
  seed: number;
  tactics: Record<TeamId, TacticConfig>;
  params: SimParams;
  /** Durée du match simulé (s) — les expériences utilisent typiquement 600 s. */
  durationSec: number;
  teamNames?: Record<TeamId, string>;
}
