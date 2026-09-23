/**
 * Panneau « Paramètres » : réglage en direct des principaux paramètres de l'algorithme (SimParams).
 * Les modifications sont appliquées en place dans sim.config.params.
 */
import { flattenParams } from '@/core/params';
import type { AppState } from '../app';
import { el, setSlider, slider } from '../dom';
import { fmtNumber } from '../format';

interface ParamSpec { path: string; label: string; min: number; max: number; step: number; hint: string; unit?: string }

const GROUPS: { group: string; items: ParamSpec[] }[] = [
  {
    group: 'Décision du porteur',
    items: [
      { path: 'decision.lambdaRisk', label: 'λ risque', min: 0, max: 3, step: 0.05, hint: 'Pondération de la valeur adverse en cas de perte de balle.' },
      { path: 'decision.wProgress', label: 'Poids progression', min: 0, max: 1, step: 0.01, hint: 'Valeur d’une progression d’une longueur de terrain.' },
      { path: 'decision.wSupport', label: 'Poids soutien', min: 0, max: 0.5, step: 0.01, hint: 'Valeur des options suivantes offertes au receveur.' },
      { path: 'decision.wTime', label: 'Coût du temps', min: 0, max: 0.1, step: 0.005, hint: 'Coût par seconde d’exécution de l’action.' },
      { path: 'decision.gamma', label: 'γ (anticipation)', min: 0, max: 1, step: 0.05, hint: 'Poids de la recherche à profondeur 2.' },
      { path: 'decision.topK', label: 'Top-K développés', min: 1, max: 12, step: 1, hint: 'Nombre de candidats développés en profondeur 2.' },
      { path: 'decision.hysteresis', label: 'Hystérésis', min: 0, max: 0.2, step: 0.005, hint: 'Bonus pour conserver l’intention courante.' },
      { path: 'decision.softmaxTemperature', label: 'Température softmax', min: 0, max: 0.5, step: 0.005, hint: 'Réponse quantale (0 = choix déterministe).' },
      { path: 'decision.shotMaxDistance', label: 'Distance max. de tir', min: 10, max: 50, step: 1, hint: 'Au-delà, le tir n’est pas envisagé.', unit: 'm' },
    ],
  },
  {
    group: 'Modèles spatiaux',
    items: [
      { path: 'models.controlBeta', label: 'β contrôle (softmin)', min: 0.05, max: 3, step: 0.05, hint: 'Température du softmin des temps d’arrivée (β→0 ⇒ Voronoï).', unit: 's' },
      { path: 'models.pressureRadius', label: 'Rayon de pression', min: 1, max: 10, step: 0.25, hint: 'Portée de la pression exercée par un défenseur.', unit: 'm' },
      { path: 'models.interceptEfficiency', label: 'Efficacité d’interception η', min: 0, max: 1, step: 0.05, hint: 'Efficacité de capture par échantillon d’interception.' },
      { path: 'models.threatRhoX', label: 'Menace ρx', min: 5, max: 50, step: 1, hint: 'Portée longitudinale de la menace.', unit: 'm' },
      { path: 'models.threatRhoY', label: 'Menace ρy', min: 5, max: 40, step: 1, hint: 'Portée latérale de la menace.', unit: 'm' },
    ],
  },
  {
    group: 'Physique et cadence',
    items: [
      { path: 'physics.playerMaxSpeed', label: 'Vitesse max. joueur', min: 4, max: 11, step: 0.1, hint: 'Vitesse maximale d’un joueur moyen.', unit: 'm/s' },
      { path: 'physics.ballFriction', label: 'Frottement du ballon', min: 0.2, max: 5, step: 0.1, hint: 'Décélération du ballon au sol.', unit: 'm/s²' },
      { path: 'decisionPeriod', label: 'Période de décision', min: 0.05, max: 1, step: 0.05, hint: 'Intervalle entre deux cycles de décision.', unit: 's' },
    ],
  },
];

export function createParamsPanel(app: AppState): HTMLElement {
  const root = el('div', { class: 'panel params-panel' });
  const rows = new Map<string, { row: HTMLElement; spec: ParamSpec }>();
  const fmt = (spec: ParamSpec) => (v: number) => fmtNumber(v, spec.step < 0.01 ? 3 : spec.step < 1 ? 2 : 0) + (spec.unit ? ` ${spec.unit}` : '');

  root.append(el('p', { class: 'help' }, 'Ces réglages modifient en direct les poids et seuils du moteur (objet params partagé). Survolez un libellé pour l’aide.'));
  const flat = flattenParams(app.params);
  for (const g of GROUPS) {
    root.append(
      el('details', { class: 'group', open: true },
        el('summary', {}, g.group),
        ...g.items.filter((spec) => spec.path in flat).map((spec) => {
          const row = slider({ label: spec.label, min: spec.min, max: spec.max, step: spec.step, value: flat[spec.path], hint: `${spec.path} — ${spec.hint}`, format: fmt(spec), onInput: (v) => app.setParam(spec.path, v) });
          rows.set(spec.path, { row, spec });
          return row;
        }),
      ),
    );
  }
  root.append(el('button', { class: 'btn', onClick: () => app.resetParams() }, 'Réinitialiser les paramètres'));

  const refresh = (): void => {
    const f = flattenParams(app.params);
    for (const [path, { row, spec }] of rows) if (document.activeElement !== (row as any).__input) setSlider(row, f[path], fmt(spec));
  };
  app.on('ui', refresh);
  app.on('reset', refresh);
  return root;
}
