// node --test test/
// El trabajo, visto desde donde viven los agentes (20-nov-2026).
//
// Nació de una medición, no de una idea. El 18-nov claude.nico@ —un Claude conectado por el
// conector remoto— pidió por escrito seis cosas. Al contrastarlas contra el código apareció que lo
// que pedía YA ESTABA CONSTRUIDO y no le llegaba:
//   - los encargos con sus ocho estados viven en la casa desde el 17-nov y tenían CERO herramientas
//     en el puente: sólo se usaban desde la terminal del Mac de Nicholas;
//   - `thread` e `in_reply_to` existen en el sobre y `reply` los hereda solo, pero el puente sólo
//     ofrecía `send`, así que había que escribirlos a mano y TODAS las respuestas llegaban con hilo
//     nulo: «hay que adivinar qué respuesta corresponde a qué encargo»;
//   - `nyx5_outbox` devolvía el historial entero (~346 mil caracteres) y reventaba el contexto.
// Una capacidad construida y fuera de alcance es una capacidad que no existe. Esto lo fija.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { MEDIA_ENCARGO } from '../src/libro/encargos.js';
import { TOOLS, MENSAJERIA, llamar } from '../src/puentes/herramientas.js';

const P = 4891;
const CASA = 'trabajo.test';
const hosts = { [CASA]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, jefe, remoto;

const unir = async (local) => (await join({ house: CASA, name: local, hosts }))._agente;
// `send` encola: Nyx5 es store-and-forward. Sin el tick se asertaría sobre el acuse del cartero.
const entregar = async (p) => { const r = await p; await casa.tick(); return r; };
// La llamada REAL del puente, con la lista de permitidas del conector remoto. Probar el método del
// Agent y no esto dejaría pasar justo el defecto que se vino a arreglar: que la capacidad existiera
// y el puente no la ofreciera.
const remota = (agente, name, args = {}) => llamar(agente, name, args, { permitidas: MENSAJERIA });
const datos = (r) => JSON.parse(r.content[0].text);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-pt-'));
  casa = new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  });
  await casa.start();
  jefe = await unir('jefe');
  // La identidad del Claude de un teléfono: delegada y SÓLO MENSAJES, con la llave en la casa.
  remoto = await jefe.delegate('claude', { scope: { messages_only: true } });
});
after(async () => { await casa.stop(); });

test('las cuatro herramientas que faltaban existen y llegan al conector remoto', () => {
  for (const n of ['nyx5_reply', 'nyx5_encargar', 'nyx5_encargo', 'nyx5_tablero']) {
    assert.ok(TOOLS.some((t) => t.name === n), `falta la herramienta ${n}`);
    assert.ok(MENSAJERIA.has(n), `${n} existe pero NO llega al conector remoto, que es donde se pidió`);
  }
  // El tablero es lectura: marcarlo de otro modo hace que un cliente pida confirmación para mirar.
  assert.equal(TOOLS.find((t) => t.name === 'nyx5_tablero').annotations.readOnlyHint, true);
});

