// node --test test/
// Los dos tics (24-nov-2026). Decision de Nicholas, con sus palabras: «cada mensaje tiene dos tics,
// el primero cuando sale y el segundo cuando lo recibe el tercero».
//
// El acuse de entrega existia entero y habia que PEDIRLO sobre por sobre, asi que no lo pedia nadie
// y nadie veia un tic nunca. Ahora es lo normal.
//
// La primera version metia el acuse en el buzon como un sobre mas, y DIEZ suites lo dijeron a la
// vez: el acuse entraba a las conversaciones y a las listas de proyecto, o sea duplicaba el
// historial que un agente lee para retomar. La analogia de Nicholas tenia la respuesta: UN TIC NO
// ES UN MENSAJE. El acuse se CONSUME para marcar el sobre que uno mando, y despues desaparece de la
// vista — como el tic de WhatsApp, que vive en tu mensaje y no abre una linea nueva en el chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent, acuseDe } from '../src/correo/agente.js';

const P = 4897;
const CASA = 'acuse.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [CASA]: { url: URL_CASA } };
let tmp, casa, ana, beto;

const entregar = async (p) => { const r = await p; await casa.tick(); await casa.tick(); return r; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-acuse-'));
  casa = await new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  }).start();
  ana = Agent.create(`anita@${CASA}`, URL_CASA, { hosts });
  beto = Agent.create(`betito@${CASA}`, URL_CASA, { hosts });
  await ana.register({ adminToken: 't' });
  await beto.register({ adminToken: 't' });
});
after(async () => { await casa.stop(); });

test('el segundo tic llega SIN pedirlo, y vive en el mensaje que mandaste', async () => {
  const r = await entregar(ana.send({ to: [beto.address], body: 'llego esto?', encrypt: false }));
  const mio = (await ana.conversation(beto.address, { limit: 20 })).find((x) => x.id === r.envelope.id);
  assert.ok(mio, 'el mensaje enviado tiene que estar en la conversacion');
  assert.ok(mio.delivered, 'sin el segundo tic uno no sabe si llego: eso es lo que se vino a arreglar');
  assert.equal(mio.delivered[0].to, beto.address);
});

test('y el acuse NO abre una linea nueva en la conversacion', async () => {
  // Esto es lo que rompio diez suites en la primera version. El historial de una conversacion es
  // lo que un agente lee para retomar: duplicarlo con acuses le gasta el contexto en ruido.
  const antes = (await ana.conversation(beto.address, { limit: 50 })).length;
  await entregar(ana.send({ to: [beto.address], body: 'uno', encrypt: false }));
  await entregar(ana.send({ to: [beto.address], body: 'dos', encrypt: false }));
  const despues = await ana.conversation(beto.address, { limit: 50 });
  assert.equal(despues.length, antes + 2, `dos mensajes tienen que sumar dos lineas, no ${despues.length - antes}`);
  assert.ok(!despues.some((x) => x.envelope?.type === 'receipt'), 'un acuse se colo en la conversacion');
});

