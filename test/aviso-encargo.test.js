// node --test test/
// El aviso de un encargo (24-nov-2026).
//
// Defecto medido: un encargo se anotaba en su tabla y el asignado NO se enteraba nunca. Nicholas lo
// pregunto con las palabras exactas —«¿le llega en tiempo real y lo despierta?»— y la respuesta era
// que no: ni sobre, ni webhook, ni nada. El encargo para la reunion con Santander quedo esperando a
// que alguien abriera una sesion.
//
// No faltaba un timbre. La casa ya tiene cinco (buzon, espera larga, webhook, asistente adoptado y
// ejecutor) y los CINCO cuelgan de lo mismo: que llegue un sobre al buzon. El encargo iba a
// `encargos@`, se guardaba, y no tocaba el buzon de nadie. Un sobre, y los cinco se encienden.
//
// Por eso aqui no se prueba «se mando un aviso»: se prueba que el aviso ENCIENDE los despertadores
// —el webhook sale, y la espera larga lo entrega— porque eso es lo que se afirmo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { MEDIA_AVISO_ENCARGO } from '../src/libro/encargos.js';

const P = 4894;
const PW = 4895;          // el servidor que recibe el webhook
const CASA = 'aviso.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [CASA]: { url: URL_CASA } };
let tmp, casa, jefe, obrero, solo, empujones, servidorWeb;

const entregar = async (p) => { const r = await p; await casa.tick(); return r; };
// Los avisos del buzon de alguien, ya abiertos.
const avisos = async (a) => {
  const out = [];
  for (const m of await a.inbox({ limit: 50 })) {
    const o = await a.open(m.envelope).catch(() => null);
    if (o?.content?.media === MEDIA_AVISO_ENCARGO) out.push({ ...o.content.body, de: m.envelope.from });
  }
  return out;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-aviso-'));
  empujones = [];
  servidorWeb = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => { empujones.push({ firma: req.headers['x-nyx5-push'] || null, cuerpo }); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => servidorWeb.listen(PW, '127.0.0.1', r));

  casa = await new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 60, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  }).start();
  jefe = Agent.create(`jefe@${CASA}`, URL_CASA, { hosts });
  obrero = Agent.create(`obrero@${CASA}`, URL_CASA, { hosts });
  solo = Agent.create(`solo@${CASA}`, URL_CASA, { hosts });
  await jefe.register({ adminToken: 't' });
  // El asignado declara un webhook: es uno de los cinco despertadores.
  await obrero.register({ adminToken: 't', webhook: `http://127.0.0.1:${PW}/push` });
  await solo.register({ adminToken: 't' });
});
after(async () => { await casa.stop(); await new Promise((r) => servidorWeb.close(r)); });

test('crear un encargo le deja un sobre al asignado, con lo que necesita para actuar', async () => {
  const r = await entregar(jefe.encargar(CASA, {
    concept: 'descubrir proveedores', detail: 'el detalle largo que NO tiene que viajar dos veces',
    assignee: obrero.address, due: '2026-11-26T21:00:00.000Z', project: 'rosetta',
  }));
  const id = r.envelope.id;
  const a = (await avisos(obrero)).find((x) => x.encargo === id);
  assert.ok(a, 'el asignado no se entero: es el defecto del 24-nov');
  assert.equal(a.de, `encargos@${CASA}`, 'el aviso lo firma la casa, no el que pidio');
  assert.equal(a.step, 'crear');
  assert.equal(a.state, 'submitted');
  assert.equal(a.concept, 'descubrir proveedores');
  assert.equal(a.due, '2026-11-26T21:00:00.000Z', 'sin plazo en el aviso hay que ir a buscarlo');
  assert.equal(a.from, jefe.address);
  // El detalle NO viaja: ya vive en el encargo, y dos copias se pueden contradecir.
  assert.ok(!JSON.stringify(a).includes('detalle largo'), 'el aviso repite el encargo entero');
});

test('y ese sobre ENCIENDE el webhook: eso es el tiempo real', async () => {
  // Lo que se afirmo fue «en tiempo real». Un aviso que se queda en una tabla no lo es, asi que se
  // comprueba el empujon de verdad, contra un servidor que lo recibe.
  assert.ok(empujones.length >= 1, 'la casa no empujo nada: sin esto el aviso no despierta a nadie');
  const ultimo = empujones[empujones.length - 1];
  assert.match(String(ultimo.firma), /domain=aviso\.test/, 'el empujon va firmado por la casa');
  assert.match(ultimo.cuerpo, /encargo-aviso/, 'el empujon no lleva el aviso del encargo');
});

