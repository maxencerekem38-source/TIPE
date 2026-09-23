/**
 * Outils communs des scripts en ligne de commande : analyse des arguments (sans dépendance),
 * détection de la disponibilité du moteur (stubs « non implémenté »), construction de configurations,
 * écriture des résultats et petits formats français.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { FormationId, MatchConfig, SimParams, StyleId, TacticConfig, TeamId } from '../core/types';
import { FORMATION_IDS, STYLE_IDS } from '../core/types';
import { DEFAULT_PARAMS, cloneParams } from '../core/params';
import { makeTactic } from '../tactics/styles';
import * as loopModule from '../engine/loop';
import * as coordinatorModule from '../decision/coordinator';
import * as baselinesModule from '../decision/baselines';
import type { PolicySet } from '../decision/policy';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
export type FlagValue = string | boolean;

export interface ParsedArgs {
  flags: Record<string, FlagValue>;
  positional: string[];
}

/**
 * Analyse minimale : `--cle valeur`, `--cle=valeur`, `--drapeau` (booléen), `--no-drapeau`.
 * Les valeurs commençant par « - » suivies d'un chiffre sont acceptées comme nombres négatifs.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (body.startsWith('no-')) { flags[body.slice(3)] = false; continue; }
    const next = argv[i + 1];
    if (next !== undefined && (!next.startsWith('--') || /^-\d/.test(next))) { flags[body] = next; i++; }
    else flags[body] = true;
  }
  return { flags, positional };
}

export const numFlag = (args: ParsedArgs, key: string, fallback: number): number => {
  const v = args.flags[key];
  if (v === undefined || typeof v === 'boolean') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const strFlag = (args: ParsedArgs, key: string, fallback: string): string => {
  const v = args.flags[key];
  return v === undefined || typeof v === 'boolean' ? fallback : v;
};
export const boolFlag = (args: ParsedArgs, key: string, fallback = false): boolean => {
  const v = args.flags[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'non', 'no'].includes(v.toLowerCase());
};

/** « 4-3-3:possession » → TacticConfig (formation et style validés). */
export function parseTactic(spec: string, fallback: { formation: FormationId; style: StyleId } = { formation: '4-3-3', style: 'balanced' }): TacticConfig {
  const [f, s] = spec.split(':');
  const formation = (FORMATION_IDS as readonly string[]).includes(f) ? (f as FormationId) : fallback.formation;
  const style = s && (STYLE_IDS as readonly string[]).includes(s) ? (s as StyleId) : fallback.style;
  return makeTactic(formation, style);
}

export const tacticLabel = (t: TacticConfig): string => `${t.formation}:${t.style}`;

// ---------------------------------------------------------------------------
// Configuration de match
// ---------------------------------------------------------------------------
export interface ConfigOptions {
  seed?: number;
  minutes?: number;
  durationSec?: number;
  tacticA?: TacticConfig;
  tacticB?: TacticConfig;
  params?: SimParams;
  teamNames?: Record<TeamId, string>;
}

export function makeConfig(options: ConfigOptions = {}): MatchConfig {
  const durationSec = options.durationSec ?? (options.minutes ?? 10) * 60;
  return {
    seed: options.seed ?? 1,
    tactics: { A: options.tacticA ?? makeTactic('4-3-3', 'balanced'), B: options.tacticB ?? makeTactic('4-4-2', 'balanced') },
    params: options.params ? cloneParams(options.params) : cloneParams(DEFAULT_PARAMS),
    durationSec,
    teamNames: options.teamNames,
  };
}

// ---------------------------------------------------------------------------
// Disponibilité du moteur
// ---------------------------------------------------------------------------
export const NOT_IMPLEMENTED = 'non implémenté';

export const isNotImplemented = (err: unknown): boolean =>
  err instanceof Error ? err.message.includes(NOT_IMPLEMENTED) : String(err).includes(NOT_IMPLEMENTED);

