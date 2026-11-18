import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
const P = 4321, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tab-'));
const hosts = { 'casa.test': { url: `http://127.0.0.1:${P}` } };
const casa = new Estafeta({ domain: 'casa.test', port: P, dataDir: path.join(tmp, 'c'), adminToken: 't', hosts,
  workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {} });
await casa.start();
const llaves = {};
const unir = async (n) => { const r = await join({ house: 'casa.test', name: n, hosts, keyfile: path.join(tmp, `${n}.json`) }); llaves[n] = r.keyfile; return r._agente; };
const nico = await unir('nicholas'), cto = await unir('sigo-cto'), ed = await unir('sigo-editor');
const t = async (p) => { const r = await p; await casa.tick(); return r; };

const a = await t(nico.encargar('casa.test', { concept: 'cerrar la frontera del PM con el dinero', assignee: 'sigo-cto@casa.test' }));
const b = await t(nico.encargar('casa.test', { concept: 'medir si ML-DSA cabe sin dependencias', assignee: 'sigo-cto@casa.test' }));
const c = await t(nico.encargar('casa.test', { concept: 'revisar el texto de las dos tareas nuevas' }));
await t(cto.encargoPaso('casa.test', 'tomar', b.envelope.id));
await t(cto.encargar('casa.test', { concept: 'leer el changelog del edge', assignee: 'sigo-editor@casa.test', parent: b.envelope.id }));
await t(cto.encargoPaso('casa.test', 'tomar', a.envelope.id));
await t(cto.encargoPaso('casa.test', 'entregar', a.envelope.id, { note: 'listo, mira el commit' }));

// Se envejecen dos a mano para que el tablero tenga algo atascado que mostrar.
for (const [id, h] of [[a.envelope.id, 30], [c.envelope.id, 50]]) {
  const e = await casa.store.encargoGet(id);
  await casa.store.encargoPaso({ ...e, updated: new Date(Date.now() - h * 3600_000).toISOString() }, e.rev);
}
const guardar = (a, f) => fs.writeFileSync(f, JSON.stringify({ address: a.address, estafeta: a.estafeta, keys: a.keys }, null, 2));
guardar(nico, '/tmp/llave-nico.json');
fs.writeFileSync('/tmp/hosts-demo.json', JSON.stringify(hosts));
console.log('--- lo que ve nicholas@ ---');
// execFileSync bloquearía el bucle de eventos de ESTE proceso, que es el que corre la casa: el
// servidor no podría contestarle a su propio hijo. Asíncrono o no hay respuesta.
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const correr = async (llave) => (await promisify(execFile)('node', [new URL('../bin/nyx5.js', import.meta.url).pathname, 'tablero', '--agent', llave, '--hosts', '/tmp/hosts-demo.json'])).stdout;
console.log(await correr('/tmp/llave-nico.json'));
console.log('--- lo que ve sigo-editor@, que sólo tiene una rama ---');
guardar(ed, '/tmp/llave-ed.json');
console.log(await correr('/tmp/llave-ed.json'));
await casa.stop();
