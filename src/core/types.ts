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
  /** (moteur) Instant de début du dernier dribble — « dribble réussi » si le ballon est conservé 1,5 s après. */
  lastDribbleStart?: number;
  /** (moteur) Défenseur « passé » : immobile et sans nouveau duel jusqu'à cet instant. */
  beatenUntil?: number;
  /** (moteur) Instant du dernier duel engagé par ce joueur (au plus un duel par `physics.duelCooldown`), porteur compris. */
  lastDuelTime?: number;
  /** (moteur) Instant de la dernière prise de balle (délai de grâce `physics.duelCarrierGrace` avant un duel). */
  lastControlTime?: number;
  /** (moteur) Défenseur : instant d'entrée dans r_tackle du porteur (duel après `physics.duelContactTime` s de contact). */
  duelContactSince?: number;
  /** (moteur) Vitesse désirée lissée (retard du premier ordre τ_steer = `physics.steeringTau`, §7.2). */
  steerVel?: Vec2;
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
  /** (moteur) Issue d'un tir tirée au moment de la frappe (§3.3 : la physique rend l'animation cohérente). */
  outcome?: 'goal' | 'save' | 'miss';
  /** (moteur) Tir cadré : la trajectoire passe entre les poteaux, sous la barre. */
  onTarget?: boolean;
  /** (moteur) Receveur en position de hors-jeu au lancement de la passe (sifflé à la réception). */
  receiverOffside?: boolean;
  /** (moteur) Probabilité de réussite estimée par la couche décision (calibration §11.6). */
  expectedP?: number;
  /** (moteur) Ballon aérien déjà retombé une première fois (amortissement à l'atterrissage appliqué). */
  landed?: boolean;
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
  /** Adversaires susceptibles d'intercepter / contrer (pour la visualisation) ; le point faible (W = max φ) en tête. */
  threats?: number[];
  /** Adversaire réalisant le point faible de la ligne W = max φ (§4.6) — nommé dans l'explication du risque. */
  weakOpponentId?: number;
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
  // --- Champs optionnels ajoutés par src/models/fields.ts (append-only) ---
  /** Temps d'arrivée T_i(q) de chaque joueur (s), indexé comme `state.players`. */
  arrivalTime?: ScalarField[];
  /** Identifiant du joueur au plus petit temps d'arrivée en chaque cellule (−1 si aucun) — « espace disponible » §4.5. */
  argminPlayer?: Int16Array;
  /** Danger D = xT · PC_att pour A (attaque vers +x) et pour B (attaque vers −x). */
  dangerA?: ScalarField;
  dangerB?: ScalarField;
  /** Exposition E = Σ D Δ² / (L·W) : danger créé par A (subi par la défense de B) et réciproquement. */
  exposureA?: number;
  exposureB?: number;
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
  /** (moteur) Coup d'envoi après un but : les joueurs rejoignent leurs postes pendant le gel, puis sont replacés exactement à la reprise. */
  resetOnResume?: boolean;
}

