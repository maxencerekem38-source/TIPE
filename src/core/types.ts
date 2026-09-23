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
  | { type: 'shoot'; targetPoint: Vec2; power: number }
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
// ---------------------------------------------------------------------------
export interface PhysicsParams {
  dt: number; // s, pas de simulation
  playerMaxSpeed: number; // m/s (joueur moyen)
  playerMaxAccel: number; // m/s²
  playerReactionTime: number; // s
  controlRadius: number; // m, rayon de prise de balle
  ballFriction: number; // m/s², décélération du ballon au sol
  passSpeedMin: number; // m/s
  passSpeedMax: number; // m/s
  shotSpeed: number; // m/s
  dribbleSpeedFactor: number; // fraction de la vitesse max avec le ballon
  kickCooldown: number; // s, délai minimal entre deux touches
}

export interface ModelParams {
  // Contrôle du terrain
  controlSigma: number; // s, pente de la sigmoïde temps d'arrivée
  controlReaction: number; // s
  // Pression
  pressureRadius: number; // m
  // Menace
  threatDistanceScale: number; // m
  threatAngleWeight: number;
  // Passe
  passInterceptMargin: number; // s, marge de temps donnant l'interception
  passLogitBase: number;
  passLogitDistance: number; // par mètre
  passLogitIntercept: number; // par unité de risque
  passLogitPressure: number;
  passLogitReceiverPressure: number;
  // Tir
  xgLogitBase: number;
  xgLogitDistance: number;
  xgLogitAngle: number;
  xgLogitKeeper: number;
  xgLogitBlockers: number;
  // Dribble
  dribbleLogitBase: number;
  dribbleLogitPressure: number;
  dribbleLogitSpace: number;
  // Conservation
  holdLogitBase: number;
  holdLogitPressure: number;
}

/** Poids de la fonction d'évaluation (modulés ensuite par les paramètres tactiques). */
export interface DecisionWeights {
  wThreat: number; // valeur de la menace de la position résultante
  wProgress: number; // progression vers le but
  wRisk: number; // pénalité de perte de balle (valeur de l'état adverse)
  wSpace: number; // espace/contrôle autour du receveur
  wPressure: number; // pénalité de pression au point d'arrivée
  wSupport: number; // qualité des options suivantes (lookahead 2e niveau)
  wHold: number; // biais de conservation
  wShot: number; // pondération du tir
  wHysteresis: number; // bonus de continuité pour l'action courante
  lookaheadDiscount: number; // gamma pour la valeur des options suivantes
  candidateDribbleDirections: number;
  dribbleDistance: number; // m
}

export interface DefenceWeights {
  wPressDistance: number;
  wMarkDistance: number;
  wMarkDanger: number;
  wCoverDepth: number;
  wZoneDistance: number;
  wSlotDistance: number;
  pressTriggerDistance: number; // m
  maxPressers: number;
}

export interface SimParams {
  physics: PhysicsParams;
  models: ModelParams;
  decision: DecisionWeights;
  defence: DefenceWeights;
  /** Période de re-décision (s). */
  decisionPeriod: number;
  /** Résolution des champs (m). */
  fieldCellSize: number;
}

export interface MatchConfig {
  seed: number;
  tactics: Record<TeamId, TacticConfig>;
  params: SimParams;
  /** Durée du match simulé (s) — les expériences utilisent typiquement 600 s. */
  durationSec: number;
  /** Noms et attributs optionnels des joueurs (sinon générés). */
  teamNames?: Record<TeamId, string>;
}