test('la espera larga lo entrega sin que nadie pregunte', async () => {
  // El despertador GRATIS: una conexion retenida, sin modelo pensando y sin configurar nada.
  const esperando = fetch(`${URL_CASA}/mailbox/${solo.local}/wait?timeout=8000`, {
    headers: { authorization: solo._auth('GET', `/mailbox/${solo.local}/wait`) },
  }).then((x) => x.json());
  await new Promise((r) => setTimeout(r, 150));
  const r = await entregar(jefe.encargar(CASA, { concept: 'algo para el que espera', assignee: solo.address }));
  const llegado = await esperando;
  const env = llegado.message?.envelope || null;
  assert.ok(env, `la espera larga no entrego nada: ${JSON.stringify(llegado).slice(0, 200)}`);
  assert.equal(env.from, `encargos@${CASA}`, 'lo que llego no es el aviso de la casa');
  assert.equal(env.thread, r.envelope.id, 'el aviso viaja en el hilo del encargo');
  assert.equal(env.content.media, MEDIA_AVISO_ENCARGO);
  assert.equal(env.content.body.encargo, r.envelope.id);
});

test('al que acaba de mover el encargo no se le avisa: su buzon no es su propio eco', async () => {
  const antes = (await avisos(jefe)).length;
  const r = await entregar(jefe.encargar(CASA, { concept: 'lo pide el jefe', assignee: obrero.address }));
  assert.equal((await avisos(jefe)).length, antes, 'el que pidio recibio aviso de su propio pedido');

  // Y el paso avisa a la CONTRAPARTE, en los dos sentidos.
  await entregar(obrero.encargoPaso(CASA, 'tomar', r.envelope.id));
  await entregar(obrero.encargoPaso(CASA, 'entregar', r.envelope.id, { note: 'listo' }));
  const alJefe = (await avisos(jefe)).filter((x) => x.encargo === r.envelope.id);
  assert.ok(alJefe.some((x) => x.step === 'entregar' && x.state === 'input-required'),
    'el que pidio no se entero de que hay algo que revisar');

  const antesObrero = (await avisos(obrero)).filter((x) => x.encargo === r.envelope.id).length;
  await entregar(jefe.encargoPaso(CASA, 'devolver', r.envelope.id, { note: 'falta un dato' }));
  const despues = (await avisos(obrero)).filter((x) => x.encargo === r.envelope.id);
  assert.ok(despues.length > antesObrero, 'al asignado no le llego que se lo devolvieron');
  assert.ok(despues.some((x) => x.step === 'devolver'));
});

test('la senal tambien avisa, que es como se dice «esto esta detenido»', async () => {
  const r = await entregar(jefe.encargar(CASA, { concept: 'con senal', assignee: obrero.address }));
  await entregar(obrero.encargoPaso(CASA, 'tomar', r.envelope.id));
  await entregar(obrero.senalarEncargo(CASA, r.envelope.id, 'auth-required', 'falta autorizar el token'));
  const a = (await avisos(jefe)).filter((x) => x.encargo === r.envelope.id);
  assert.ok(a.some((x) => x.step === 'signal:auth-required' && x.state === 'auth-required'),
    'una senal que nadie ve no detiene nada');
});

test('sin asignado, y asignandose a si mismo, no se avisa a nadie', async () => {
  const antes = empujones.length;
  const r = await entregar(jefe.encargar(CASA, { concept: 'que lo tome quien quiera' }));
  assert.ok((await jefe.tablero(CASA)).filas.some((f) => f.id === r.envelope.id), 'el encargo tiene que existir igual');
  assert.equal(empujones.length, antes, 'se empujo un aviso sin destinatario');

  // El caso que de verdad distingue: uno se asigna trabajo a SI MISMO. Ahi hay contraparte y es
  // uno mismo, asi que avisar seria el eco de su propio pedido en su propio buzon. La version
  // anterior de esta prueba no lo cubria y el guardia quedaba mudo: con asignado nulo nunca se
  // llegaba a comparar. Ver [[una-mutacion-que-es-una-simetria-no-prueba-nada]].
  const suyos = (await avisos(obrero)).length;
  const propio = await entregar(obrero.encargar(CASA, { concept: 'me lo asigno yo', assignee: obrero.address }));
  const despues = (await avisos(obrero)).filter((x) => x.encargo === propio.envelope.id);
  assert.deepEqual(despues, [], 'se aviso a si mismo: el buzon no es el eco de lo que uno acaba de hacer');
  assert.equal((await avisos(obrero)).length, suyos);
});

test('el encargo se guarda ANTES de avisar, asi que el timbre nunca llega primero', async () => {
  // Esto NO es un guardia: es el orden, escrito. La verificacion por mutacion lo dejo claro —hacer
  // que el aviso PROPAGUE el error no rompe ninguna prueba, porque el encargo ya esta guardado y el
  // sobre se reentrega solo (idempotente por id). O sea que el try/catch de `_avisarEncargo` es
  // prudencia, no una red: lo que de verdad salva el trabajo es que se guarde primero.
  // Se deja escrito en vez de fingir un guardia que no grita.
  const original = casa._systemSend.bind(casa);
  casa._systemSend = async () => { throw new Error('el buzon exploto'); };
  try {
    const r = await entregar(jefe.encargar(CASA, { concept: 'el aviso va a fallar', assignee: obrero.address }));
    assert.ok((await jefe.tablero(CASA)).filas.some((f) => f.id === r.envelope.id),
      'el encargo tiene que estar guardado aunque el aviso no salga');
  } finally { casa._systemSend = original; }
});