test('pero el que lo busca puede verlo, y ordenado: los acuses viven bajo postmaster@', async () => {
  // Un acuse viene del postmaster, asi que su contraparte es el postmaster — no se mezcla con la
  // conversacion de la persona. Eso ya es media solucion: el ruido queda en su propio canal. Y con
  // `?receipts=1` se ve, porque un recibo del Libro ES la prueba de un asiento.
  const pedir = async (q) => {
    const res = await fetch(`${URL_CASA}/conversations/${ana.local}?${q}`, {
      headers: { authorization: ana._auth('GET', `/conversations/${ana.local}`) },
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const pm = `postmaster@${CASA}`;
  const sin = await pedir(`with=${encodeURIComponent(pm)}`);
  assert.deepEqual(sin.messages, [], 'sin pedirlos, los acuses no se ven ni en el canal del postmaster');
  const con = await pedir(`with=${encodeURIComponent(pm)}&receipts=1`);
  assert.ok(con.messages.some((x) => x.envelope?.type === 'receipt'), 'con ?receipts=1 los acuses tienen que verse');
});

test('a quien NO se le acusa, y por que', () => {
  const yo = 'anita@acuse.test';
  // Lo normal.
  assert.equal(acuseDe(undefined, 'message', ['betito@acuse.test'], yo), 'delivered');
  // Un acuse no se acusa: seria un ida y vuelta infinito.
  assert.equal(acuseDe(undefined, 'receipt', ['betito@acuse.test'], yo), undefined);
  // Una direccion de SISTEMA ya contesta sola: el Libro manda su recibo, encargos@ su aviso.
  // Pedirle ademas un acuse es dos respuestas para lo mismo.
  assert.equal(acuseDe(undefined, 'task', ['encargos@acuse.test'], yo), undefined);
  assert.equal(acuseDe(undefined, 'message', ['libro@acuse.test'], yo), undefined);
  // Un sobre a UNO MISMO (un recordatorio) no se acusa: no le dice nada a nadie y, en una direccion
  // adoptada, es un turno mas que mirar. Lo encontro la suite de `vivos`.
  assert.equal(acuseDe(undefined, 'message', [yo], yo), undefined);
  assert.equal(acuseDe(undefined, 'message', [yo.toUpperCase()], yo), undefined);
  // Y la salida explicita, para quien no lo quiera.
  assert.equal(acuseDe('none', 'message', ['betito@acuse.test'], yo), undefined);
  assert.equal(acuseDe(false, 'message', ['betito@acuse.test'], yo), undefined);
  // Lo que el que llama pide, manda.
  assert.equal(acuseDe('delivered', 'receipt', ['betito@acuse.test'], yo), 'delivered');
});

test('un acuse ajeno no marca entregado: solo vale el del postmaster de esta casa', async () => {
  // Sin esto, cualquiera que sepa el id de un sobre puede decirle al remitente que llego.
  const r = await entregar(ana.send({ to: [beto.address], body: 'con acuse falso', encrypt: false, receipt: 'none' }));
  await entregar(beto.send({
    to: [ana.address], type: 'receipt', encrypt: false,
    body: { of: r.envelope.id, to: beto.address, status: 'delivered', reason: 'yo digo que llego' },
  }));
  const mio = (await ana.conversation(beto.address, { limit: 50 })).find((x) => x.id === r.envelope.id);
  assert.ok(mio, 'el mensaje tiene que seguir ahi');
  assert.ok(!mio.delivered, 'un acuse firmado por otro marco el sobre como entregado');
});

test('el acuse nace CONFIRMADO: un tic no se atiende', async () => {
  // Si queda pendiente, el buzon de quien manda no se vacia nunca. Un ejecutor que contesta y sale
  // lo deja ahi para siempre, y una direccion adoptada lo cuenta como un turno que mirar —o sea
  // gasto de API por un acuse. Lo encontro la suite del ejecutor: `listMail` daba 1 donde esperaba 0.
  // Se mira EL ACUSE DE ENTREGA del postmaster, no «cualquier recibo»: otra prueba de este archivo
  // deja a proposito un recibo falso de beto, y contarlo seria confundir dos cosas distintas.
  const acusesPendientes = async () => (await ana.inbox({ limit: 50 }))
    .filter((x) => x.envelope?.from === `postmaster@${CASA}` && x.envelope?.content?.body?.status === 'delivered');
  assert.deepEqual(await acusesPendientes(), [], 'habia acuses pendientes antes de empezar');
  await entregar(ana.send({ to: [beto.address], body: 'esto no me tiene que volver como pendiente', encrypt: false }));
  assert.deepEqual(await acusesPendientes(), [], 'el acuse quedo PENDIENTE en el buzon del que mando');

  // Pero sigue en el HISTORIAL, que es de donde la conversacion lo consume para marcar el tic.
  // Si se borrara, el tic se perderia al releer.
  const hist = await casa.store.listMailHistory(ana.local, { limit: 50 });
  assert.ok(hist.some((m) => m.envelope?.type === 'receipt'), 'el acuse tiene que quedar en el historial');
});

test('un REBOTE si queda pendiente: dice que algo NO llego', async () => {
  // La otra mitad, y es la que importa: se confirma SOLO el acuse de entrega. Un rebote confirmado
  // solo seria un fallo invisible — exactamente lo que esta casa existe para no hacer. Se ejerce la
  // rama directamente porque provocar un rebote de verdad pide una casa inalcanzable y reintentos,
  // y lo que hay que fijar aqui es la decision, no el camino.
  const r = await entregar(ana.send({ to: [beto.address], body: 'para fabricar los dos avisos', encrypt: false }));
  const job = { envelope: r.envelope, to: [beto.address] };
  const pendientesDe = async (estado) => (await ana.inbox({ limit: 80 }))
    .filter((x) => x.envelope?.from === `postmaster@${CASA}` && x.envelope?.content?.body?.status === estado);

  await casa._notify(job, beto.address, 'failed', 'la casa del destino dijo que no');
  const rebotes = await pendientesDe('failed');
  assert.ok(rebotes.length >= 1, 'el rebote tiene que quedar PENDIENTE para que alguien lo lea');

  await casa._notify(job, beto.address, 'delivered', 'llego');
  assert.deepEqual(await pendientesDe('delivered'), [], 'el acuse de entrega no puede quedar pendiente');
});