let engineCache: { ok: boolean; reason: string } | null = null;
let simulationCache: { ok: boolean; reason: string } | null = null;

/**
 * Le moteur complet (simulation + couche décision) est-il utilisable ? On tente de créer une simulation
 * par défaut et d'avancer d'un pas avec l'algorithme complet. Résultat mis en cache.
 */
export function engineStatus(): { ok: boolean; reason: string } {
  if (engineCache) return engineCache;
  try {
    const sim = loopModule.createSimulation(makeConfig({ seed: 1, minutes: 1 }));
    sim.step();
    if (!coordinatorModule.FULL_POLICY) engineCache = { ok: false, reason: 'FULL_POLICY non défini' };
    else engineCache = { ok: true, reason: '' };
  } catch (err) {
    engineCache = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return engineCache;
}

/**
 * La simulation seule (physique, règles, création de match) est-elle utilisable ? On avance d'un pas
 * avec une fonction de décision factice (aucune décision), indépendamment de la couche décision.
 */
export function simulationStatus(): { ok: boolean; reason: string } {
  if (simulationCache) return simulationCache;
  try {
    const sim = loopModule.createSimulation(makeConfig({ seed: 1, minutes: 1 }));
    sim.step({ decide: () => new Map() });
    sim.advance(0.5, { decide: () => new Map() });
    simulationCache = { ok: true, reason: '' };
  } catch (err) {
    simulationCache = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return simulationCache;
}

export const engineAvailable = (): boolean => engineStatus().ok;
export const simulationAvailable = (): boolean => simulationStatus().ok;

/** Réinitialise les caches (tests). */
export const resetEngineStatus = (): void => { engineCache = null; simulationCache = null; };

export const ENGINE_UNAVAILABLE_MESSAGE = 'moteur non disponible';

// ---------------------------------------------------------------------------
// Politiques par nom
// ---------------------------------------------------------------------------
export const FULL_POLICY_NAME = 'full';

/** Noms des politiques disponibles (« full » + baselines). */
export function policyNames(): string[] {
  const b = baselinesModule.BASELINES ?? {};
  return [FULL_POLICY_NAME, ...Object.keys(b)];
}

/** Résout une politique par son nom ; lève une erreur « non implémenté » si la couche décision est absente. */
export function resolvePolicy(name: string): PolicySet {
  if (name === FULL_POLICY_NAME || name === 'B3') {
    const p = coordinatorModule.FULL_POLICY;
    if (!p) throw new Error(`${NOT_IMPLEMENTED} : FULL_POLICY`);
    return p;
  }
  const b = baselinesModule.BASELINES;
  if (!b) throw new Error(`${NOT_IMPLEMENTED} : BASELINES`);
  const p = b[name];
  if (!p) throw new Error(`politique inconnue : « ${name} » (disponibles : ${policyNames().join(', ')})`);
  return p;
}

export const resolvePolicies = (a: string, b: string): Record<TeamId, PolicySet> => ({ A: resolvePolicy(a), B: resolvePolicy(b) });

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------
export const RESULTS_DIR = resolve(process.cwd(), 'results');

export function writeResult(relativePath: string, content: string | object): string {
  const path = resolve(RESULTS_DIR, relativePath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

/** Hash git court (ou « inconnu »), pour tracer les résultats. */
export function gitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'inconnu';
  } catch {
    return 'inconnu';
  }
}

export const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - 60 * m)} s`;
}

/** Exécute `fn` et affiche « moteur non disponible » si le moteur est un stub. Retourne null dans ce cas. */
export async function withEngine<T>(fn: () => T | Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isNotImplemented(err)) {
      console.log(`${ENGINE_UNAVAILABLE_MESSAGE} (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    throw err;
  }
}

/** Liste de graines consécutives à partir de `start`. */
export const seedList = (n: number, start = 1): number[] => Array.from({ length: n }, (_, i) => start + i);
