/**
 * SIMULATION FACTICE (mode démo) — utilisée tant que le moteur réel n'est pas chargé.
 * Elle construit un état de match plausible (22 joueurs issus des formations, ballon, champs
 * spatiaux synthétiques, décisions illustratives) et l'anime doucement pour que l'interface
 * soit démontrable. Aucune logique de ce fichier n'est utilisée par le moteur réel.
 */
import type {
  Candidate, Decision, DecisionContext, FieldSet, MatchConfig, MatchState, MoveIntent, Player,
  PlayerAttributes, ScoreComponent, TeamId, TeamStats, MatchEvent,
} from '@/core/types';
import { attackDir, otherTeam } from '@/core/types';
import { ScalarField } from '@/core/grid';
import { PITCH, goalCentre, goalAngle, clampToPitch } from '@/core/pitch';
import { Rng } from '@/core/rng';
import { add, dist, normalize, scale, sub, clamp01, sigmoid, type Vec2 } from '@/core/vec2';
import { FORMATIONS } from '@/tactics/formations';
import type { Simulation, StepOptions } from '@/engine/loop';

const emptyStats = (): TeamStats => ({
  goals: 0, shots: 0, shotsOnTarget: 0, xG: 0, passes: 0, passesCompleted: 0, throughBalls: 0,
  dribbles: 0, dribblesWon: 0, tackles: 0, interceptions: 0, turnovers: 0, possessionTime: 0,
  threatCreated: 0, decisions: 0, decisionMs: 0, regret: 0,
});

const gauss = (d2: number, sigma: number): number => Math.exp(-d2 / (2 * sigma * sigma));

/** Position d'un poste dans le repère terrain, ajustée au ballon (followX/followY). */
function slotWorldPos(team: TeamId, slotIndex: number, formation: MatchState['tactics'][TeamId]['formation'], ballPos: Vec2): Vec2 {
  const s = FORMATIONS[formation].slots[slotIndex];
  const dir = attackDir(team);
  // Repère équipe : le ballon est vu dans ce repère
  const bx = dir * ballPos.x, by = dir * ballPos.y;
  const x = s.x + bx * s.followX;
  const y = s.y + by * s.followY;
  return clampToPitch({ x: dir * x, y: dir * y }, 1.5);
}

function makePlayers(config: MatchConfig, rng: Rng, ballPos: Vec2): Player[] {
  const players: Player[] = [];
  for (const team of ['A', 'B'] as TeamId[]) {
    const formation = config.tactics[team].formation;
    const slots = FORMATIONS[formation].slots;
    for (let i = 0; i < 11; i++) {
      const id = (team === 'A' ? 0 : 11) + i;
      const attrs: PlayerAttributes = {
        pace: clamp01(0.5 + rng.normal(0, 0.08)), acceleration: clamp01(0.5 + rng.normal(0, 0.08)),
        passing: clamp01(0.5 + rng.normal(0, 0.08)), shooting: clamp01(0.5 + rng.normal(0, 0.08)),
        dribbling: clamp01(0.5 + rng.normal(0, 0.08)), defending: clamp01(0.5 + rng.normal(0, 0.08)),
        goalkeeping: slots[i].role === 'GK' ? 0.7 : 0.1,
      };
      const pos = slotWorldPos(team, i, formation, ballPos);
      players.push({
        id, team, number: i + 1, name: `${team}${i + 1}`, role: slots[i].role, slotIndex: i, attrs,
        pos: { ...pos }, vel: { x: 0, y: 0 },
        maxSpeed: config.params.physics.playerMaxSpeed * (0.85 + 0.3 * attrs.pace),
        maxAccel: config.params.physics.playerMaxAccel * (0.85 + 0.3 * attrs.acceleration),
        target: { ...pos }, targetSpeed: 2, decision: null, lastDecisionTime: 0, lastKickTime: 0,
      });
    }
  }
  return players;
}

