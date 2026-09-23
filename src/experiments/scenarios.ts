/**
 * Bibliothèque de scénarios écrits à la main (§11.2) : situations figées, chacune avec le porteur
 * (protagoniste), l'ensemble des actions acceptables « de manuel », un KPI et une fonction de construction.
 *
 * Convention d'écriture : toutes les positions sont exprimées dans le REPÈRE DE L'ÉQUIPE ATTAQUANTE
 * (le protagoniste attaque vers +x', le but adverse est en x' = +52,5, y' < 0 = sa gauche), puis converties
 * dans le repère terrain selon `attackDir(team)`. L'équipe attaquante joue en 4-3-3 (postes 0 GK, 1 LB,
 * 2 LCB, 3 RCB, 4 RB, 5 DM, 6 LCM, 7 RCM, 8 LW, 9 ST, 10 RW) et l'équipe défendante en 4-4-2
 * (0 GK, 1 LB, 2 LCB, 3 RCB, 4 RB, 5 LM, 6 LCM, 7 RCM, 8 RM, 9 LS, 10 RS) sauf mention contraire ;
 * les positions de la défense sont données dans le repère de l'attaquant (son « LB » est donc à droite).
 */
import type { Action, FormationId, MatchState, Player, StyleId, TacticConfig, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { fromTeamFrame } from '../core/pitch';
import { buildFullState, emptyStats } from '../core/state-builder';
import { makeTactic } from '../tactics/styles';
import type { Vec2 } from '../core/vec2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ActionClass = 'pass' | 'through' | 'dribble' | 'shoot' | 'hold' | 'clear';
export const ACTION_CLASSES: readonly ActionClass[] = ['pass', 'through', 'dribble', 'shoot', 'hold', 'clear'] as const;

export interface AcceptableAction {
  cls: ActionClass;
  /** Destinataire imposé (identifiant global du joueur). */
  targetId?: number;
  /** Contrainte de direction (repère équipe). */
  direction?: 'forward' | 'backward';
}
export type Acceptable = ActionClass | AcceptableAction;

export type ScenarioKpi = 'xg' | 'threat' | 'possession';

export type ScenarioCategory = 'transition' | 'build_up' | 'wide' | 'possession' | 'finishing' | 'penetration' | 'pressing' | 'generated';

export const SCENARIO_CATEGORIES: Record<ScenarioCategory, string> = {
  transition: 'Transitions',
  build_up: 'Construction et relance',
  wide: 'Jeu sur les ailes',
  possession: 'Conservation et progression',
  finishing: 'Finition',
  penetration: 'Percussion et profondeur',
  pressing: 'Pressing et contre-pressing',
  generated: 'Scénarios générés',
};

export const KPI_LABELS: Record<ScenarioKpi, string> = { xg: 'xG sous 6 s', threat: 'menace créée sous 6 s', possession: 'possession conservée à 6 s' };

export interface Scenario {
  id: string;
  /** Nom court en français. */
  name: string;
  /** Description en français (1–2 phrases). */
  description: string;
  category: ScenarioCategory;
  /** Équipe du protagoniste. */
  team: TeamId;
  /** Identifiant global du porteur dont on juge la première décision. */
  protagonistId: number;
  acceptable: Acceptable[];
  kpi: ScenarioKpi;
  /** Réservé : jamais utilisé pour l'optimisation (validation seulement). */
  reserved?: boolean;
  /** Scénario procédural (générateur). */
  generated?: boolean;
  /** Construit un état complet (22 joueurs, ballon au protagoniste). */
  build(): MatchState;
  /** Copie positions, vitesses, ballon et possession dans un état vivant (panneau « scénarios » de l'interface). */
  apply(state: MatchState): void;
}

// ---------------------------------------------------------------------------
// Aide à l'écriture
// ---------------------------------------------------------------------------
/** [x', y'] ou [x', y', vx', vy'] dans le repère de l'équipe attaquante. */
export type Placement = [number, number] | [number, number, number, number];

export interface ScenarioSpec {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  kpi: ScenarioKpi;
  team?: TeamId;
  /** Indice de poste (0..10) du protagoniste dans l'équipe attaquante. */
  protagonist: number;
  /** Actions acceptables ; `target` désigne un indice de poste de l'équipe attaquante. */
  acceptable: (ActionClass | { cls: ActionClass; target?: number; direction?: 'forward' | 'backward' })[];
  reserved?: boolean;
  formations?: { att?: FormationId; def?: FormationId };
  styles?: { att?: StyleId; def?: StyleId };
  /** 11 placements (ordre des postes) pour l'équipe attaquante et pour la défense, repère attaquant. */
  att: Placement[];
  def: Placement[];
}

/** Identifiant global du poste `slot` de l'équipe `team`. */
export const idOf = (team: TeamId, slot: number): number => (team === 'A' ? slot : 11 + slot);

/** Copie l'état géométrique `src` (positions, vitesses, ballon, possession) dans l'état vivant `dst`. */
export function copyStateInto(dst: MatchState, src: MatchState): void {
  const byId = new Map<number, Player>(src.players.map((p) => [p.id, p]));
  for (const p of dst.players) {
    const s = byId.get(p.id);
    if (!s) continue;
    p.pos = { ...s.pos };
    p.vel = { ...s.vel };
    p.target = null;
    p.targetSpeed = 0;
    p.decision = null;
    p.lastDecisionTime = -1;
    p.role = s.role;
    p.slotIndex = s.slotIndex;
    p.lastKickTime = dst.time - 10;
  }
  dst.ball.pos = { ...src.ball.pos };
  dst.ball.vel = { ...src.ball.vel };
  dst.ball.z = 0;
  dst.ball.vz = 0;
  dst.ball.ownerId = src.ball.ownerId;
  dst.ball.lastTouchId = src.ball.lastTouchId;
  dst.ball.flight = null;
  dst.possession = src.possession;
  dst.possessionSince = dst.time;
  dst.phase = { ...src.phase };
  dst.phaseSince = { A: dst.time, B: dst.time };
  dst.restart = null;
  dst.tactics = { A: JSON.parse(JSON.stringify(src.tactics.A)), B: JSON.parse(JSON.stringify(src.tactics.B)) };
  dst.fields = null;
}

/** Fabrique un scénario à partir d'une spécification déclarative. */
export function defineScenario(spec: ScenarioSpec): Scenario {
  const team = spec.team ?? 'A';
  const def = otherTeam(team);
  const dir = attackDir(team);
  const attFormation = spec.formations?.att ?? '4-3-3';
  const defFormation = spec.formations?.def ?? '4-4-2';
  const attStyle = spec.styles?.att ?? 'balanced';
  const defStyle = spec.styles?.def ?? 'balanced';
  if (spec.att.length !== 11 || spec.def.length !== 11) throw new Error(`scénario ${spec.id} : 11 placements attendus par équipe`);
  const protagonistId = idOf(team, spec.protagonist);
  const acceptable: Acceptable[] = spec.acceptable.map((a) =>
    typeof a === 'string' ? a : { cls: a.cls, ...(a.target !== undefined ? { targetId: idOf(team, a.target) } : {}), ...(a.direction ? { direction: a.direction } : {}) },
  );
  const build = (): MatchState => {
    const tactics: Record<TeamId, TacticConfig> = {
      A: makeTactic(team === 'A' ? attFormation : defFormation, team === 'A' ? attStyle : defStyle),
      B: makeTactic(team === 'B' ? attFormation : defFormation, team === 'B' ? attStyle : defStyle),
    };
    const overrides: Record<number, { pos: Vec2; vel: Vec2 }> = {};
    const place = (t: TeamId, placements: Placement[]): void => {
      placements.forEach((pl, slot) => {
        overrides[idOf(t, slot)] = {
          pos: fromTeamFrame({ x: pl[0], y: pl[1] }, dir),
          vel: fromTeamFrame({ x: pl[2] ?? 0, y: pl[3] ?? 0 }, dir),
        };
      });
    };
    place(team, spec.att);
    place(def, spec.def);
    const state = buildFullState({ tactics, overrides, ownerId: protagonistId, ballPos: overrides[protagonistId].pos });
    state.possession = team;
    state.phase = { A: team === 'A' ? 'attack' : 'defence', B: team === 'B' ? 'attack' : 'defence' };
    state.stats = emptyStats();
    return state;
  };
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    team,
    protagonistId,
    acceptable,
    kpi: spec.kpi,
    reserved: spec.reserved ?? false,
    build,
    apply: (state) => copyStateInto(state, build()),
  };
}

