// La vista unificada contra una casa de verdad: un contrato con dinero y tres encargos sin él, en
// una sola lista, con la última señal abierta encima. Es la fase 3 de la orden, ejercida.
//
// Dos cosas que costaron una corrida cada una la primera vez y quedan escritas para no repetirlas:
// `join` toma `{ house, name, hosts }` y su `house` por defecto es nyx5.com (una prueba mía se unió
// a producción por eso), y `execFileSync` bloquearía el bucle de eventos de ESTE proceso, que es el
// que corre la casa: el servidor no podría contestarle a su propio hijo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';

const P = 4322;
const H = 'casa.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-trabajo-'));

const casa = new Estafeta({
  domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 50,
  policy: { registration: 'open', registrations_per_minute: 200 },
  libro: { welcome: 2000, feeBps: 50 }, verifica: { enabled: true }, log: () => {},
});
await casa.start();

const unir = async (n) => (await join({ house: H, name: n, hosts }))._agente;
const nico = await unir('nicholas');
const cto = await unir('sigo-cto');
const editor = await unir('sigo-editor');
const t = async (p) => { const r = await p; await casa.tick(); return r; };

// --- tres encargos, sin un peso ---
const a = await t(nico.encargar(H, { concept: 'cerrar la frontera del PM con el dinero', assignee: `sigo-cto@${H}`, project: 'consola' }));
const b = await t(nico.encargar(H, { concept: 'medir si ML-DSA cabe sin dependencias', assignee: `sigo-cto@${H}`, project: 'pqc', due: '2026-11-25' }));
const c = await t(nico.encargar(H, { concept: 'revisar el texto de las tareas nuevas' }));
await t(cto.encargoPaso(H, 'tomar', a.envelope.id));
await t(cto.encargoPaso(H, 'tomar', b.envelope.id));
// Una subtarea, para que el padre reporte progreso.
await t(cto.encargar(H, { concept: 'leer el changelog del edge', assignee: `sigo-editor@${H}`, parent: b.envelope.id }));
// Y una señal: lo que de verdad tiene detenido el trabajo.
await t(cto.senalarEncargo(H, a.envelope.id, 'input-required', 'falta que Nicholas apruebe el texto'));

// --- un contrato con dinero, por la puerta normal ---
await t(cto.quote({ to: nico.address, contract: 'escrow', price: 400, concept: 'la pieza que sí se paga', arbiter: `verifica@${H}`, house: H }));
// OJO: una cotización viaja CIFRADA, así que `m.envelope.content.media` llega undefined y hay que
// ABRIR el sobre para saber qué es. Mi primera versión filtraba por el media sin abrir, no
// encontraba nada, y el demo mostraba cuatro encargos y ningún contrato — justo lo que esta fase
// viene a unir. El invariante 8 en acción: lo cifrado no lo lee ni la casa ni el que no abre.
for (const m of await nico.inbox()) {
  const o = await nico.open(m.envelope).catch(() => null);
  if (o?.content?.media?.includes('cotizacion')) await t(nico.accept(o.content.body));
}
const vivo = (await casa.store.libroListContracts()).find((x) => x.state === 'held');
if (vivo) await t(cto.senalarContrato(H, vivo.id, 'progress', 'voy en la mitad'));

// Se envejece uno a mano para que haya algo atascado que mirar.
{
  const e = await casa.store.encargoGet(c.envelope.id);
  await casa.store.encargoPaso({ ...e, updated: new Date(Date.now() - 50 * 3600_000).toISOString() }, e.rev);
}

const llave = (ag, f) => { fs.writeFileSync(f, JSON.stringify({ address: ag.address, estafeta: ag.estafeta, keys: ag.keys }, null, 2)); return f; };
fs.writeFileSync('/tmp/hosts-trabajo.json', JSON.stringify(hosts));
const cli = promisify(execFile);
const correr = async (ag, comando) => (await cli('node', [
  new URL('../bin/nyx5.js', import.meta.url).pathname, comando,
  '--agent', llave(ag, `/tmp/llave-${ag.local}.json`), '--hosts', '/tmp/hosts-trabajo.json',
])).stdout;

console.log('=== TODO el trabajo de nicholas@, dinero y no dinero en una lista ===\n');
console.log(await correr(nico, 'trabajo'));
console.log('=== y lo que ve sigo-editor@, que sólo tiene una rama ===\n');
console.log(await correr(editor, 'trabajo'));

await casa.stop();
