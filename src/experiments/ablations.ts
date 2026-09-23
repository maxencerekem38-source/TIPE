/**
 * Ablations de paramètres (§11.4-4) : chaque variante ϑ' est comparée au réglage par défaut
 * en graines appariées (même politique complète des deux côtés, seuls les paramètres diffèrent).
 */
import { FULL_REF, runPairedComparison, type PairedComparison, type PairedOptions, type PolicyRef } from './tournament';
import { FULL_POLICY_NAME } from './cli';

export interface Ablation {
  label: string;
  /** Surcharges ϑ (chemin → valeur). */
  flat: Record<string, number>;
  /** Ce que l'ablation isole (texte français). */
  isolates?: string;
}

/** Liste par défaut (codes B2, B4, B5, B8 et sensibilités K, β, η, τ_r du §11.3–11.4). */
export const DEFAULT_ABLATIONS: Ablation[] = [
  { label: 'γ = 0 (sans anticipation, B2)', flat: { 'decision.gamma': 0 }, isolates: 'l’anticipation à deux coups' },
  { label: 'λ_risk = 0 (B4)', flat: { 'decision.lambdaRisk': 0 }, isolates: 'le terme de risque' },
  { label: 'sans hystérésis (B8)', flat: { 'decision.hysteresis': 0, 'offBall.hysteresis': 0, 'defence.xiHysteresis': 0 }, isolates: 'la stabilité des intentions' },
  { label: 'K = 3', flat: { 'decision.topK': 3 }, isolates: 'la largeur de la recherche' },
  { label: 'K = 8', flat: { 'decision.topK': 8 }, isolates: 'la largeur de la recherche' },
  { label: 'β = 0,3 (≈ Voronoï, B5)', flat: { 'models.controlBeta': 0.3 }, isolates: 'le contrôle par temps d’arrivée' },
  { label: 'β = 3', flat: { 'models.controlBeta': 3 }, isolates: 'le contrôle par temps d’arrivée' },
  { label: 'η = 0,2', flat: { 'models.interceptEfficiency': 0.2 }, isolates: 'le modèle d’interception' },
  { label: 'η = 0,6', flat: { 'models.interceptEfficiency': 0.6 }, isolates: 'le modèle d’interception' },
  { label: 'τ_r = 0,2 s', flat: { 'models.reactionTime': 0.2 }, isolates: 'le temps de réaction' },
  { label: 'τ_r = 0,5 s', flat: { 'models.reactionTime': 0.5 }, isolates: 'le temps de réaction' },
];

export interface AblationResult {
  ablation: Ablation;
  comparison: PairedComparison;
}

/** Joue chaque ablation contre le réglage par défaut. */
export async function runAblations(ablations: readonly Ablation[], seeds: readonly number[], options: PairedOptions = {}): Promise<AblationResult[]> {
  const out: AblationResult[] = [];
  for (const ab of ablations) {
    const ref: PolicyRef = { label: ab.label, policy: FULL_POLICY_NAME, paramOverrides: ab.flat };
    const comparison = await runPairedComparison(ref, FULL_REF, seeds, { ...options, label: `${ab.label} vs défaut` });
    out.push({ ablation: ab, comparison });
  }
  return out;
}