export type MatchEventKind =
  | 'goal' | 'shot' | 'pass' | 'pass_complete' | 'pass_intercepted' | 'pass_failed'
  | 'dribble' | 'dribble_failed' | 'tackle' | 'turnover' | 'out' | 'restart' | 'save' | 'possession_change'
  | 'offside'
  // --- Ajouts du moteur (append-only) : tir contré (distinct d'un tacle), dégagement (distinct d'une passe) ---
  | 'block' | 'clearance';

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
  // --- Compteurs ajoutés par le moteur (append-only, optionnels : absents = 0) ---
  /** Décisions du porteur (passe, tir, dribble, conservation, dégagement) : dénominateur du regret (§11.1). */
  onBallDecisions?: number;
  /** Tirs contrés par un défenseur de champ (ne comptent pas comme des tacles). */
  blocks?: number;
  /** Dégagements (ne comptent pas comme des passes). */
  clearances?: number;
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
  /** (moteur, append-only) Dernière remise en jeu mise en place, conservée après la reprise (remetteur `playerId`) :
   * permet à la décision de traiter la première action du remetteur comme une remise (§3.4 : candidats restreints aux passes). */
  lastRestart?: Restart & { playerId?: number };
  /** (décision, append-only) Référence de ballon filtrée des postes instanciés (§7.2, lissage) : le coordonnateur la fait
   * suivre le ballon à `offBall.slotFollowRate` m/s au plus, pour que les postes (et le bloc) ne sautent pas à chaque cycle. */
  slotBallRef?: { time: number; pos: Vec2 };
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
  // --- Moteur (cinématique, prises de balle, duels, remises en jeu) ---
  speedNoise: number; // écart-type relatif du bruit sur la vitesse d'une frappe (0,05 = ±5 %)
  slowDownDistance: number; // m, distance de freinage à l'approche de la cible
  playerSeparation: number; // m, distance minimale entre deux joueurs (séparation douce)
  controlSlowBonus: number; // m, rayon de prise de balle supplémentaire sur un ballon lent
  controlSlowSpeed: number; // m/s, vitesse en dessous de laquelle le ballon est « lent »
  controlMaxHeight: number; // m, hauteur maximale d'un ballon contrôlable
  controlMaxRelSpeed: number; // m/s, vitesse relative ballon–joueur maximale pour une prise de balle
  kickerImmunity: number; // s, délai avant que le frappeur puisse reprendre son propre ballon
  duelCooldown: number; // s, délai minimal entre deux duels pour un même défenseur
  beatenFreeze: number; // s, immobilité d'un défenseur « passé »
  duelBase: number; // logit de base de la victoire du défenseur
  duelGoalSide: number; // bonus logit si le défenseur est côté but (de face)
  duelPressure: number; // logit par unité de pression sur le porteur
  duelSkill: number; // logit par unité d'écart (defending − dribbling)
  duelMinProb: number; // borne inférieure de P_win^def
  duelMaxProb: number; // borne supérieure de P_win^def
  tackleKeepProb: number; // probabilité que le tacleur conserve le ballon (sinon ballon libre)
  tackleLooseDistance: number; // m, distance à laquelle le ballon devient libre après un tacle
  restartFreeze: number; // s, gel après une remise en jeu (touche, six mètres, corner, hors-jeu)
  kickoffFreeze: number; // s, gel au coup d'envoi initial
  goalFreeze: number; // s, gel après un but (retour aux postes)
  saveProb: number; // probabilité d'arrêt du gardien sachant que le tir n'est pas but
  saveCornerProb: number; // probabilité qu'un arrêt soit dévié en corner
  keeperSaveRadius: number; // m, distance ballon–gardien à laquelle l'arrêt est constaté
  blockRadius: number; // m, rayon de contre d'un tir par un défenseur de champ
  blockWindow: number; // fraction initiale du vol pendant laquelle un tir peut être contré
  dribbleWonDelay: number; // s, conservation du ballon nécessaire pour compter un dribble réussi
  defaultShotXG: number; // xG utilisé si ni la décision ni le modèle ne le fournissent
  // --- Ajouts du moteur (append-only) ---
  duelClosingSpeed: number; // m/s, vitesse de rapprochement défenseur–porteur minimale pour qu'un duel soit engagé
  duelCarrierGrace: number; // s, délai après une prise de balle pendant lequel le porteur ne subit pas de duel
  duelContactTime: number; // s, contact continu (défenseur dans r_tackle) au bout duquel un duel est engagé même sans rapprochement
  takeOnRadius: number; // m, distance d'un adversaire en deçà de laquelle un dribble est un « dribble » (prise à défaut)
  lobLandingSpeed: number; // m/s, vitesse horizontale maximale conservée par un ballon aérien à son premier contact au sol
  lobBounce: number; // restitution verticale au premier contact au sol d'un ballon aérien (amortissement pelouse)
  /** τ_steer (s) : retard du premier ordre sur la vitesse désirée de chaque joueur (§7.2, lissage de direction), défaut 0,3 ; ≤ 0 = désactivé. */
  steeringTau?: number;
  /** Remises en jeu (§3.4) : distance minimale (m) des adversaires au ballon à la reprise (touche, corner, coup franc) ;
   * sur une sortie de but, les adversaires sont en outre replacés hors de la surface de réparation. Défaut 3. */
  restartClearance?: number;
}

