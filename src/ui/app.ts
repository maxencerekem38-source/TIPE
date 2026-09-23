/**
 * État de l'application : simulation, lecture/pause, vitesse, sélection, calques, tactiques,
 * paramètres, historiques ; accumulateur à pas fixe et publication/abonnement pour les panneaux.
 */
import type { Candidate, Decision, FormationId, MatchConfig, SimParams, StyleId, TacticParams, TeamId } from '@/core/types';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { makeTactic } from '@/tactics/styles';
import type { Vec2 } from '@/core/vec2';
import type { Simulation } from '@/engine/loop';
import { createSimulation } from '@/engine/loop';

/**
 * Fabrique de simulation : moteur réel, sinon simulation factice (mode démo).
 * POUR RETIRER LE MODE DÉMO : remplacer le corps par `return { sim: createSimulation(config), demo: false };`.
 */
function createSimulationSafe(config: MatchConfig): { sim: Simulation; demo: boolean } {
  return { sim: createSimulation(config), demo: false };
}

export const OVERLAY_IDS = ['control', 'threat', 'pressure', 'spaces', 'passLines', 'trajectories', 'moves', 'defence', 'labels'] as const;
export type OverlayId = (typeof OVERLAY_IDS)[number];

export interface OverlayMeta {
  id: OverlayId;
  label: string;
  hint: string;
  swatch: string;
  /** Une seule carte de chaleur à la fois. */
  heatmap: boolean;
}

export const OVERLAY_META: OverlayMeta[] = [
  { id: 'control', label: 'Contrôle du terrain', hint: 'Probabilité que chaque équipe contrôle un point (bleu = A, rouge = B).', swatch: 'linear-gradient(90deg,#ef4444,#e5e5e5,#3b82f6)', heatmap: true },
  { id: 'threat', label: 'Zones dangereuses', hint: 'Menace : valeur d’une position pour l’équipe en possession.', swatch: 'linear-gradient(90deg,rgba(251,191,36,0.1),#f97316,#dc2626)', heatmap: true },
  { id: 'pressure', label: 'Pression', hint: 'Pression exercée par l’équipe qui défend.', swatch: 'linear-gradient(90deg,rgba(167,139,250,0.1),#8b5cf6,#5b21b6)', heatmap: true },
  { id: 'spaces', label: 'Espaces disponibles', hint: 'Maxima locaux de contrôle × menace pour l’attaque.', swatch: '#fde68a', heatmap: false },
  { id: 'passLines', label: 'Lignes de passe', hint: 'Options du porteur : couleur = score, épaisseur = probabilité.', swatch: 'linear-gradient(90deg,#ef4444,#facc15,#22c55e)', heatmap: false },
  { id: 'trajectories', label: 'Trajectoires', hint: 'Trace du ballon et trajectoire prévue.', swatch: '#ffffff', heatmap: false },
  { id: 'moves', label: 'Déplacements', hint: 'Cibles de déplacement et intentions des joueurs.', swatch: '#60a5fa', heatmap: false },
  { id: 'defence', label: 'Affectations défensives', hint: 'Marquages, pressing et couvertures.', swatch: '#fb7185', heatmap: false },
  { id: 'labels', label: 'Étiquettes', hint: 'Noms et postes des joueurs.', swatch: '#cbd5e1', heatmap: false },
];

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export type AppEvent = 'sim' | 'ui' | 'reset';
type Listener = () => void;

export interface TrailPoint { x: number; y: number; z: number; t: number }

export interface Scenario {
  id: string;
  name: string;
  description: string;
  apply: (app: AppState) => void;
}

const TRAIL_SECONDS = 1.5;

export class AppState {
  sim!: Simulation;
  demoMode = false;
  config: MatchConfig;
  running = false;
  speed: (typeof SPEEDS)[number] = 1;
  selectedPlayerId: number | null = null;
  hoveredPlayerId: number | null = null;
  hoveredCandidate: Candidate | null = null;
  expandedCandidate = 0;
  overlays: Record<OverlayId, boolean> = {
    control: true, threat: false, pressure: false, spaces: false, passLines: true, trajectories: true, moves: false, defence: false, labels: false,
  };
  manualTactics: Record<TeamId, Partial<TacticParams>> = { A: {}, B: {} };
  ballTrail: TrailPoint[] = [];
  decisionHistory: Decision[] = [];
  /** Historique (temps, possession A, xG A, xG B) échantillonné toutes les secondes. */
  timeline: { t: number; possA: number; xgA: number; xgB: number }[] = [];
  fps = 0;
  private frameTimes: number[] = [];
  private accumulator = 0;
  private lastSampleT = -1;
  private listeners: Record<AppEvent, Set<Listener>> = { sim: new Set(), ui: new Set(), reset: new Set() };
  readonly scenarios: Scenario[] = [];