test('un Claude conectado abre trabajo y lo mueve, de punta a punta por el puente', async () => {
  const r = datos(await remota(remoto, 'nyx5_encargar', {
    concept: 'revisar la guia post-cuantica', detail: 'el PDF que no llego el 18-nov',
    assignee: jefe.address, due: '2026-12-01T00:00:00.000Z', project: 'nyx5',
  }));
  await casa.tick();
  const id = r.envelope?.id || r.id;

  // Lo ve quien lo pidió...
  const suyo = datos(await remota(remoto, 'nyx5_tablero', {}));
  const fila = suyo.filas.find((f) => f.id === id);
  assert.ok(fila, 'el que pide un encargo tiene que verlo en su tablero');
  assert.equal(fila.state, 'submitted');
  assert.equal(fila.assignee, jefe.address);
  // `due` y `project` los leía la casa y el cliente no los mandaba nunca: un campo que el receptor
  // entiende y el emisor no puede escribir es una promesa publicada a medias.
  assert.equal(fila.due, '2026-12-01T00:00:00.000Z', 'el plazo no llegó al encargo');
  assert.equal(fila.project, 'nyx5', 'el proyecto no llegó al encargo');

  // ...y lo ve el otro lado, con el MISMO estado: el tablero lo calcula la casa, no cada agente.
  const delJefe = (await jefe.tablero(CASA)).filas.find((f) => f.id === id);
  assert.equal(delJefe.state, 'submitted');

  // Y el que lo recibió lo mueve. Esto es lo que vuelve innecesario preguntar «¿en qué va?».
  await entregar(jefe.encargoPaso(CASA, 'tomar', id));
  await entregar(jefe.encargoPaso(CASA, 'entregar', id, { note: 'ahi va' }));
  const despues = datos(await remota(remoto, 'nyx5_tablero', {})).filas.find((f) => f.id === id);
  assert.equal(despues.state, 'input-required', 'una entrega que espera revisión depende de una persona');

  // Y el delegado puede cerrarlo: es suyo, lo pidió él.
  await entregar(remota(remoto, 'nyx5_encargo', { op: 'cerrar', id }));
  const cerrado = (await jefe.tablero(CASA, { state: 'completed' })).filas.find((f) => f.id === id);
  assert.equal(cerrado?.state, 'completed');
});

test('la puerta se abrió para el TRABAJO, no para el comercio', async () => {
  // La mitad que importa de la excepción. `task` es TAMBIÉN el tipo con el que se PIDE un servicio
  // pagado (pedido -> cotización -> aceptar). Si al habilitar el encargo se hubiera habilitado
  // `task` a secas, una dirección cuya llave guarda la casa podría empezar a comprar sola.
  await assert.rejects(() => remoto.send({ to: [jefe.address], type: 'task', body: 'hazme esto', encrypt: false }),
    /messages-only/, 'un task a otro agente tiene que seguir cerrado');
});

test('un task suelto, uno sin el media del encargo y el Libro siguen cerrados', async () => {
  const alcance = casa._limiteDeAlcance.bind(casa);
  const scope = { messages_only: true };
  const base = { from: remoto.address, type: 'task' };
  // El que SÍ pasa, para que la prueba no diga que no pasa nada.
  assert.equal(alcance({ ...base, to: [`encargos@${CASA}`], content: { media: MEDIA_ENCARGO } }, scope), null);
  // Un `task` a otro agente: el camino del servicio pagado.
  assert.ok(alcance({ ...base, to: [jefe.address], content: { media: MEDIA_ENCARGO } }, scope),
    'un task a una dirección cualquiera tiene que seguir prohibido');
  // Un `task` a encargos@ SIN declarar el media: es lo que escribiría quien quiere colar otra cosa.
  assert.ok(alcance({ ...base, to: [`encargos@${CASA}`], content: { media: 'text/plain' } }, scope),
    'sin el media del encargo no hay excepción');
  // Dos destinos, uno válido y otro no: la excepción pide que TODOS lo sean.
  assert.ok(alcance({ ...base, to: [`encargos@${CASA}`, jefe.address], content: { media: MEDIA_ENCARGO } }, scope),
    'basta un destino ajeno para que no sea un encargo');
  // Y lo de siempre: el Libro y las estampillas.
  assert.ok(alcance({ from: remoto.address, type: 'message', to: [`libro@${CASA}`], content: {} }, scope));
  assert.ok(alcance({ from: remoto.address, type: 'message', to: [jefe.address], stamp: 'x', content: {} }, scope));
});

test('responder lleva el hilo solo, y no se le puede contestar al agente equivocado', async () => {
  const enviado = await entregar(jefe.send({ to: [remoto.address], body: 'como va la guia?', encrypt: false }));
  const idOriginal = enviado.envelope.id;

  const r = datos(await remota(remoto, 'nyx5_reply', { id: idOriginal, body: 'entregada', encrypt: false }));
  await casa.tick();
  // Lo que el 18-nov llegaba en nulo las dos veces.
  assert.equal(r.in_reply_to, idOriginal, 'la respuesta no dice a qué contesta');
  assert.equal(r.thread, idOriginal, 'la respuesta no viaja en el hilo del original');

  // El destinatario sale del SOBRE. La herramienta no tiene parámetro `to`: no es una omisión, es
  // lo que hace imposible contestarle a un tercero por equivocación.
  assert.ok(!('to' in TOOLS.find((t) => t.name === 'nyx5_reply').inputSchema.properties),
    'nyx5_reply no debe aceptar destinatario: se toma del sobre');
  const llego = (await jefe.inbox({ limit: 10 })).find((m) => m.envelope.in_reply_to === idOriginal);
  assert.ok(llego, 'la respuesta tiene que llegarle a quien escribió');

  await assert.rejects(() => remota(remoto, 'nyx5_reply', { id: 'no-existe-este-sobre', body: 'x' }),
    /no envelope with id/, 'responder a un id inventado tiene que decirlo, no mandar un sobre suelto');
});