/** Champs synthétiques : contrôle (softmin des temps d'arrivée), menace analytique, pression gaussienne. */
function computeFields(state: MatchState, config: MatchConfig): FieldSet {
  const cell = config.params.fieldCellSize;
  const beta = Math.max(0.05, config.params.models.controlBeta);
  const pr = config.params.models.pressureRadius;
  const rhoX = config.params.models.threatRhoX, rhoY = config.params.models.threatRhoY;
  const A = state.players.filter((p) => p.team === 'A');
  const B = state.players.filter((p) => p.team === 'B');
  const arrival = (ps: Player[], x: number, y: number): number => {
    // softmin des temps d'arrivée
    let acc = 0;
    for (const p of ps) {
      const tArr = Math.hypot(p.pos.x - x, p.pos.y - y) / Math.max(1, p.maxSpeed) + 0.3;
      acc += Math.exp(-tArr / beta);
    }
    return -beta * Math.log(Math.max(1e-9, acc));
  };
  const controlA = new ScalarField(cell).fill((x, y) => sigmoid((arrival(B, x, y) - arrival(A, x, y)) / 0.6));
  const threat = (dir: 1 | -1) => (x: number, y: number): number => {
    const gx = dir * PITCH.halfLength;
    const dx = Math.abs(gx - x);
    const t = Math.exp(-(dx * dx) / (2 * rhoX * rhoX) - (y * y) / (2 * rhoY * rhoY));
    const ang = goalAngle({ x, y }, dir) / Math.PI;
    return clamp01(0.85 * t + 0.6 * ang);
  };
  const threatA = new ScalarField(cell).fill(threat(1));
  const threatB = new ScalarField(cell).fill(threat(-1));
  const pressure = (ps: Player[]) => (x: number, y: number): number => {
    let s = 0;
    for (const p of ps) s += gauss((p.pos.x - x) ** 2 + (p.pos.y - y) ** 2, pr);
    return clamp01(s);
  };
  const pressureByA = new ScalarField(cell).fill(pressure(A));
  const pressureByB = new ScalarField(cell).fill(pressure(B));
  return { time: state.time, controlA, threatA, threatB, pressureByA, pressureByB };
}

const comp = (key: string, label: string, value: number, weight: number, contribution: number, unit?: string): ScoreComponent => ({
  key, label, value, unit, weight, contribution,
});

function passProbability(config: MatchConfig, d: number, pPasser: number, pReceiver: number, through: boolean): number {
  const m = config.params.models;
  if (through) return clamp01(sigmoid(m.through.base + m.through.distance * d + m.through.passerPressure * pPasser) * 0.92);
  return clamp01(sigmoid(m.pass.base + m.pass.distance * d + m.pass.longDistance * Math.max(0, d - 25) + m.pass.passerPressure * pPasser + m.pass.receiverPressure * pReceiver));
}

const REASON_BY_KEY: Record<string, [string, string]> = {
  progression: ['forte progression vers le but', 'peu de progression'],
  danger: ['zone d’arrivée dangereuse', 'zone d’arrivée peu menaçante'],
  risk: ['risque de perte faible', 'risque de perte élevé'],
  pressure: ['faible pression défensive', 'forte pression défensive'],
  space: ['espace disponible important', 'espace réduit'],
  support: ['bon soutien à la réception', 'peu de soutien'],
};

function buildReason(components: ScoreComponent[]): string {
  const sorted = [...components].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3);
  return sorted.map((c) => (c.contribution >= 0 ? REASON_BY_KEY[c.key]?.[0] : REASON_BY_KEY[c.key]?.[1]) ?? c.label).join(' + ');
}

