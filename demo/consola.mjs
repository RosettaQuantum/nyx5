// Levanta una casa con trabajo de verdad y deja la consola abierta para mirarla.
// Queda corriendo hasta que se mate: `npm run demo:consola`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';

const P = 4324;
const H = 'casa.test';
const U = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: U } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-consola-'));

const casa = new Estafeta({
  domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, publicUrl: U,
  workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 },
  libro: { welcome: 2000, feeBps: 50 }, verifica: { enabled: true }, log: () => {},
});
await casa.start();

const unir = async (n) => (await join({ house: H, name: n, hosts }))._agente;
const nico = await unir('nicholas');
const cto = await unir('sigo-cto');
const editor = await unir('sigo-editor');
const t = async (p) => { const r = await p; await casa.tick(); return r; };

const a = await t(nico.encargar(H, { concept: 'cerrar la frontera del PM con el dinero', assignee: `sigo-cto@${H}`, project: 'consola' }));
const b = await t(nico.encargar(H, { concept: 'medir si ML-DSA cabe sin dependencias', assignee: `sigo-cto@${H}`, project: 'pqc', due: '2026-11-25' }));
const c = await t(nico.encargar(H, { concept: 'revisar el texto de las dos tareas nuevas' }));
const d = await t(nico.encargar(H, { concept: 'la orden de la consola lleva dos dias sin abrir', assignee: `sigo-editor@${H}`, project: 'consola' }));
await t(cto.encargoPaso(H, 'tomar', a.envelope.id));
await t(cto.encargoPaso(H, 'tomar', b.envelope.id));
await t(cto.encargar(H, { concept: 'leer el changelog del edge', assignee: `sigo-editor@${H}`, parent: b.envelope.id, project: 'pqc' }));
await t(cto.senalarEncargo(H, a.envelope.id, 'input-required', 'falta que Nicholas apruebe el texto'));
// Uno entregado, esperando revision: en A2A eso es input-required.
await t(cto.encargoPaso(H, 'tomar', d.envelope.id).catch(() => {}));
await t(editor.encargoPaso(H, 'tomar', d.envelope.id));
await t(editor.encargoPaso(H, 'entregar', d.envelope.id, { note: 'listo, mira el PR' }));

// Un contrato con dinero, por la puerta normal. OJO: la cotizacion viaja CIFRADA, asi que hay que
// ABRIR el sobre para saber que es — `envelope.content.media` llega undefined.
await t(cto.quote({ to: nico.address, contract: 'escrow', price: 400, concept: 'la pieza que si se paga', arbiter: `verifica@${H}` }));
for (const m of await nico.inbox()) {
  const o = await nico.open(m.envelope).catch(() => null);
  if (o?.content?.media?.includes('cotizacion')) await t(nico.accept(o.content.body));
}
const vivo = (await casa.store.libroListContracts()).find((x) => x.state === 'held');
if (vivo) await t(cto.senalarContrato(H, vivo.id, 'progress', 'voy en la mitad'));

// Uno envejecido a mano, para que haya un atasco que mirar.
{
  const e = await casa.store.encargoGet(c.envelope.id);
  await casa.store.encargoPaso({ ...e, updated: new Date(Date.now() - 50 * 3600_000).toISOString() }, e.rev);
}

const s = await nico.abrirConsola(H);
console.log(`\n  ${s.url}\n`);
console.log(`  (sesion de ${s.address} hasta ${s.vence.slice(0, 16).replace('T', ' ')} UTC)`);
console.log('  Ctrl-C para apagar la casa.\n');