/** Coefficients d'un modèle logistique P = σ(base + Σ coef·feature). */
export interface PassModel {
  base: number; distance: number; longDistance: number; passerPressure: number; receiverPressure: number;
  /** (modèles, append-only) Coefficient de l'excédent de vitesse d'arrivée max(0, s_arr − 9) (m/s) : une passe appuyée
   * (10 m/s) est plus difficile à contrôler pour le receveur (§5.1), défaut −0,1. */
  arrivalSpeed?: number;
  /** (modèles, append-only) Terme additif du logit d'une passe lobée (§5.1) : le ballon retombe à 2–3 m du point visé
   * (bruit d'exécution) et le receveur attend au point visé ; calibré sur la réussite observée des lobs (§11.6, 16 %
   * contre 42 % prédits sans ce terme), défaut −1,5. */
  lobPenalty?: number;
}
export interface ThroughModel {
  base: number; distance: number; passerPressure: number;
  /** (modèles, append-only) Marge de temps (s) accordée au receveur pour rejoindre le ballon après son passage au point visé (§5.2), défaut 0,6. */
  reachSlack?: number;
}
export interface DribbleModel { base: number; pathPressure: number; distance: number; control: number; /** coefficient du terme tanh(min_j T_j(q) − d/v_drib) (§5.3), défaut 1,0 */ race?: number }
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
  // --- Paramètres optionnels ajoutés par src/models (append-only, défauts dans params.ts) ---
  /** α_v : pondération de la vitesse de fermeture dans la pression (§4.4), défaut 0,5. */
  pressureClosing?: number;
  /** Couverture nominale du gardien utilisée par le substitut analytique de xT (§4.3 : −1,96 = base − 1,5·0,57), défaut 0,57. */
  threatKeeperCoverage?: number;
  /** Rayon d'action maximal du gardien (m), défaut 1,2 ; largeur du corps (m), défaut 1,8 (§5.4). */
  keeperReachMax?: number;
  keeperBodyWidth?: number;
  /** Influence des attributs individuels sur les logits : coef·(attribut − 0,5), défaut 0,6. */
  attributeInfluence?: number;
  /** t★ : horizon de la supériorité numérique locale (s), défaut 2,5 (§4.7). */
  superiorityHorizon?: number;
  /** R_s : rayon de l'espace disponible (m), défaut 8 (§4.5). */
  spaceRadius?: number;
  /** η_land : efficacité de la chance d'interception à l'atterrissage d'un ballon aérien (§4.6), défaut 0,6. */
  interceptLandingEfficiency?: number;
  /** t_land : fenêtre (s) après l'atterrissage pendant laquelle le ballon retombé reste disputable près du point de chute, défaut 0,3. */
  interceptLandingWindow?: number;
  /** w : demi-largeur (échantillons) de la fenêtre autour du meilleur point d'un défenseur dans l'agrégation « une chance par
   * défenseur » (§4.6) : Φ_j = 1 − Π_{|m − m*| ≤ w}(1 − φ_{j,m}) ; 0 = son meilleur point seul (max_m φ_{j,m}). Défaut 0 (calibration §11.6). */
  interceptWindow?: number;
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
  // --- Ajouts de la décision du porteur (append-only, optionnels : repli sur les défauts de evaluate.ts) ---
  /** xG minimal pour qu'un tir soit candidat (modulé : shotMinXg·(1,5 − shotEagerness)), défaut 0,04. */
  shotMinXg?: number;
  /** w_len : pénalité de longueur de passe (but par longueur de terrain) au-delà de tactic.supportDistance, ← ·(1 − directness), défaut 0,1. */
  wLength?: number;
  /** Part de la possession courante Θ(b) comptée perdue par un tir manqué (coût d'opportunité du tir), défaut 1. */
  wShotPossession?: number;
  /**
   * w_poss : part de la possession courante Θ(b) = xT(b)·PC_att(b) comptée perdue par l'échec d'une passe, d'un dribble,
   * d'une conservation ou d'un dégagement (coût d'opportunité de la possession, modulé par la tolérance au risque comme
   * λ_risk). Sans ce terme, une perte dans le camp adverse ne coûte que la (faible) menace adverse locale, et les passes
   * à 50 % battent les passes sûres. Défaut 0 (formule §6.2 d'origine).
   */
  wPossession?: number;
  /**
   * Nombre de réponses défensives évaluées en profondeur 2 (§6.3), dans l'ordre hold, press, cover, drop :
   * 4 = ensemble complet, minimum 2 = hold + press. Défaut 4 (mesure du coût : scripts/bench.ts, voir params.ts).
   */
  responseCount?: number;
  /**
   * Sous une réponse autre que hold, nombre des meilleures suites (trouvées sous hold) ré-évaluées sur l'état ajusté
   * pour obtenir G(a, r) ; 0 = régénération complète du jeu réduit (≈ 20 évaluations). Défaut 4.
   */
  responseReevaluate?: number;
  /** Engagement minimal (s) d'un dribble ou d'une conservation tirés au jeu 2×2 (§6.4 : « au moins 1 s »), défaut 1. */
  gameCommitMin?: number;
  /** Marge (m) de part et d'autre des poteaux : une passe au sol dont la course résiduelle (portée s₀²/2μ au-delà de la
   * cible) franchirait sa propre ligne de but à moins de goalHalfWidth + marge n'est pas un candidat (but contre son camp
   * si le receveur la manque). Défaut 1. */
  ownGoalMargin?: number;
  /** Distance (m) au-delà de laquelle un coéquipier est une cible « longue » (§6.1) : la passe appuyée (plus grande vitesse
   * de `passArrivalSpeeds`) ET la variante lobée sont toujours évaluées, ligne au sol fermée ou non. Défaut 25. */
  longPassDistance?: number;
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
  /** (décision hors-ballon) Bonus gaussien d'un candidat de soutien situé à `tactic.supportDistance` du ballon, défaut 0,1. */
  wSupport?: number;
  // --- Ajouts de la décision hors-ballon (append-only, défauts dans params.ts) ---
  /** Vitesse de consigne minimale (m/s) d'un déplacement sans ballon, défaut 2. */
  minSpeed?: number;
  /** Fraction de la vitesse de tempo v_max·(0,5 + 0,5·tempo) par intention (les appels restent au sprint) ; une cible
   * lointaine (> 5 m) tend linéairement vers la vitesse de tempo à 20 m. Défauts : conservation 0,35, soutien/largeur 0,5, espace 0,6. */
  intentSpeed?: { hold_shape: number; support: number; width: number; exploit_space: number; create_space: number };
  /** Distance (m) sous laquelle une cible « conservation de la structure » est remplacée par la position courante (le joueur tient sa place), défaut 1,5 (< 2 m : aucun saut de cible mesurable). */
  standDistance?: number;
  /** Vitesse maximale (m/s) de la référence de ballon des postes instanciés (`MatchState.slotBallRef`) ; ≤ 0 = ballon instantané. Défaut 5. */
  slotFollowRate?: number;
  /** Coût de déplacement (utilité par mètre entre la position courante et la cible) : un déplacement n'est entrepris que
   * s'il rapporte plus que ce coût (réalisme : distance parcourue, stabilité des cibles). Défaut 0,015. */
  wMove?: number;
  /** Fraction du bonus d'hystérésis accordée, à la récupération du ballon, à la cible de la tâche défensive précédente
   * (repli, zone, marquage…) pendant `reexamineEvery` s : le joueur termine son mouvement au lieu de changer de cible à
   * chaque bascule de possession. 0 = désactivé. Défaut 0,5. */
  transitionHysteresis?: number;
  /** Point de rencontre d'un ballon roulant (réception, course au ballon) : l'ancien point est conservé tant que le joueur
   * peut encore y être avant le ballon et que le nouveau point de rencontre n'est pas plus tôt de plus de cette durée (s). Défaut 0,5. */
  meetingKeepGain?: number;
  /** Plancher (m, repère équipe) des postes de champ instanciés en phase de possession : le glissement des postes vers
   * le ballon (followX) ne fait pas descendre les défenseurs sur leur ligne de but quand le gardien a le ballon (relance
   * de sortie de but). ≤ −52,5 = désactivé. Défaut −38 (2 m à l'intérieur de la surface de réparation). */
  slotFloorX?: number;
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
  // --- Ajouts de la décision défensive (append-only, défauts dans params.ts) ---
  /** Distance supplémentaire (m) de « contain » par unité de (1 − pressIntensity) : un bloc bas contient de plus loin, défaut 6. */
  containSlack?: number;
  /** Vitesses de consigne (fractions de v_max) des tâches non urgentes ; press / intercept / chase restent au sprint ;
   * zone et repli accélèrent linéairement vers le sprint entre 6 et 20 m de leur point (la ligne remonte vite).
   * Défauts : contain 0,7 ; zone 0,3 ; mark 0,45 + 0,3·priorité ; recover 0,25 + 0,3·recoverPriority. */
  taskSpeed?: { contain: number; zone: number; markBase: number; markGain: number; recoverBase: number; recoverGain: number };
  /** Distance (m) sous laquelle une tâche zone / repli est tenue sur place (cible = position courante), défaut 3. */
  standDistance?: number;
  /** Tenue de la ligne (§8.4) : les points de marquage et de zone ne descendent pas à plus de cette distance (m) derrière
   * la ligne du bloc (poste le plus bas des joueurs de champ) — un attaquant plus profond est laissé au hors-jeu.
   * Une grande valeur (≥ 100) désactive la tenue de ligne. Défaut 1. */
  lineHoldSlack?: number;
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