/** Évalue un candidat à partir de son point d'arrivée (mock : utilité = P·V⁺ − (1−P)·V⁻ − C). */
function evaluate(
  state: MatchState, config: MatchConfig, owner: Player, target: Vec2, probability: number, threatDelta: number,
  timeCost: number, action: Candidate['action'], tac = state.tactics[owner.team].params,
): Candidate {
  const f = state.fields!;
  const dir = attackDir(owner.team);
  const w = config.params.decision;
  const threatFor = owner.team === 'A' ? f.threatA : f.threatB;
  const threatAgainst = owner.team === 'A' ? f.threatB : f.threatA;
  const pressureAgainst = owner.team === 'A' ? f.pressureByB : f.pressureByA;
  const control = owner.team === 'A' ? f.controlA.sample(target) : 1 - f.controlA.sample(target);
  const progression = dir * (target.x - owner.pos.x) / PITCH.length;
  const danger = threatFor.sample(target) - threatFor.sample(owner.pos) + threatDelta;
  const pressure = pressureAgainst.sample(target);
  const teammates = state.players.filter((p) => p.team === owner.team && p.id !== owner.id && dist(p.pos, target) < tac.supportDistance).length;
  const risk = threatAgainst.sample(target) * (1 - probability);
  const components: ScoreComponent[] = [
    comp('progression', 'Progression', progression * PITCH.length, w.wProgress * tac.progressionBias * 10, progression * 10 * w.wProgress * tac.progressionBias * 10, 'm'),
    comp('danger', 'Danger créé', danger, 1.0, danger * 1.0),
    comp('risk', 'Risque', risk, -w.lambdaRisk * (1.2 - tac.riskTolerance), -risk * w.lambdaRisk * (1.2 - tac.riskTolerance)),
    comp('pressure', 'Pression à l’arrivée', pressure, -0.35, -pressure * 0.35),
    comp('space', 'Espace (contrôle)', control, 0.4, (control - 0.5) * 0.4),
    comp('support', 'Soutien', teammates, w.wSupport * 2, teammates * w.wSupport * 2, 'joueurs'),
  ];
  const valueIfSuccess = Math.max(0.05, 0.4 + components.filter((c) => c.contribution > 0).reduce((s, c) => s + c.contribution, 0));
  const valueIfFailure = Math.max(0.02, 0.3 + threatAgainst.sample(target) * w.lambdaRisk);
  const cost = timeCost * w.wTime * 10 + Math.abs(components[3].contribution);
  const score = probability * valueIfSuccess - (1 - probability) * valueIfFailure - cost;
  return { action, score, probability, valueIfSuccess, valueIfFailure, components, reason: buildReason(components) };
}

