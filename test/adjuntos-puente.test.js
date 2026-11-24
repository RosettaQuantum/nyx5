// node --test test/
// Dos defectos medidos el 23-nov-2026, los dos de la misma forma: algo PUBLICADO sin nada detras.
//
//  1. `nyx5_attach` le dice al modelo, en su propia nota: «pass it in nyx5_send attachments». Y
//     `nyx5_send` NO tenia ese campo. El modelo obedecia, el argumento desconocido se ignoraba y el
//     sobre salia sin el archivo. Eso es el «los PDF nunca llegaron» que reporto claude.nico@ el
//     18-nov: no era la custodia de la llave, era una instruccion que no se podia cumplir.
//  2. `code.nicholas@` —el agente que HACE el trabajo— tiene `types: [message, result, receipt]` y
//     no podia tomar ni mover un encargo. El arreglo anterior abrio la puerta solo para
//     `messages_only`. El sistema de estados quedaba construido y sin nadie que pudiera moverlo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { TOOLS, llamar } from '../src/puentes/herramientas.js';

const P = 4893;
const CASA = 'puente.adjuntos.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [CASA]: { url: URL_CASA } };
let tmp, casa, jefe, obrero, limitado;

const entregar = async (p) => { const r = await p; await casa.tick(); return r; };
const datos = (r) => JSON.parse(r.content[0].text);
const herr = (nombre) => TOOLS.find((t) => t.name === nombre);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-adjp-'));
  casa = await new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {},
  }).start();
  jefe = Agent.create(`jefe@${CASA}`, URL_CASA, { hosts });
  obrero = Agent.create(`obrero@${CASA}`, URL_CASA, { hosts });
  await jefe.register({ adminToken: 't' });
  await obrero.register({ adminToken: 't' });
  // El caso real: un delegado con LISTA DE TIPOS, no `messages_only`. Es lo que lleva medio equipo.
  limitado = await jefe.delegate('code', { scope: { types: ['message', 'result', 'receipt'] } });
});
after(async () => { await casa.stop(); });

// ---------------- 1. el adjunto viaja ----------------

test('la nota de nyx5_attach dice la verdad: nyx5_send tiene ese campo', () => {
  // El guardia escrito contra el defecto REAL, no contra un ejemplo: la nota que el modelo lee
  // nombra `nyx5_send attachments`, asi que ese campo tiene que existir. Si alguien lo quita, esto
  // grita antes de que otro PDF se pierda en silencio.
  for (const t of ['nyx5_send', 'nyx5_reply']) {
    assert.ok(herr(t).inputSchema.properties.attachments, `${t} no acepta adjuntos y la nota de nyx5_attach manda pasarlos ahi`);
  }
});

test('un archivo sube, viaja en el sobre y llega entero al otro lado', async () => {
  const subido = datos(await llamar(jefe, 'nyx5_attach', { name: 'informe.txt', content: 'el contenido que tiene que llegar', to: [obrero.address] }));
  const att = subido.attachment;
  assert.ok(att.blob && att.sha256 && att.key, 'el descriptor tiene que traer blob, sha256 y llave');
  // La nota que el MODELO lee al subir lo manda a `nyx5_send attachments`. Las dos mitades juntas:
  // que la frase siga ahi y que el campo exista. El defecto fue exactamente que una prometia y la
  // otra no estaba, asi que comprobar solo una deja el agujero abierto.
  assert.match(String(subido.note), /nyx5_send attachments/, 'nyx5_attach dejo de decir donde se pasan los adjuntos');

  const enviado = datos(await entregar(llamar(jefe, 'nyx5_send', { to: [obrero.address], body: 'van los archivos', attachments: [att] })));
  assert.equal(enviado.attachments, 1, 'el sobre salio SIN el adjunto: es el defecto del 18-nov');
  assert.equal(enviado.encrypted, true);

  // Un sobre SIN adjuntos tiene que decir cero. Sin este lado, un `1` clavado en el eco pasaba la
  // prueba entera: el caso de uno solo no distingue el valor real de la constante.
  const pelado = datos(await entregar(llamar(jefe, 'nyx5_send', { to: [obrero.address], body: 'sin nada' })));
  assert.equal(pelado.attachments, 0, 'el eco de adjuntos esta clavado, no cuenta');
  const dobles = datos(await entregar(llamar(jefe, 'nyx5_send', { to: [obrero.address], body: 'dos', attachments: [att, datos(await llamar(jefe, 'nyx5_attach', { name: 'otro.txt', content: 'segundo', to: [obrero.address] })).attachment] })));
  assert.equal(dobles.attachments, 2, 'dos adjuntos tienen que contarse como dos');

  // Y el destinatario lo baja y le cuadra el hash del claro. Sin esto, «viajo» seria una promesa.
  const sobre = await obrero.conAdjuntos(enviado.id, jefe.address);
  assert.ok(sobre, 'el sobre con adjunto tiene que estar en el buzon del destinatario');
  const bytes = await obrero.bajarAdjunto(sobre.attachments[0], { from: jefe.address });
  assert.equal(Buffer.from(bytes).toString('utf8'), 'el contenido que tiene que llegar');
});

