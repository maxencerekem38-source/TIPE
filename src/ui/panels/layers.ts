/**
 * Panneau « Calques » : liste à cocher des couches de visualisation, avec pastille de couleur,
 * raccourci clavier (1..9) et aide.
 */
import { OVERLAY_META, type AppState } from '../app';
import { el } from '../dom';

export function createLayersPanel(app: AppState): HTMLElement {
  const inputs: HTMLInputElement[] = [];
  const items = OVERLAY_META.map((m, i) => {
    const input = el('input', { type: 'checkbox', checked: app.overlays[m.id], onChange: () => app.toggleOverlay(m.id, input.checked) }) as HTMLInputElement;
    inputs.push(input);
    return el('label', { class: 'layer-row', title: m.hint },
      input,
      el('span', { class: 'swatch', style: `background:${m.swatch}` }),
      el('span', { class: 'layer-label' }, m.label, el('span', { class: 'layer-hint' }, m.hint)),
      el('kbd', {}, String(i + 1)),
    );
  });
  const root = el('div', { class: 'panel layers-panel' },
    el('p', { class: 'help' }, 'Une seule carte de chaleur à la fois ; les autres calques se cumulent. Touches 1 à 9 pour basculer.'),
    ...items,
  );
  const refresh = (): void => OVERLAY_META.forEach((m, i) => { inputs[i].checked = app.overlays[m.id]; });
  app.on('ui', refresh);
  return root;
}
