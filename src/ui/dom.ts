/**
 * Petits utilitaires DOM (création d'éléments, vidage) — pas de framework.
 */
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'style') node.setAttribute('style', String(v));
    else if (k in node && typeof v !== 'boolean') (node as any)[k] = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Remplace les enfants d'un nœud. */
export function replace(node: HTMLElement, ...children: (Child | Child[])[]): void {
  clear(node);
  for (const c of children.flat()) if (c) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
}

/** Curseur avec libellé, valeur affichée et info-bulle. */
export function slider(opts: {
  label: string; min: number; max: number; step: number; value: number; hint?: string;
  format?: (v: number) => string; onInput: (v: number) => void;
}): HTMLElement {
  const fmt = opts.format ?? ((v: number) => String(v).replace('.', ','));
  const out = el('span', { class: 'slider-value', text: fmt(opts.value) });
  const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    opts.onInput(v);
  });
  const row = el('label', { class: 'slider-row', title: opts.hint ?? '' },
    el('span', { class: 'slider-label', text: opts.label }),
    input,
    out,
  );
  (row as any).__input = input;
  (row as any).__out = out;
  return row;
}

/** Met à jour un curseur créé par `slider` sans déclencher son événement. */
export function setSlider(row: HTMLElement, value: number, format?: (v: number) => string): void {
  const input = (row as any).__input as HTMLInputElement | undefined;
  const out = (row as any).__out as HTMLElement | undefined;
  if (input) input.value = String(value);
  if (out) out.textContent = (format ?? ((v: number) => String(v).replace('.', ',')))(value);
}
