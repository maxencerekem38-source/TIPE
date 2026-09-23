/**
 * Captures d'écran automatisées de l'interface (Playwright + serveur Vite).
 * Sortie : results/screenshots/ui-*.png
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('results/screenshots');
const PORT = 5199;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // HMR et surveillance désactivés : d'autres fichiers du dépôt peuvent changer pendant la capture.
  const server = await createServer({
    configFile: resolve('vite.config.ts'),
    server: { port: PORT, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.pitch-canvas');
  await page.waitForFunction(() => (window as any).__app !== undefined);

  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: resolve(OUT, `ui-${name}.png`) });
    // Vérification de débordement horizontal (barre haute, panneau latéral)
    const overflow = await page.evaluate(() => {
      const out: string[] = [];
      for (const sel of ['.topbar', '.sidebar-content', '.panel']) {
        const e = document.querySelector(sel) as HTMLElement | null;
        if (e && e.scrollWidth > e.clientWidth + 1) out.push(`${sel} : ${e.scrollWidth} > ${e.clientWidth}`);
      }
      return out;
    });
    const time = await page.evaluate(() => (window as any).__app.state.time as number);
    console.log(`capture : results/screenshots/ui-${name}.png (t = ${time.toFixed(1)} s)${overflow.length ? ' DÉBORDEMENT : ' + overflow.join(', ') : ''}`);
  };
  const call = (js: string) => page.evaluate(js);

  // 1. Vue par défaut après 2 s de lecture
  await page.keyboard.press('Space');
  await page.waitForTimeout(2000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await shot('default');

  // 2. Cartes de chaleur : menace, pression (une capture chacune) + espaces + déplacements + affectations + étiquettes
  await call(`(() => { const a = window.__app; a.toggleOverlay('threat', true); a.toggleOverlay('spaces', true); a.toggleOverlay('moves', true); a.toggleOverlay('labels', true); })()`);
  await page.waitForTimeout(200);
  await shot('layers-threat');
  await call(`(() => { const a = window.__app; a.toggleOverlay('pressure', true); a.toggleOverlay('defence', true); a.toggleOverlay('moves', false); window.__showTab('layers'); })()`);
  await page.waitForTimeout(200);
  await shot('layers-pressure');
  await call(`(() => { const a = window.__app; a.toggleOverlay('control', true); a.toggleOverlay('defence', false); a.toggleOverlay('labels', false); a.toggleOverlay('spaces', false); })()`);

  // 3. Panneau de décision avec un candidat développé et survolé
  await call(`window.__showTab('decision')`);
  await page.waitForTimeout(200);
  const heads = page.locator('.cand-head');
  if ((await heads.count()) > 1) { await heads.nth(1).click(); await heads.nth(1).hover(); }
  await page.waitForTimeout(250);
  await shot('decision');

  // 4. Tactiques
  await call(`window.__showTab('tactics')`);
  await page.waitForTimeout(200);
  await shot('tactics');

  // 5. Statistiques (après un peu plus de jeu à vitesse ×4)
  await call(`(() => { const a = window.__app; a.setSpeed(4); a.play(); })()`);
  await page.waitForTimeout(3000);
  await call(`(() => { const a = window.__app; a.pause(); a.setSpeed(1); window.__showTab('stats'); })()`);
  await page.waitForTimeout(300);
  await shot('stats');

  // 6. Paramètres et journal
  await call(`window.__showTab('params')`);
  await page.waitForTimeout(200);
  await shot('params');
  await call(`window.__showTab('log')`);
  await page.waitForTimeout(200);
  await shot('log');

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