test('la bandeja de salida se puede acotar, y acota sola', async () => {
  const otro = await unir('otro');
  for (let i = 0; i < 4; i++) await entregar(jefe.send({ to: [otro.address], body: `uno ${i}`, encrypt: false }));
  const marca = new Date().toISOString();
  await entregar(jefe.send({ to: [remoto.address], body: 'al remoto', encrypt: false }));

  const todo = await jefe.outbox({ limit: 0 });
  assert.ok(todo.length >= 5, 'hacen falta varios envíos para que filtrar signifique algo');

  const aOtro = await jefe.outbox({ to: otro.address });
  assert.equal(aOtro.length, 4, 'filtrar por destino no deja pasar los demás');
  assert.ok(aOtro.every((j) => (j.to || j.envelope?.to || []).includes(otro.address)));
  assert.ok((await jefe.outbox({ since: marca })).length < todo.length, 'el filtro por fecha tiene que dejar fuera lo anterior');
  assert.equal((await jefe.outbox({ limit: 2 })).length, 2);

  // El defecto que se vino a arreglar no es «no hay filtros», es «el tamaño no tiene techo». Un
  // tope por defecto es lo que impide que la herramienta se rompa sola a medida que se trabaja.
  const porDefecto = TOOLS.find((t) => t.name === 'nyx5_outbox').inputSchema.properties.limit;
  assert.equal(porDefecto.default, 50, 'la bandeja de salida tiene que traer un tope por defecto');
  const desdeElPuente = datos(await remota(jefe, 'nyx5_outbox', { to: otro.address }));
  assert.equal(desdeElPuente.length, 4, 'los filtros tienen que llegar por el puente, no sólo al método');
});

test('pedir un estado cerrado devuelve filas, no un cero imposible', async () => {
  // `/encargos?state=completed` le pedia a la bodega SOLO los completados y el tablero los volvia a
  // filtrar a lo abierto: cero filas siempre, con el trabajo guardado ahi. Un cero que no puede ser
  // otra cosa no es una medicion, y es justo lo que alguien mira para saber que se cumplio.
  const r = await entregar(jefe.encargar(CASA, { concept: 'algo que se termina', assignee: jefe.address }));
  const id = r.envelope.id;
  await entregar(jefe.encargoPaso(CASA, 'tomar', id));
  await entregar(jefe.encargoPaso(CASA, 'entregar', id));
  await entregar(jefe.encargoPaso(CASA, 'cerrar', id));

  const cerrados = await jefe.tablero(CASA, { state: 'completed' });
  assert.ok(cerrados.filas.some((f) => f.id === id), 'lo cerrado tiene que poder listarse');
  assert.ok(cerrados.filas.every((f) => f.state === 'completed'), 'y no puede colarse otro estado');

  // Y sin filtro, el tablero sigue siendo lo que hay que mirar hoy: lo cerrado no vuelve a aparecer.
  const abierto = await jefe.tablero(CASA);
  assert.ok(!abierto.filas.some((f) => f.id === id), 'sin filtro, un encargo cerrado no vuelve al tablero');
  assert.equal(abierto.por_estado.completed >= 1, true, 'el conteo por estado sí lo cuenta');

  // Dos estados a la vez, que es como se pregunta "que quedo fuera".
  const dos = await jefe.tablero(CASA, { state: 'completed,failed' });
  assert.ok(dos.filas.some((f) => f.id === id));
});