/** Décision du porteur : passes, passe en profondeur, dribbles, tir, conservation. */
function decideOwner(state: MatchState, config: MatchConfig, owner: Player, computeMs: number): Decision {
  const f = state.fields!;
  const dir = attackDir(owner.team);
  const opp = state.players.filter((p) => p.team !== owner.team);
  const mates = state.players.filter((p) => p.team === owner.team && p.id !== owner.id && p.role !== 'GK');
  const pressureAgainst = owner.team === 'A' ? f.pressureByB : f.pressureByA;
  const pOwner = pressureAgainst.sample(owner.pos);
  const threatsOn = (from: Vec2, to: Vec2): number[] =>
    opp.filter((o) => {
      const ab = sub(to, from);
      const l2 = ab.x * ab.x + ab.y * ab.y;
      if (l2 < 1e-6) return false;
      const t = clamp01(((o.pos.x - from.x) * ab.x + (o.pos.y - from.y) * ab.y) / l2);
      const proj = add(from, scale(ab, t));
      return dist(o.pos, proj) < 4.5 && t > 0.05 && t < 0.95;
    }).map((o) => o.id);

  const cands: Candidate[] = [];
  // Passes au sol vers les coéquipiers les plus pertinents (les 5 plus proches, hors gardien)
  const byDist = [...mates].sort((a, b) => dist(a.pos, owner.pos) - dist(b.pos, owner.pos)).slice(0, 5);
  for (const m of byDist) {
    const d = dist(m.pos, owner.pos);
    const P = passProbability(config, d, pOwner, pressureAgainst.sample(m.pos), false);
    const c = evaluate(state, config, owner, m.pos, P, 0, d / 14, {
      type: 'pass', targetId: m.id, targetPoint: { ...m.pos }, kind: 'ground', speed: Math.min(config.params.physics.passSpeedMax, 8 + d * 0.4),
    });
    const th = threatsOn(owner.pos, m.pos);
    if (th.length) c.threats = th;
    cands.push(c);
  }
  // Passe en profondeur vers l'attaquant le plus avancé
  const fw = [...mates].sort((a, b) => dir * (b.pos.x - a.pos.x))[0];
  if (fw) {
    const tp = clampToPitch(add(fw.pos, { x: dir * 12, y: 0 }), 1);
    const d = dist(tp, owner.pos);
    const P = passProbability(config, d, pOwner, pressureAgainst.sample(tp), true);
    const c = evaluate(state, config, owner, tp, P, 0.05, d / 18, {
      type: 'pass', targetId: fw.id, targetPoint: tp, kind: 'through', speed: Math.min(config.params.physics.passSpeedMax, 12 + d * 0.4),
    });
    const th = threatsOn(owner.pos, tp);
    if (th.length) c.threats = th;
    cands.push(c);
  }
  // Dribbles
  for (const ang of [0, dir > 0 ? -0.6 : 0.6]) {
    const dv = { x: dir * Math.cos(ang), y: Math.sin(ang) };
    const tp = clampToPitch(add(owner.pos, scale(dv, 8)), 1);
    const m = config.params.models.dribble;
    const pathP = pressureAgainst.sample(add(owner.pos, scale(dv, 4)));
    const P = clamp01(sigmoid(m.base + m.pathPressure * pathP * 3 + m.distance * 8 + m.control * owner.attrs.dribbling));
    cands.push(evaluate(state, config, owner, tp, P, 0, 8 / 5, { type: 'dribble', direction: dv, distance: 8 }));
  }
  // Tir
  const goal = goalCentre(dir);
  const dGoal = dist(owner.pos, goal);
  {
    const m = config.params.models.shot;
    const P = clamp01(sigmoid(m.base + m.angle * goalAngle(owner.pos, dir) + m.distance * dGoal + m.keeperCoverage * 0.4 + m.pressure * pOwner));
    const c = evaluate(state, config, owner, goal, P, 0.15 * P, 0.4, { type: 'shoot', targetPoint: { x: goal.x, y: 1.5 }, power: 1 });
    c.valueIfSuccess = 1 + P;
    c.score = P * c.valueIfSuccess - (1 - P) * c.valueIfFailure - 0.25 - (dGoal > config.params.decision.shotMaxDistance ? 0.5 : 0);
    cands.push(c);
  }
  // Conservation
  {
    const m = config.params.models.hold;
    const close = opp.filter((o) => dist(o.pos, owner.pos) < 5).length;
    const P = clamp01(sigmoid(m.base + m.pressure * pOwner + m.closeOpponents * close));
    const c = evaluate(state, config, owner, owner.pos, P, -0.02, 1.5, { type: 'hold' });
    c.score -= 0.12 * state.tactics[owner.team].params.tempo;
    cands.push(c);
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen = cands[0];
  const context: DecisionContext = {
    phase: state.phase[owner.team], style: state.tactics[owner.team].style, formation: state.tactics[owner.team].formation,
    pressure: pOwner, availableTeammates: cands.filter((c) => c.action.type === 'pass' && c.probability > 0.6).length,
    localSuperiority: mates.filter((m) => dist(m.pos, owner.pos) < 15).length + 1 - opp.filter((o) => dist(o.pos, owner.pos) < 15).length,
  };
  const numberOf = (id: number) => state.players[id]?.number ?? id;
  const describe = (c: Candidate): string => {
    const a = c.action;
    if (a.type === 'pass') return `${a.kind === 'through' ? 'passe en profondeur' : 'passe'} vers le n°${numberOf(a.targetId)}`;
    if (a.type === 'dribble') return `dribble (${Math.round(a.distance)} m)`;
    if (a.type === 'shoot') return 'tir';
    if (a.type === 'hold') return 'conservation';
    return a.type;
  };
  const explanation = [
    `Porteur : n°${owner.number} (${owner.role}) — pression subie ${pOwner.toFixed(2)}, ${cands.length} options évaluées.`,
    `Choix : ${describe(chosen)} — score ${chosen.score.toFixed(3)} = ${chosen.probability.toFixed(2)}·${chosen.valueIfSuccess.toFixed(2)} − ${(1 - chosen.probability).toFixed(2)}·${chosen.valueIfFailure.toFixed(2)} − coûts.`,
    `Raison : ${chosen.reason}.`,
    cands[1] ? `Alternative : ${describe(cands[1])} (score ${cands[1].score.toFixed(3)}, écart ${(chosen.score - cands[1].score).toFixed(3)}).` : '',
    `Contexte : ${context.phase}, style ${context.style}, supériorité locale ${context.localSuperiority >= 0 ? '+' : ''}${context.localSuperiority}.`,
  ].filter(Boolean).join('\n');
  return { playerId: owner.id, time: state.time, chosen, candidates: cands, context, explanation, computeMs };
}

/** Décision de déplacement d'un joueur sans ballon (intention selon rôle et possession). */
function decideMove(state: MatchState, rng: Rng, p: Player, owner: Player, config: MatchConfig): Decision {
  const dir = attackDir(p.team);
  const attacking = state.possession === p.team;
  const slot = slotWorldPos(p.team, p.slotIndex, state.tactics[p.team].formation, state.ball.pos);
  let intent: MoveIntent = 'hold_shape';
  let target: Vec2 = slot;
  let markId: number | undefined;
  const opp = state.players.filter((o) => o.team !== p.team && o.role !== 'GK');
  if (p.role === 'GK') {
    intent = 'gk_position';
    const own = { x: -dir * PITCH.halfLength, y: 0 };
    const toBall = normalize(sub(state.ball.pos, own));
    target = add(own, scale(toBall, 4));
  } else if (attacking) {
    const dOwner = dist(p.pos, owner.pos);
    if (p.role === 'FW') intent = p.slotIndex % 2 === 0 ? 'run' : 'width';
    else if (p.role === 'MF') intent = dOwner < 18 ? 'support' : rng.bernoulli(0.5) ? 'exploit_space' : 'create_space';
    else intent = 'hold_shape';
    if (intent === 'run') target = clampToPitch(add(slot, { x: dir * 6, y: 0 }), 1);
    if (intent === 'width') target = clampToPitch({ x: slot.x, y: Math.sign(slot.y || 1) * Math.max(Math.abs(slot.y), 26) }, 1);
    if (intent === 'support') target = clampToPitch(add(owner.pos, { x: -dir * 6, y: (p.pos.y > owner.pos.y ? 1 : -1) * 9 }), 1);
    if (intent === 'exploit_space' || intent === 'create_space') target = clampToPitch(add(slot, { x: dir * 3, y: (p.slotIndex % 2 ? 1 : -1) * 4 }), 1);
  } else {
    const dBall = dist(p.pos, state.ball.pos);
    const nearestToBall = state.players.filter((o) => o.team === p.team && o.role !== 'GK').sort((a, b) => dist(a.pos, state.ball.pos) - dist(b.pos, state.ball.pos));
    if (nearestToBall[0]?.id === p.id) { intent = 'press'; target = add(state.ball.pos, scale(normalize(sub(p.pos, state.ball.pos)), 1.5)); }
    else if (nearestToBall[1]?.id === p.id) { intent = 'cover'; target = add(state.ball.pos, { x: -dir * 7, y: (p.pos.y > state.ball.pos.y ? 1 : -1) * 3 }); }
    else if (p.role === 'DF') {
      const att = opp.filter((o) => o.team !== p.team && o.role === 'FW').sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
      if (att && dist(att.pos, p.pos) < 16) { intent = 'mark'; markId = att.id; target = add(att.pos, { x: -dir * 1.8, y: 0 }); }
      else { intent = 'zone'; }
    } else if (p.role === 'MF') intent = dBall < 22 ? 'zone' : 'recover';
    else intent = 'recover';
    if (intent === 'zone' || intent === 'recover') target = slot;
  }
  const jitter = { x: rng.normal(0, 0.8), y: rng.normal(0, 0.8) };
  target = clampToPitch(add(target, jitter), 1);
  const speed = intent === 'press' || intent === 'run' ? 6 : 3.2;
  const gain = attacking ? 0.05 + 0.15 * state.fields!.threatA.sample(target) : 0.05;
  const mk = (t: Vec2, i: MoveIntent, s: number, m?: number): Candidate => ({
    action: { type: 'move', target: t, intent: i, speed, markId: m },
    score: s, probability: 1, valueIfSuccess: s, valueIfFailure: 0,
    components: [
      comp('space', 'Espace', state.fields!.controlA.sample(t), 0.3, 0.3 * (state.fields!.controlA.sample(t) - 0.5)),
      comp('slot', 'Structure', dist(t, slot), -config.params.offBall.wSlot / 10, -config.params.offBall.wSlot / 10 * dist(t, slot), 'm'),
      comp('threat', 'Menace', gain, 1, gain),
    ],
    reason: `déplacement « ${i} » vers la position de plus grande utilité`,
  });
  const chosen = mk(target, intent, 0.2 + gain, markId);
  const alt = mk(slot, 'hold_shape', 0.1 + gain * 0.5);
  return {
    playerId: p.id, time: state.time, chosen, candidates: [chosen, alt].sort((a, b) => b.score - a.score),
    context: { phase: state.phase[p.team], style: state.tactics[p.team].style, formation: state.tactics[p.team].formation, pressure: 0, availableTeammates: 0, localSuperiority: 0 },
    explanation: `Sans ballon : intention « ${intent} », cible (${target.x.toFixed(1)} ; ${target.y.toFixed(1)}).`,
    computeMs: 0.02,
  };
}

/** Crée une simulation factice conforme à l'interface `Simulation`. */
export function createMockSimulation(config: MatchConfig): Simulation {
  const rng = new Rng(config.seed);
  const ballPos = { x: 8, y: -6 };
  const players = makePlayers(config, rng, ballPos);
  // Porteur : un milieu de A, le plus proche du ballon
  const owner = players.filter((p) => p.team === 'A' && p.role === 'MF').sort((a, b) => dist(a.pos, ballPos) - dist(b.pos, ballPos))[0];
  owner.pos = { ...ballPos };
  owner.target = { ...ballPos };
  const state: MatchState = {
    time: 0, tick: 0, players,
    ball: { pos: { ...ballPos }, vel: { x: 0, y: 0 }, z: 0, vz: 0, ownerId: owner.id, lastTouchId: owner.id, flight: null },
    possession: 'A', possessionSince: 0,
    phase: { A: 'attack', B: 'defence' }, phaseSince: { A: 0, B: 0 },
    score: { A: 0, B: 0 }, restart: null,
    tactics: { A: { ...config.tactics.A, params: { ...config.tactics.A.params } }, B: { ...config.tactics.B, params: { ...config.tactics.B.params } } },
    stats: { A: emptyStats(), B: emptyStats() }, events: [], fields: null, lastKickoff: 'A',
  };
  state.fields = computeFields(state, config);
  const decisions = new Map<number, Decision>();
  let lastDecision = -1;
  let nextPassAt = 4;
  let flightEnd = 0;

  const pushEvent = (e: MatchEvent): void => {
    state.events.push(e);
    if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  };

  const decide = (): void => {
    const t0 = performance.now();
    state.fields = computeFields(state, config);
    const ownerId = state.ball.ownerId ?? state.ball.lastTouchId ?? 0;
    const o = state.players[ownerId];
    const dt = performance.now() - t0;
    for (const p of state.players) {
      const d = p.id === o.id && state.ball.ownerId === o.id ? decideOwner(state, config, p, dt + 0.6 + rng.uniform(0, 0.4)) : decideMove(state, rng, p, o, config);
      decisions.set(p.id, d);
      p.decision = d;
      p.lastDecisionTime = state.time;
      if (d.chosen.action.type === 'move') { p.target = d.chosen.action.target; p.targetSpeed = d.chosen.action.speed; }
      const ts = state.stats[p.team];
      ts.decisions++;
      ts.decisionMs += d.computeMs;
    }
  };
  decide();

  const step = (options?: StepOptions): void => {
    const dt = config.params.physics.dt;
    state.time += dt;
    state.tick++;
    if (state.possession) state.stats[state.possession].possessionTime += dt;
    if (state.time - lastDecision >= config.params.decisionPeriod) {
      lastDecision = state.time;
      decide();
      options?.onDecisions?.(decisions, state);
    }
    // Déplacements : lissage vers la cible
    for (const p of state.players) {
      if (state.ball.ownerId === p.id) continue;
      if (!p.target) continue;
      const d = sub(p.target, p.pos);
      const l = Math.hypot(d.x, d.y);
      const sp = Math.min(p.targetSpeed, p.maxSpeed) * Math.min(1, l / 2);
      const vel = l > 0.05 ? scale(d, sp / l) : { x: 0, y: 0 };
      p.vel = { x: p.vel.x * 0.85 + vel.x * 0.15, y: p.vel.y * 0.85 + vel.y * 0.15 };
      p.pos = add(p.pos, scale(p.vel, dt));
    }
    // Porteur : il conduit doucement le ballon vers l'avant, le ballon le suit
    const ownerId = state.ball.ownerId;
    if (ownerId !== null) {
      const o = state.players[ownerId];
      const dir = attackDir(o.team);
      const drift = { x: dir * 1.1, y: Math.sin(state.time * 0.7) * 0.5 };
      o.vel = { x: o.vel.x * 0.9 + drift.x * 0.1, y: o.vel.y * 0.9 + drift.y * 0.1 };
      o.pos = clampToPitch(add(o.pos, scale(o.vel, dt)), 1);
      state.ball.pos = add(o.pos, scale(normalize(o.vel), 0.5));
      state.ball.vel = { ...o.vel };
      // Passe factice périodique vers la cible de l'action optimale
      if (state.time >= nextPassAt) {
        const d = decisions.get(o.id);
        const cand = d?.candidates.find((c) => c.action.type === 'pass');
        if (cand && cand.action.type === 'pass') {
          const tgt = state.players[cand.action.targetId];
          const dur = Math.max(0.5, dist(o.pos, tgt.pos) / 14);
          state.ball.flight = { kind: cand.action.kind === 'through' ? 'through' : 'pass', kickerId: o.id, targetId: tgt.id, targetPoint: { ...tgt.pos }, origin: { ...state.ball.pos }, startTime: state.time, initialSpeed: cand.action.speed };
          state.ball.ownerId = null;
          state.ball.lastTouchId = o.id;
          o.lastKickTime = state.time;
          flightEnd = state.time + dur;
          state.stats[o.team].passes++;
          if (cand.action.kind === 'through') state.stats[o.team].throughBalls++;
          pushEvent({ time: state.time, kind: 'pass', team: o.team, playerId: o.id, targetId: tgt.id, pos: { ...o.pos }, value: cand.probability, label: `Passe n°${o.number} → n°${tgt.number} (P = ${cand.probability.toFixed(2)})` });
        }
        nextPassAt = state.time + rng.uniform(3.5, 6);
      }
    } else if (state.ball.flight) {
      // Ballon en vol : interpolation vers la cible
      const fl = state.ball.flight;
      const u = clamp01((state.time - fl.startTime) / Math.max(1e-3, flightEnd - fl.startTime));
      const tgt = state.players[fl.targetId ?? 0];
      const end = tgt ? tgt.pos : fl.targetPoint;
      state.ball.pos = { x: fl.origin.x + (end.x - fl.origin.x) * u, y: fl.origin.y + (end.y - fl.origin.y) * u };
      state.ball.z = fl.kind === 'through' ? 0 : 0.4 * Math.sin(Math.PI * u);
      state.ball.vel = scale(sub(end, fl.origin), 1 / Math.max(0.2, flightEnd - fl.startTime));
      if (u >= 1) {
        const receiver = state.players[fl.targetId ?? 0];
        state.ball.ownerId = receiver.id;
        state.ball.lastTouchId = receiver.id;
        state.ball.flight = null;
        state.ball.z = 0;
        state.stats[receiver.team].passesCompleted++;
        state.stats[receiver.team].threatCreated += Math.max(0, (receiver.team === 'A' ? state.fields!.threatA : state.fields!.threatB).sample(receiver.pos) - 0.05);
        pushEvent({ time: state.time, kind: 'pass_complete', team: receiver.team, playerId: receiver.id, pos: { ...receiver.pos }, label: `Passe réussie, n°${receiver.number} en possession` });
        // Renvoi vers le centre si l'on s'approche trop du but adverse (boucle de démo)
        if (Math.abs(receiver.pos.x) > 42) {
          const team = receiver.team;
          const shotP = 0.12 + rng.uniform(0, 0.2);
          state.stats[team].shots++;
          state.stats[team].xG += shotP;
          if (rng.bernoulli(0.5)) state.stats[team].shotsOnTarget++;
          pushEvent({ time: state.time, kind: 'shot', team, playerId: receiver.id, value: shotP, label: `Tir du n°${receiver.number} (xG ${shotP.toFixed(2)})` });
          // Le gardien adverse relance : changement de possession
          const gk = state.players.find((p) => p.team !== team && p.role === 'GK')!;
          state.ball.ownerId = gk.id;
          state.ball.lastTouchId = gk.id;
          state.ball.pos = { ...gk.pos };
          state.possession = gk.team;
          state.possessionSince = state.time;
          state.phase = { [team]: 'transition_defence', [gk.team]: 'transition_attack' } as MatchState['phase'];
          state.phaseSince = { A: state.time, B: state.time };
          state.stats[team].turnovers++;
          pushEvent({ time: state.time, kind: 'possession_change', team: gk.team, playerId: gk.id, label: `Relance du gardien de ${gk.team === 'A' ? 'l’équipe A' : 'l’équipe B'}` });
          nextPassAt = state.time + 2;
        }
        decide();
      }
    }
    // Fin de transition
    for (const team of ['A', 'B'] as TeamId[]) {
      if (state.time - state.phaseSince[team] > config.params.transitionWindow && state.phase[team].startsWith('transition')) {
        state.phase[team] = state.possession === team ? 'attack' : 'defence';
      }
    }
    if (state.possession && state.phase[state.possession] === 'defence') {
      state.phase[state.possession] = 'attack';
      state.phase[otherTeam(state.possession)] = 'defence';
    }
  };

  return {
    state, config, rng, decisions, step,
    advance(seconds: number, options?: StepOptions) {
      const n = Math.max(1, Math.round(seconds / config.params.physics.dt));
      for (let i = 0; i < n; i++) step(options);
    },
  };
}