// ---------------------------------------------------------------------------
// Classification des actions
// ---------------------------------------------------------------------------
/** Classe d'une action du porteur (null pour un déplacement). */
export function actionClassOf(action: Action): ActionClass | null {
  switch (action.type) {
    case 'pass': return action.kind === 'through' ? 'through' : 'pass';
    case 'dribble': return 'dribble';
    case 'shoot': return 'shoot';
    case 'hold': return 'hold';
    case 'clear': return 'clear';
    default: return null;
  }
}

/** Point d'arrivée d'une action (pour les contraintes de direction). */
function actionEndPoint(action: Action, from: Vec2): Vec2 | null {
  switch (action.type) {
    case 'pass': return action.targetPoint;
    case 'shoot': return action.targetPoint;
    case 'clear': return action.targetPoint;
    case 'dribble': return { x: from.x + action.direction.x * action.distance, y: from.y + action.direction.y * action.distance };
    case 'move': return action.target;
    default: return null;
  }
}

/** L'action choisie appartient-elle à l'ensemble acceptable du scénario ? */
export function isAcceptable(acceptable: readonly Acceptable[], action: Action, player: Pick<Player, 'pos' | 'team'>): boolean {
  const cls = actionClassOf(action);
  if (!cls) return false;
  const dir = attackDir(player.team);
  return acceptable.some((a) => {
    const spec: AcceptableAction = typeof a === 'string' ? { cls: a } : a;
    if (spec.cls !== cls) return false;
    if (spec.targetId !== undefined && !(action.type === 'pass' && action.targetId === spec.targetId)) return false;
    if (spec.direction) {
      const end = actionEndPoint(action, player.pos);
      if (!end) return false;
      const forward = (end.x - player.pos.x) * dir;
      if (spec.direction === 'forward' && forward <= 0) return false;
      if (spec.direction === 'backward' && forward >= 0) return false;
    }
    return true;
  });
}

