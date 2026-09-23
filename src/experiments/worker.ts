/**
 * Point d'entrée des worker_threads : exécute les tâches nommées (`match`, `scenario`) et renvoie un
 * résultat sérialisable. Répond « pong » au « ping » de sondage du pool.
 */
import { parentPort } from 'node:worker_threads';
import { WORKER_TASKS } from './worker-tasks';

if (parentPort) {
  const port = parentPort;
  port.on('message', (m: any) => {
    if (!m) return;
    if (m.type === 'ping') { port.postMessage({ type: 'pong' }); return; }
    if (m.type === 'task') {
      const fn = WORKER_TASKS[m.name as keyof typeof WORKER_TASKS];
      if (!fn) { port.postMessage({ type: 'result', index: m.index, ok: false, error: `tâche inconnue : ${m.name}` }); return; }
      try {
        const result = fn(m.payload);
        port.postMessage({ type: 'result', index: m.index, ok: true, result });
      } catch (err) {
        port.postMessage({ type: 'result', index: m.index, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
}