  constructor(config?: Partial<MatchConfig>) {
    this.config = {
      seed: 42,
      tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') },
      params: cloneParams(DEFAULT_PARAMS),
      durationSec: 600,
      teamNames: { A: 'Équipe A', B: 'Équipe B' },
      ...config,
    };
    this.buildSimulation();
  }

  private buildSimulation(): void {
    const { sim, demo } = createSimulationSafe(this.config);
    this.sim = sim;
    this.demoMode = demo;
    this.ballTrail = [];
    this.decisionHistory = [];
    this.timeline = [];
    this.accumulator = 0;
    this.lastSampleT = -1;
    this.recordTrail();
    this.recordDecision();
  }

  // ----------------------------------------------------------------- pub/sub
  on(event: AppEvent, fn: Listener): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }
  emit(event: AppEvent): void {
    for (const fn of this.listeners[event]) fn();
  }

  // ---------------------------------------------------------------- contrôle
  get state() { return this.sim.state; }
  get params(): SimParams { return this.sim.config.params; }

  play(): void { this.running = true; this.emit('ui'); }
  pause(): void { this.running = false; this.emit('ui'); }
  toggle(): void { this.running ? this.pause() : this.play(); }

  /** Avance d'un cycle de décision (période `decisionPeriod`). */
  step(): void {
    this.running = false;
    this.sim.advance(this.params.decisionPeriod);
    this.afterAdvance();
    this.emit('sim');
    this.emit('ui');
  }

  reset(): void {
    this.running = false;
    this.selectedPlayerId = null;
    this.hoveredCandidate = null;
    this.buildSimulation();
    this.emit('reset');
    this.emit('sim');
    this.emit('ui');
  }

  setSpeed(s: number): void {
    const best = SPEEDS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
    this.speed = best;
    this.emit('ui');
  }
  speedUp(): void { this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.speed) + 1)]); }
  speedDown(): void { this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.speed) - 1)]); }

  toggleOverlay(id: OverlayId, value?: boolean): void {
    const v = value ?? !this.overlays[id];
    const meta = OVERLAY_META.find((m) => m.id === id)!;
    if (meta.heatmap && v) for (const m of OVERLAY_META) if (m.heatmap && m.id !== id) this.overlays[m.id] = false;
    this.overlays[id] = v;
    this.emit('ui');
  }

  selectPlayer(id: number | null): void {
    this.selectedPlayerId = id;
    this.expandedCandidate = 0;
    this.hoveredCandidate = null;
    this.emit('ui');
  }

  setHoveredCandidate(c: Candidate | null): void {
    if (this.hoveredCandidate === c) return;
    this.hoveredCandidate = c;
    this.emit('ui');
  }

  /** Joueur mis en avant dans le panneau de décision : sélection, sinon porteur du ballon. */
  get focusPlayerId(): number | null {
    if (this.selectedPlayerId !== null) return this.selectedPlayerId;
    return this.state.ball.ownerId ?? this.state.ball.lastTouchId;
  }

  /** Décision affichée (celle du joueur mis en avant). */
  get focusDecision(): Decision | null {
    const id = this.focusPlayerId;
    if (id === null) return null;
    return this.sim.decisions.get(id) ?? this.state.players[id]?.decision ?? null;
  }

  // -------------------------------------------------------- tactiques / params
  setTactic(team: TeamId, patch: { formation?: FormationId; style?: StyleId }): void {
    const cur = this.state.tactics[team];
    const formation = patch.formation ?? cur.formation;
    const style = patch.style ?? cur.style;
    if (patch.style && patch.style !== cur.style) this.manualTactics[team] = {};
    const next = makeTactic(formation, style, this.manualTactics[team]);
    this.applyTactic(team, next);
  }

  setTacticParam(team: TeamId, key: keyof TacticParams, value: number): void {
    this.manualTactics[team][key] = value;
    const cur = this.state.tactics[team];
    this.applyTactic(team, makeTactic(cur.formation, cur.style, this.manualTactics[team]));
  }

  resetTacticParams(team: TeamId): void {
    this.manualTactics[team] = {};
    const cur = this.state.tactics[team];
    this.applyTactic(team, makeTactic(cur.formation, cur.style));
  }

  private applyTactic(team: TeamId, next: ReturnType<typeof makeTactic>): void {
    // Mutation en place : le moteur conserve ses références.
    for (const holder of [this.state.tactics[team], this.sim.config.tactics[team], this.config.tactics[team]]) {
      if (!holder) continue;
      holder.formation = next.formation;
      holder.style = next.style;
      Object.assign(holder.params, next.params);
    }
    this.emit('ui');
  }

  /** Modifie un paramètre par chemin (« decision.wProgress ») dans les objets vivants. */
  setParam(path: string, value: number): void {
    const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    for (const root of new Set([this.sim.config.params, this.config.params])) {
      let cur: any = root;
      for (let i = 0; i < tokens.length - 1; i++) cur = cur?.[tokens[i]];
      if (cur) cur[tokens[tokens.length - 1]] = value;
    }
    this.emit('ui');
  }

  resetParams(): void {
    const fresh = cloneParams(DEFAULT_PARAMS);
    for (const root of new Set([this.sim.config.params, this.config.params])) {
      for (const k of Object.keys(fresh) as (keyof SimParams)[]) {
        const v = fresh[k];
        if (typeof v === 'object' && v) Object.assign(root[k] as object, JSON.parse(JSON.stringify(v)));
        else (root as any)[k] = v;
      }
    }
    this.emit('ui');
  }

  // ---------------------------------------------------------------- scénarios
  registerScenario(s: Scenario): void { this.scenarios.push(s); this.emit('ui'); }
  loadScenario(id: string): void {
    const s = this.scenarios.find((x) => x.id === id);
    if (!s) return;
    this.running = false;
    s.apply(this);
    this.recordTrail();
    this.recordDecision();
    this.emit('sim');
    this.emit('ui');
  }

  // --------------------------------------------------------- boucle temporelle
  /**
   * À appeler à chaque image avec le temps réel écoulé (s). Fait avancer la simulation de
   * dt·vitesse par seconde réelle, par pas fixes, avec un rattrapage borné à 0,25 s.
   * Retourne vrai si la simulation a avancé (l'appelant émet alors « sim » à cadence limitée).
   */
  update(realDt: number): boolean {
    this.trackFps(realDt);
    if (!this.running) return false;
    this.accumulator += Math.min(0.25, realDt * this.speed);
    const dt = this.params.physics.dt;
    let advanced = false;
    while (this.accumulator >= dt) {
      this.sim.step();
      this.accumulator -= dt;
      advanced = true;
      this.recordTrail();
    }
    if (advanced) this.afterAdvance();
    return advanced;
  }

  private afterAdvance(): void {
    this.recordTrail();
    this.recordDecision();
    const t = Math.floor(this.state.time);
    if (t !== this.lastSampleT) {
      this.lastSampleT = t;
      const st = this.state.stats;
      const tot = st.A.possessionTime + st.B.possessionTime;
      this.timeline.push({ t: this.state.time, possA: tot > 0 ? st.A.possessionTime / tot : 0.5, xgA: st.A.xG, xgB: st.B.xG });
      if (this.timeline.length > 1200) this.timeline.shift();
    }
  }

  private recordTrail(): void {
    const b = this.state.ball;
    const t = this.state.time;
    const last = this.ballTrail[this.ballTrail.length - 1];
    if (last && last.t === t) return;
    this.ballTrail.push({ x: b.pos.x, y: b.pos.y, z: b.z, t });
    while (this.ballTrail.length && this.ballTrail[0].t < t - TRAIL_SECONDS) this.ballTrail.shift();
  }

  private recordDecision(): void {
    const owner = this.state.ball.ownerId;
    if (owner === null) return;
    const d = this.sim.decisions.get(owner);
    if (!d) return;
    const last = this.decisionHistory[this.decisionHistory.length - 1];
    if (last === d) return;
    this.decisionHistory.push(d);
    if (this.decisionHistory.length > 200) this.decisionHistory.shift();
  }

  private trackFps(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? 1 / avg : 0;
  }

  /** Latence moyenne de décision (ms) sur les deux équipes. */
  get decisionLatencyMs(): number {
    const s = this.state.stats;
    const n = s.A.decisions + s.B.decisions;
    return n ? (s.A.decisionMs + s.B.decisionMs) / n : 0;
  }

  /** Joueur le plus proche d'un point du monde (rayon en m). */
  playerAt(p: Vec2, radius = 2): number | null {
    let best: number | null = null, bd = radius;
    for (const pl of this.state.players) {
      const d = Math.hypot(pl.pos.x - p.x, pl.pos.y - p.y);
      if (d < bd) { bd = d; best = pl.id; }
    }
    return best;
  }
}