export const ACTION_CLASS_LABELS: Record<ActionClass, string> = {
  pass: 'passe', through: 'passe en profondeur', dribble: 'dribble', shoot: 'tir', hold: 'conservation', clear: 'dégagement',
};

/** Description française d'un ensemble acceptable (« passe → 8, dribble (avant) »). */
export function describeAcceptable(acceptable: readonly Acceptable[]): string {
  return acceptable.map((a) => {
    if (typeof a === 'string') return ACTION_CLASS_LABELS[a];
    let s = ACTION_CLASS_LABELS[a.cls];
    if (a.targetId !== undefined) s += ` → ${a.targetId}`;
    if (a.direction) s += a.direction === 'forward' ? ' (avant)' : ' (arrière)';
    return s;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------
const GK = 0, LB = 1, LCB = 2, RCB = 3, RB = 4, DM = 5, LCM = 6, RCM = 7, LW = 8, ST = 9, RW = 10;

export const SCENARIOS: Scenario[] = [
  defineScenario({
    id: 'counter_3v2', name: 'Contre-attaque 3 contre 2', category: 'transition', kpi: 'xg',
    description: 'Trois attaquants lancés face à deux centraux, le reste de la défense est pris à contre-pied. Il faut jouer vite vers l’avant : passe à un ailier, passe en profondeur ou percussion.',
    protagonist: ST,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'pass', target: RW }, { cls: 'through', direction: 'forward' }, { cls: 'dribble', direction: 'forward' }],
    styles: { att: 'counter' },
    att: [[-46, 0], [-25, -22], [-30, -6], [-30, 6], [-25, 22], [-12, 0], [-5, -10, 4, 0], [-5, 10, 4, 0], [16, -14, 6.5, 0], [12, 0, 6, 0], [16, 14, 6.5, 0]],
    def: [[47, 0], [-2, 26, 6, 0], [26, -5, -2, 0], [26, 5, -2, 0], [-2, -26, 6, 0], [-6, 18, 6, 0], [-4, 6, 6, 0], [-4, -6, 6, 0], [-6, -18, 6, 0], [-20, 6, 3, 0], [-20, -6, 3, 0]],
  }),
  defineScenario({
    id: 'build_up_high_press', name: 'Construction sous pressing haut', category: 'build_up', kpi: 'possession',
    description: 'Le central gauche est pressé par deux attaquants, le milieu est marqué. Les sorties sûres sont le latéral gauche libre et le gardien ; un dégagement reste acceptable.',
    protagonist: LCB,
    acceptable: [{ cls: 'pass', target: LB }, { cls: 'pass', target: GK }, 'clear'],
    styles: { def: 'high_press' },
    att: [[-48, 0], [-30, -28], [-36, -8], [-36, 8], [-30, 26], [-26, 0], [-18, -12], [-18, 12], [0, -26], [2, 0], [0, 26]],
    def: [[46, 0], [14, 24], [16, 6], [16, -6], [14, -24], [-14, 18], [-24, 2], [-16, -12], [-14, -24], [-33, 4, -4, -2], [-32, -10, -5, 0]],
  }),
  defineScenario({
    id: 'wing_overload', name: 'Surnombre sur l’aile', category: 'wide', kpi: 'threat', reserved: true,
    description: 'Ailier et latéral gauches en surnombre face à un seul défenseur ; le milieu porteur doit servir l’aile ou lancer dans le dos.',
    protagonist: LCM,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'pass', target: LB }, { cls: 'through', direction: 'forward' }],
    att: [[-46, 0], [12, -30, 5, 0], [-20, -8], [-20, 8], [-8, 26], [-6, 0], [8, -18], [4, 10], [22, -27, 4, 0], [24, -2], [18, 24]],
    def: [[47, 0], [24, 20], [28, 6], [28, -6], [18, -22], [6, 20], [8, 4], [10, -6], [2, -10, 2, -3], [-10, 6], [-10, -4]],
  }),
  defineScenario({
    id: 'low_block_vs_possession', name: 'Bloc bas contre possession', category: 'possession', kpi: 'threat',
    description: 'Bloc adverse compact à 30 m de son but ; le milieu défensif a le temps. Faire circuler (passe, conservation) ou progresser en conduite : pas de tir lointain ni de ballon forcé dans la surface.',
    protagonist: DM,
    acceptable: ['pass', 'dribble', 'hold'],
    styles: { att: 'possession', def: 'low_block' },
    att: [[-40, 0], [26, -30], [6, -10], [6, 10], [26, 30], [14, 0], [24, -12], [24, 12], [36, -24], [38, 0], [36, 24]],
    def: [[49, 0], [41, 14], [42, 5], [42, -5], [41, -14], [33, 16], [33, 5], [33, -5], [33, -16], [24, 4], [24, -4]],
  }),
  defineScenario({
    id: 'one_v_one_keeper', name: 'Un contre un face au gardien', category: 'finishing', kpi: 'xg',
    description: 'L’attaquant a passé la ligne défensive et file vers le gardien, poursuivi à six mètres. Tirer ou continuer sa course vers le but.',
    protagonist: ST,
    acceptable: ['shoot', { cls: 'dribble', direction: 'forward' }],
    att: [[-46, 0], [-6, -24], [-16, -6], [-16, 6], [-6, 24], [2, 0], [10, -10], [10, 10], [30, -18, 4, 0], [38, 2, 5.5, 0], [30, 18, 4, 0]],
    def: [[47.5, 0], [26, 18, 5, -1], [32, -4, 6, 0.5], [31, 7, 6, -0.5], [26, -18, 5, 1], [14, 20, 3, 0], [16, 6, 4, 0], [16, -6, 4, 0], [14, -20, 3, 0], [-8, 6], [-8, -6]],
  }),
  defineScenario({
    id: 'offside_trap', name: 'Piège du hors-jeu', category: 'penetration', kpi: 'possession', reserved: true,
    description: 'L’avant-centre est parti trop tôt : il est hors-jeu derrière une ligne à quatre alignée. Il faut jouer sur les ailiers en position licite, conserver ou conduire, surtout pas lancer l’avant-centre.',
    protagonist: RCM,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'pass', target: RW }, { cls: 'pass', target: DM }, { cls: 'pass', target: LCM }, 'dribble', 'hold'],
    att: [[-46, 0], [-10, -26], [-18, -8], [-18, 8], [-6, 26], [-4, 0], [4, -10], [8, 8], [24, -20], [30, -2, 1, 0], [25, 24]],
    def: [[48, 0], [26, 22], [26, 6], [26, -6], [26, -22], [10, 22], [12, 0], [12, 10], [10, -20], [-6, 6], [-6, -6]],
  }),
  defineScenario({
    id: 'press_trigger', name: 'Déclencheur de pressing', category: 'pressing', kpi: 'possession', team: 'B',
    description: 'Passe en retrait mal dosée : le central est pris par le pressing déclenché (attaquant à trois mètres, second presseur qui coupe la ligne vers l’autre central). Sortie par le gardien, le latéral libre ou un dégagement.',
    protagonist: LCB,
    acceptable: [{ cls: 'pass', target: GK }, { cls: 'pass', target: LB }, 'clear'],
    styles: { def: 'high_press' },
    att: [[-49, 0], [-36, -27], [-40, -6], [-40, 8], [-34, 26], [-30, 0], [-22, -12], [-22, 12], [-4, -26], [-2, 0], [-4, 26]],
    def: [[46, 0], [10, 22], [10, 6], [10, -6], [10, -22], [-18, 20], [-28, 2], [-20, -12], [-18, -24], [-36, 4, -5, -1], [-37, -8, -6, 1]],
  }),
  defineScenario({
    id: 'switch_of_play', name: 'Renversement de jeu', category: 'wide', kpi: 'threat',
    description: 'Le bloc adverse a basculé côté droit ; l’ailier et le latéral gauches sont seuls à vingt mètres de tout adversaire. Le milieu porteur doit renverser (passe longue ou en profondeur côté opposé).',
    protagonist: RCM,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'pass', target: LB }, { cls: 'through', target: LW }],
    att: [[-46, 0], [0, -30], [-22, -8], [-20, 10], [10, 32], [-10, 6], [-2, 4], [4, 22], [18, -28], [22, 2], [20, 30]],
    def: [[48, 0], [30, 26], [30, 12], [30, -2], [28, -14], [10, 30], [8, 18, -3, 0], [10, 6], [12, -6], [-8, 14], [-8, 2]],
  }),
  defineScenario({
    id: 'no_pass_option', name: 'Impasse sans solution de passe', category: 'possession', kpi: 'possession', reserved: true,
    description: 'Tous les coéquipiers sont marqués côté but, y compris la ligne vers le gardien, et deux presseurs arrivent. Conduire pour sortir de la zone, conserver ou dégager ; toute passe est un pari.',
    protagonist: LCM,
    acceptable: ['dribble', 'hold', 'clear'],
    att: [[-46, 0], [-16, -28], [-24, -8], [-24, 8], [-14, 28], [-12, 0], [-2, -8], [-2, 10], [14, -24], [18, 0], [14, 24]],
    def: [[48, 0], [15, 25], [19, 1], [15, -23], [-13, -27], [-1, 11], [-10, 1], [1, -6, -3, -1], [-22, -7], [-23, 9], [-14, -6, 3, 2]],
  }),
  defineScenario({
    id: 'shoot_or_cutback', name: 'Tir ou remise en retrait', category: 'finishing', kpi: 'xg',
    description: 'L’ailier droit arrive dans la surface avec un angle fermé et deux défenseurs sur la ligne de tir, tandis que l’avant-centre est seul au point de penalty. La remise en retrait vaut plus que le tir, qui reste défendable.',
    protagonist: RW,
    acceptable: [{ cls: 'pass', target: ST }, 'shoot'],
    att: [[-40, 0], [20, -26], [8, -8], [8, 8], [28, 26], [20, 0], [30, -10], [34, 8], [40, -14], [41, -2], [45, 13, 3, -1]],
    def: [[50, 1], [46, 9, -1, 1], [47, 4], [44, -8], [38, -18], [38, 14, 2, -2], [36, 2], [32, -4], [30, -14], [10, 6], [10, -6]],
  }),
  defineScenario({
    id: 'keeper_distribution', name: 'Relance du gardien', category: 'build_up', kpi: 'possession',
    description: 'Le gardien a le ballon au pied, deux attaquants adverses ferment les centraux sans les marquer strictement, les latéraux sont libres. Relancer court vers un défenseur ou long si nécessaire.',
    protagonist: GK,
    acceptable: [{ cls: 'pass', target: LB }, { cls: 'pass', target: RB }, { cls: 'pass', target: LCB }, { cls: 'pass', target: RCB }, 'clear'],
    att: [[-48, 0], [-32, -30], [-40, -14], [-40, 14], [-32, 30], [-26, 0], [-20, -12], [-20, 12], [-2, -26], [0, 0], [-2, 26]],
    def: [[46, 0], [12, 22], [12, 6], [12, -6], [12, -22], [-14, 20], [-23, 1], [-17, -12], [-14, -24], [-36, 10, -2, 1], [-36, -10, -2, -1]],
  }),
  defineScenario({
    id: 'through_ball_high_line', name: 'Passe en profondeur contre une ligne haute', category: 'penetration', kpi: 'xg', reserved: true,
    description: 'La défense tient une ligne à quinze mètres de la médiane et l’avant-centre, en position licite, lance sa course dans le dos. Le milieu défensif doit jouer la profondeur immédiatement.',
    protagonist: DM,
    acceptable: ['through', { cls: 'pass', target: ST }],
    styles: { def: 'high_press' },
    att: [[-46, 0], [-14, -28], [-24, -8], [-24, 8], [-14, 28], [-6, 0], [0, -12], [0, 12], [12, -22, 3, 0], [13, 3, 6.5, 0.5], [12, 22, 3, 0]],
    def: [[46, 0], [15, 20], [15, 6], [15, -6], [15, -20], [-2, 18], [-2, 4], [-2, -5], [-2, -18], [-16, 8], [-16, -8]],
  }),
  defineScenario({
    id: 'crowded_box', name: 'Surface encombrée (situation de corner)', category: 'finishing', kpi: 'xg',
    description: 'Ballon près du poteau de corner, huit défenseurs dans la surface et quatre attaquants à l’affût. Centrer vers un coéquipier ou conserver pour ressortir le ballon ; un tir depuis l’angle n’a aucune valeur.',
    protagonist: RW,
    acceptable: ['pass', 'hold'],
    att: [[-40, 0], [30, -24], [20, -6], [20, 6], [36, 26], [28, 2], [42, -8], [40, 10], [44, -6], [45, 2], [46, 28]],
    def: [[50, 0], [46, 12], [46, 4], [46, -4], [44, -10], [44, 24], [42, 8], [42, -2], [40, -8], [36, 14], [36, 4]],
  }),
  defineScenario({
    id: 'counter_press_after_loss', name: 'Contre-pressing après une perte', category: 'pressing', kpi: 'possession', team: 'B',
    description: 'L’équipe vient de récupérer le ballon mais quatre adversaires referment en moins de six mètres (contre-pressing). Sortir de la nasse par une passe longue vers l’avant-centre ou l’ailier libre, sinon dégager.',
    protagonist: LCM,
    acceptable: [{ cls: 'pass', target: ST }, { cls: 'through', target: ST }, { cls: 'pass', target: RW }, 'clear'],
    styles: { def: 'high_press' },
    att: [[-47, 0], [-30, -26], [-34, -8], [-34, 8], [-24, 26], [-20, 3], [-12, -6], [-8, 12], [-6, -24], [18, 4], [14, 26]],
    def: [[48, 0], [28, 20], [30, 4], [30, -8], [24, -22], [-4, 16, 2, -3], [-14, -1, 1, -3], [-9, -4, -3, -1], [-10, -12, -1, 3], [-17, -4, 3, -1], [-8, -22, -1, 3]],
  }),
  defineScenario({
    id: 'overlap_right_2v1', name: 'Dédoublement côté droit (2 contre 1)', category: 'wide', kpi: 'threat', reserved: true,
    description: 'L’ailier droit fixe le latéral adverse pendant que son propre latéral dédouble à pleine vitesse. Servir le dédoublement (passe ou profondeur) ou dribbler le défenseur isolé.',
    protagonist: RW,
    acceptable: [{ cls: 'pass', target: RB }, { cls: 'through', target: RB }, 'dribble'],
    styles: { att: 'wide' },
    att: [[-42, 0], [16, -28], [4, -8], [4, 8], [36, 31, 6, 0], [14, 2], [22, -10], [24, 10], [34, -16], [36, -2], [34, 24]],
    def: [[48, 0], [38, 25, -1, 0], [40, 4], [40, -6], [36, -18], [24, 20, 4, 2], [28, 6], [26, -4], [20, -18], [0, 6], [0, -6]],
  }),
  defineScenario({
    id: 'two_v_one_box_edge', name: 'Deux contre un à l’entrée de la surface', category: 'finishing', kpi: 'xg',
    description: 'L’avant-centre et l’ailier arrivent lancés face au dernier défenseur, le gardien sur sa ligne. Fixer et donner à l’ailier libre, ou éliminer le défenseur.',
    protagonist: ST,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'through', target: LW }, { cls: 'dribble', direction: 'forward' }],
    att: [[-44, 0], [0, -26], [-10, -6], [-10, 6], [0, 26], [10, 0], [18, -12], [18, 12], [35, 8, 4, 0], [32, -4, 4, 0], [28, 22, 3, 0]],
    def: [[48, 0], [24, 22, 5, 0], [36, 0], [26, -8, 6, 0], [22, -20, 5, 0], [10, 20], [12, 6], [12, -6], [10, -20], [-10, 6], [-10, -6]],
  }),
  defineScenario({
    id: 'dribble_isolated_defender', name: 'Dribble face à un défenseur isolé', category: 'penetration', kpi: 'threat',
    description: 'L’ailier gauche est en un contre un contre le latéral, le couvreur le plus proche est à douze mètres et tous les coéquipiers sont marqués. Le dribble vers l’avant est la seule action de manuel.',
    protagonist: LW,
    acceptable: [{ cls: 'dribble', direction: 'forward' }],
    att: [[-44, 0], [10, -30], [-6, -8], [-6, 8], [12, 28], [6, 0], [20, -10], [16, 10], [28, -24], [30, -2], [24, 22]],
    def: [[48, 0], [28, 24], [32, 0], [34, -10], [32, -21], [14, 10], [8, 1], [22, -8], [12, -28], [-4, 6], [-4, -6]],
  }),
  defineScenario({
    id: 'back_pass_under_pressure', name: 'Passe en retrait sous pression', category: 'build_up', kpi: 'possession', reserved: true,
    description: 'Le latéral droit est coincé contre la touche par deux presseurs ; le central droit et le gardien sont libres derrière lui. Passe en retrait ou dégagement, pas de tentative vers l’avant.',
    protagonist: RB,
    acceptable: [{ cls: 'pass', target: RCB }, { cls: 'pass', target: GK }, 'clear'],
    att: [[-48, 0], [-24, -28], [-34, -6], [-32, 10], [-18, 30], [-22, 2], [-10, -12], [-8, 14], [6, -26], [8, 0], [4, 26]],
    def: [[46, 0], [18, 22], [18, 6], [18, -6], [18, -22], [-15, 28, -4, 1], [-6, 12], [-8, -8], [-4, -22], [-21, 26, 2, 3], [-24, 0]],
  }),
  defineScenario({
    id: 'long_diagonal_switch', name: 'Renversement long depuis la défense', category: 'wide', kpi: 'threat',
    description: 'Le bloc adverse presse côté gauche ; l’ailier et le latéral droits sont seuls sur l’autre aile. Le central gauche doit jouer la diagonale longue ou la profondeur côté opposé.',
    protagonist: LCB,
    acceptable: [{ cls: 'pass', target: RW }, { cls: 'pass', target: RB }, { cls: 'through', target: RW }],
    att: [[-47, 0], [-22, -30], [-28, -10], [-28, 8], [0, 30], [-18, -2], [-12, -14], [-10, 8], [10, -26], [16, -4], [16, 28]],
    def: [[48, 0], [28, 12], [28, -2], [26, -14], [24, -26], [4, 8], [-14, 0], [-10, -16], [6, -28], [-24, -6, -3, -2], [-26, -16, -2, 2]],
  }),
  defineScenario({
    id: 'striker_between_lines', name: 'Attaquant entre les lignes', category: 'penetration', kpi: 'threat',
    description: 'L’avant-centre décroche dans l’intervalle entre le milieu et la défense adverses, à plus de six mètres de tout adversaire. Le milieu défensif doit le trouver (passe au sol ou en profondeur).',
    protagonist: DM,
    acceptable: [{ cls: 'pass', target: ST }, 'through'],
    att: [[-46, 0], [-14, -28], [-24, -8], [-24, 8], [-14, 28], [-8, 0], [-2, -14], [-2, 14], [16, -24], [14, 1], [16, 24]],
    def: [[48, 0], [26, 20], [26, 5], [26, -5], [26, -20], [6, 18], [8, 5], [6, -6], [6, -18], [-14, 6], [-14, -6]],
  }),
  defineScenario({
    id: 'defensive_transition_5v3', name: 'Transition défensive 5 contre 3', category: 'transition', kpi: 'threat', team: 'B', reserved: true,
    description: 'Trois attaquants lancés face à cinq défenseurs qui se replient. Jouer vers l’avant sans forcer : passe, profondeur, conduite ou temporisation ; ni tir lointain ni dégagement.',
    protagonist: RCM,
    acceptable: [{ cls: 'pass', direction: 'forward' }, 'through', 'dribble', 'hold'],
    styles: { att: 'counter', def: 'low_block' },
    att: [[-46, 0], [-30, -26], [-34, -8], [-34, 8], [-30, 26], [-14, 0, 3, 0], [-4, -12, 4, 0], [6, 4, 5, 0], [12, -14, 6, 0], [12, 10, 6, 0], [-2, 24, 4, 0]],
    def: [[47, 0], [22, 18], [24, 6], [24, -6], [22, -18], [-8, 20, 6, 0], [20, 0, 4, 0], [-4, -4, 6, 0], [-8, -20, 6, 0], [-20, 8, 3, 0], [-20, -8, 3, 0]],
  }),
  defineScenario({
    id: 'cross_or_recycle', name: 'Centre ou conservation', category: 'wide', kpi: 'possession',
    description: 'Le latéral gauche est au niveau de la surface mais l’avant-centre est pris en tenaille par deux centraux et l’ailier est marqué. Ressortir le ballon vers le milieu libre plutôt que centrer à l’aveugle.',
    protagonist: LB,
    acceptable: [{ cls: 'pass', target: LCM }, { cls: 'pass', target: DM }],
    styles: { att: 'possession' },
    att: [[-42, 0], [34, -30], [6, -10], [6, 8], [24, 28], [16, -4], [24, -16], [22, 8], [38, -18], [40, -2], [34, 20]],
    def: [[49, 0], [40, 14], [43, -1], [42, -6], [38, -16], [30, 18], [28, 4], [30, -24, -2, -3], [36, -25, -1, -2], [10, 6], [10, -6]],
  }),
  defineScenario({
    id: 'shot_from_distance_or_pass', name: 'Frappe lointaine ou passe', category: 'finishing', kpi: 'xg',
    description: 'Le milieu droit a du temps à vingt-cinq mètres ; l’avant-centre est marqué mais l’ailier gauche file dans l’espace côté opposé. Servir la course (passe ou profondeur) ou avancer : la frappe lointaine vaut moins.',
    protagonist: RCM,
    acceptable: [{ cls: 'pass', target: LW }, { cls: 'through', target: LW }, { cls: 'dribble', direction: 'forward' }],
    att: [[-44, 0], [10, -28], [0, -8], [0, 8], [14, 28], [12, 0], [18, -12], [27, 3], [33, -15, 5, 1], [34, 3], [26, 22]],
    def: [[48, 0], [30, 18], [36, 4], [36, -6], [38, -20, -2, 2], [20, 10, 3, -3], [22, -2, 4, 2], [24, -12], [14, -24], [-4, 6], [-4, -6]],
  }),
  defineScenario({
    id: 'gk_under_pressure_clear', name: 'Gardien sous pression : dégagement', category: 'build_up', kpi: 'possession', reserved: true,
    description: 'Un attaquant arrive à pleine vitesse sur le gardien, les options courtes sont fermées. Dégager ou trouver un joueur libre loin du pressing (latéraux, central droit).',
    protagonist: GK,
    acceptable: ['clear', { cls: 'pass', target: LB }, { cls: 'pass', target: RB }, { cls: 'pass', target: RCB }],
    styles: { def: 'high_press' },
    att: [[-46, 2], [-28, -30], [-40, -12], [-40, 12], [-28, 30], [-30, 0], [-20, -12], [-20, 12], [-4, -26], [-2, 0], [-4, 26]],
    def: [[46, 0], [10, 22], [10, 6], [10, -6], [10, -22], [-14, 22], [-32, 2], [-22, -10], [-12, -24], [-42, 1, -6, 0], [-40, -8, -5, 1]],
  }),
  defineScenario({
    id: 'overlap_left_cross', name: 'Débordement et centre', category: 'wide', kpi: 'xg',
    description: 'L’ailier gauche a éliminé son vis-à-vis, le latéral dédouble le long de la touche et deux attaquants attaquent la surface à égalité numérique. Centrer, donner au dédoublement ou continuer la conduite.',
    protagonist: LW,
    acceptable: [{ cls: 'pass', target: ST }, { cls: 'pass', target: RW }, { cls: 'pass', target: LB }, 'dribble'],
    styles: { att: 'wide' },
    att: [[-40, 0], [43, -32, 6, 0], [14, -8], [14, 8], [30, 26], [24, -2], [30, -14], [32, 8], [41, -25], [44, -3], [42, 9]],
    def: [[50, 0], [44, 10], [46, -2], [44, -12], [43, -22, -1, -1], [34, 14], [36, 2], [34, -8], [32, -20], [12, 6], [12, -6]],
  }),
  defineScenario({
    id: 'midfield_progression', name: 'Progression au milieu', category: 'possession', kpi: 'threat',
    description: 'Le milieu défensif est sous une pression modérée ; le relayeur droit est libre devant lui alors que le gauche est marqué. Progresser par la passe vers le relayeur libre ou en conduite.',
    protagonist: DM,
    acceptable: [{ cls: 'pass', target: RCM }, { cls: 'dribble', direction: 'forward' }],
    att: [[-46, 0], [-16, -28], [-26, -8], [-26, 8], [-16, 28], [-10, 0], [-2, -12], [2, 10], [14, -24], [18, 0], [14, 24]],
    def: [[48, 0], [24, 20], [26, 6], [26, -6], [24, -20], [8, 16], [6, 2], [-4, -10], [8, -22], [-16, 6, 2, -2], [-4, -3, -3, 1]],
  }),
];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

export const getScenario = (id: string): Scenario | undefined => SCENARIO_BY_ID[id];

export const reservedScenarios = (list: readonly Scenario[] = SCENARIOS): Scenario[] => list.filter((s) => s.reserved);
export const trainingScenarios = (list: readonly Scenario[] = SCENARIOS): Scenario[] => list.filter((s) => !s.reserved);
