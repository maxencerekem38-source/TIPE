/**
 * Politiques de référence pour les expériences : aléatoire, gloutonne (passe la plus proche /
 * la plus avancée), sans lookahead, sans risque, défense « homme le plus proche ».
 */
import type { PolicySet } from './policy';

export declare const BASELINES: Record<string, PolicySet>;
