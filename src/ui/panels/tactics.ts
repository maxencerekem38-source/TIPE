/**
 * Panneau « Tactiques » : formation, style et paramètres tactiques par équipe.
 */
import { FORMATION_IDS, STYLE_IDS, type FormationId, type StyleId, type TacticParams, type TeamId } from '@/core/types';
import { STYLE_DESCRIPTIONS, STYLE_LABELS } from '@/tactics/styles';
import type { AppState } from '../app';
import { el, setSlider, slider } from '../dom';
import { fmtNumber, TEAM_LABELS } from '../format';

interface ParamSpec { key: keyof TacticParams; label: string; min: number; max: number; step: number; hint: string; unit?: string }

const TACTIC_PARAMS: { group: string; items: ParamSpec[] }[] = [
  {
    group: 'Attaque',
    items: [
      { key: 'riskTolerance', label: 'Tolérance au risque', min: 0, max: 1, step: 0.05, hint: 'Pondération de la valeur en cas d’échec (0 = prudent, 1 = audacieux).' },
      { key: 'progressionBias', label: 'Progression', min: 0, max: 2, step: 0.1, hint: 'Poids de la progression vers le but adverse.' },
      { key: 'tempo', label: 'Tempo', min: 0, max: 1, step: 0.05, hint: 'Vitesse d’exécution voulue : pénalise la conservation.' },
      { key: 'directness', label: 'Verticalité', min: 0, max: 1, step: 0.05, hint: 'Préférence pour les passes longues et en profondeur.' },
      { key: 'widthUsage', label: 'Largeur', min: 0, max: 1, step: 0.05, hint: 'Utilisation des couloirs et poids des options larges.' },
      { key: 'shotEagerness', label: 'Propension au tir', min: 0, max: 1, step: 0.05, hint: 'Abaisse le seuil de xG pour tenter sa chance.' },
      { key: 'supportDistance', label: 'Distance de soutien', min: 6, max: 25, step: 1, hint: 'Distance idéale des soutiens au porteur.', unit: 'm' },
      { key: 'runFrequency', label: 'Fréquence des appels', min: 0, max: 1, step: 0.05, hint: 'Proportion de joueurs autorisés à faire des appels.' },
    ],
  },
  {
    group: 'Défense',
    items: [
      { key: 'pressIntensity', label: 'Intensité du pressing', min: 0, max: 1, step: 0.05, hint: 'Nombre de presseurs et rayon de déclenchement.' },
      { key: 'pressLine', label: 'Ligne de pressing', min: -40, max: 40, step: 1, hint: 'Ligne x (repère équipe) au-delà de laquelle le pressing se déclenche.', unit: 'm' },
      { key: 'defensiveLine', label: 'Ligne défensive', min: -45, max: 0, step: 1, hint: 'Hauteur de la ligne défensive en défense placée.', unit: 'm' },
      { key: 'compactness', label: 'Compacité', min: 0, max: 1, step: 0.05, hint: 'Contraction du bloc vers le ballon.' },
      { key: 'markingTightness', label: 'Marquage', min: 0, max: 1, step: 0.05, hint: '0 = zone pure, 1 = marquage individuel strict.' },
      { key: 'counterPressWindow', label: 'Contre-pressing', min: 0, max: 10, step: 0.5, hint: 'Fenêtre de contre-pressing après une perte.', unit: 's' },
      { key: 'pressTriggerCount', label: 'Déclencheurs de pressing', min: 1, max: 3, step: 1, hint: 'Nombre de conditions requises pour presser (1 = agressif).' },
      { key: 'restDefenders', label: 'Défenseurs de repos', min: 0, max: 4, step: 1, hint: 'Joueurs qui restent sur leur poste pendant l’attaque.' },
    ],
  },
  {
    group: 'Transitions',
    items: [
      { key: 'counterAttackBias', label: 'Contre-attaque', min: 0, max: 1, step: 0.05, hint: 'Verticalité immédiate après récupération.' },
      { key: 'recoverPriority', label: 'Priorité au repli', min: 0, max: 1, step: 0.05, hint: 'Priorité au repli après une perte.' },
    ],
  },
];

export function createTacticsPanel(app: AppState): HTMLElement {
  const root = el('div', { class: 'panel tactics-panel' });
  const teams: TeamId[] = ['A', 'B'];
  const sliders: Record<TeamId, Partial<Record<keyof TacticParams, HTMLElement>>> = { A: {}, B: {} };
  const selects: Record<TeamId, { formation: HTMLSelectElement; style: HTMLSelectElement; desc: HTMLElement }> = {} as any;

  for (const team of teams) {
    const formation = el('select', { class: 'select', onChange: () => app.setTactic(team, { formation: formation.value as FormationId }) },
      ...FORMATION_IDS.map((f) => el('option', { value: f }, f))) as HTMLSelectElement;
    const style = el('select', { class: 'select', onChange: () => app.setTactic(team, { style: style.value as StyleId }) },
      ...STYLE_IDS.map((s) => el('option', { value: s, title: STYLE_DESCRIPTIONS[s] }, STYLE_LABELS[s]))) as HTMLSelectElement;
    const desc = el('p', { class: 'help' });
    selects[team] = { formation, style, desc };
    const groups = TACTIC_PARAMS.map((g) =>
      el('details', { class: 'group', open: g.group === 'Attaque' },
        el('summary', {}, g.group),
        ...g.items.map((spec) => {
          const row = slider({
            label: spec.label, min: spec.min, max: spec.max, step: spec.step, value: app.state.tactics[team].params[spec.key], hint: spec.hint,
            format: (v) => fmtNumber(v, spec.step < 1 ? 2 : 0) + (spec.unit ? ` ${spec.unit}` : ''),
            onInput: (v) => app.setTacticParam(team, spec.key, v),
          });
          sliders[team][spec.key] = row;
          return row;
        }),
      ),
    );
    root.append(
      el('section', { class: `section team-section team-${team.toLowerCase()}` },
        el('h3', { class: 'section-title' }, el('span', { class: `dot team-${team.toLowerCase()}` }), TEAM_LABELS[team]),
        el('div', { class: 'field-row' }, el('label', { class: 'field-label' }, 'Formation'), formation),
        el('div', { class: 'field-row' }, el('label', { class: 'field-label' }, 'Style de jeu'), style),
        desc,
        ...groups,
        el('button', { class: 'btn btn-small', onClick: () => app.resetTacticParams(team) }, 'Réinitialiser les réglages manuels'),
      ),
    );
  }

  const refresh = (): void => {
    for (const team of teams) {
      const tc = app.state.tactics[team];
      if (selects[team].formation.value !== tc.formation) selects[team].formation.value = tc.formation;
      if (selects[team].style.value !== tc.style) selects[team].style.value = tc.style;
      selects[team].desc.textContent = STYLE_DESCRIPTIONS[tc.style];
      for (const g of TACTIC_PARAMS) for (const spec of g.items) {
        const row = sliders[team][spec.key];
        if (row && document.activeElement !== (row as any).__input) setSlider(row, tc.params[spec.key], (v) => fmtNumber(v, spec.step < 1 ? 2 : 0) + (spec.unit ? ` ${spec.unit}` : ''));
      }
    }
  };
  app.on('ui', refresh);
  app.on('reset', refresh);
  refresh();
  return root;
}