test('responder tambien lleva archivos, que es como se entrega un trabajo', async () => {
  const pedido = await entregar(jefe.send({ to: [obrero.address], body: 'mandame el informe', encrypt: false }));
  const att = datos(await llamar(obrero, 'nyx5_attach', { name: 'entrega.txt', content: 'aqui va', to: [jefe.address] })).attachment;
  const r = datos(await entregar(llamar(obrero, 'nyx5_reply', { id: pedido.envelope.id, body: 'entregado', attachments: [att] })));
  assert.equal(r.in_reply_to, pedido.envelope.id, 'una entrega sin hilo no se sabe de que encargo es');
  const sobre = await jefe.conAdjuntos(r.id, obrero.address);
  assert.equal(Buffer.from(await jefe.bajarAdjunto(sobre.attachments[0], { from: obrero.address })).toString('utf8'), 'aqui va');
});

// ---------------- 2. el delegado con lista de tipos mueve trabajo ----------------

test('un delegado con lista de tipos SI puede tomar y mover un encargo', async () => {
  const enc = await entregar(jefe.encargar(CASA, { concept: 'lo que el delegado tiene que poder mover', assignee: limitado.address }));
  const id = enc.envelope.id;

  // Esto es exactamente lo que fallaba: `agente delegado: solo puede enviar type message|result|receipt`.
  await entregar(limitado.encargoPaso(CASA, 'tomar', id));
  assert.equal((await jefe.tablero(CASA)).filas.find((f) => f.id === id)?.state, 'working', 'el delegado no pudo TOMAR el encargo');
  await entregar(limitado.encargoPaso(CASA, 'entregar', id, { note: 'listo' }));
  assert.equal((await jefe.tablero(CASA)).filas.find((f) => f.id === id)?.state, 'input-required', 'el delegado no pudo ENTREGAR');
  // Y la senal, que es como dice que algo lo tiene detenido sin mover el estado.
  // La senal: dice QUE lo tiene detenido sin que el delegado tenga que mover el estado por su
  // cuenta. El `kind` es vocabulario CERRADO a proposito (un kind libre vuelve basura el historial),
  // y esta prueba lo aprendio fallando con uno inventado.
  await entregar(limitado.senalarEncargo(CASA, id, 'auth-required', 'falta que alguien autorice el token'));
  const conSenal = (await jefe.tablero(CASA)).filas.find((f) => f.id === id);
  assert.ok(conSenal?.senal, 'el delegado no pudo SENALAR');
  assert.equal(conSenal.senal.kind, 'auth-required');
  assert.equal(conSenal.state, 'auth-required', 'una autorizacion pendiente mueve el estado, y eso es lo que mira el tablero');
});

test('y lo que la lista de tipos prohibia sigue prohibido', async () => {
  const alcance = casa._limiteDeAlcance.bind(casa);
  const scope = { types: ['message', 'result', 'receipt'] };
  const MEDIA = 'application/nyx5.encargo+json';
  const base = { from: limitado.address, type: 'task' };
  assert.equal(alcance({ ...base, to: [`encargos@${CASA}`], content: { media: MEDIA } }, scope), null, 'el encargo tiene que pasar');
  assert.ok(alcance({ ...base, to: [jefe.address], content: { media: MEDIA } }, scope), 'un task a otro agente sigue prohibido');
  assert.ok(alcance({ ...base, to: [`encargos@${CASA}`], content: { media: 'text/plain' } }, scope), 'sin el media del encargo no hay excepcion');
  assert.ok(alcance({ ...base, to: [`encargos@${CASA}`, jefe.address], content: { media: MEDIA } }, scope), 'basta un destino ajeno');
  // Y el tipo que NO esta en la lista y no es un encargo.
  assert.ok(alcance({ from: limitado.address, type: 'intro', to: [jefe.address], content: {} }, scope), 'un tipo fuera de la lista sigue fuera');
});
