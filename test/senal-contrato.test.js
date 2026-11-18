// node --test test/
// La op `signal` del LIBRO, ejercida de verdad contra un contrato vivo.
//
// POR QUÉ ESTE ARCHIVO EXISTE. La primera versión de la fase 2 tenía la op escrita y probada
// «por los lados»: `test/vista.test.js` comprobaba `senalAbierta` sobre un historial armado a
// mano, y nunca llamaba a la op. Lo midieron las mutaciones: dejar que un TERCERO señale un
// contrato, y hacer que la señal CAMBIE el estado, no hacían gritar a nadie. Dos guardias sin
// probar, y los dos sobre dinero.
//
// Lo que se exige acá, y es todo lo que hace segura a una señal:
//   · no cambia `state`;
//   · no mueve un token (el saldo de las dos partes queda igual);
//   · no emite asiento (el número del diario no avanza);
//   · sólo las partes y la casa pueden mandarla;
//   · un contrato terminado no la recibe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { senalAbierta } from '../src/libro/senal.js';

const P = 4189;
const H = 'senal.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, comprador, vendedor, tercero, arbitro;

const saldo = (a) => casa.libro.balance(a);
const seqDelDiario = async () => (await casa.store.libroState()).seq;
// Los asientos que MUEVEN algo. La casa escribe además un asiento de CONTROL (`lines: []`) por
// cada op que entra, señal incluida: eso no es un movimiento y no tiene por qué no ocurrir. Lo que
// una señal no puede hacer es mover saldo, y eso se mide contando líneas, no asientos.
const conMovimiento = async () => (await casa.store.libroJournal()).filter((a) => (a.lines || []).length > 0).length;
const contratoVivo = async () => (await casa.store.libroListContracts()).find((c) => c.state === 'held');
// El rebote del postmaster trae la razón del rechazo del Libro: es el único lugar donde se lee.
const rebote = async (agente, idSobre) => {
  const m = await agente.waitFor((e) => e.type === 'receipt' && e.from === `postmaster@${H}` && e.in_reply_to === idSobre, { timeoutMs: 6000 });
  return JSON.stringify((await agente.open(m.envelope)).content.body);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-senal-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 'a', hosts,
    workerIntervalMs: 100, libro: { feePct: 0.10, welcome: 0 }, log: () => {},
  }).start();
  comprador = Agent.create(`comprador@${H}`, hosts[H].url, { hosts });
  vendedor = Agent.create(`vendedor@${H}`, hosts[H].url, { hosts });
  tercero = Agent.create(`tercero@${H}`, hosts[H].url, { hosts });
  // El árbitro es una dirección aparte a propósito: el árbitro ES parte del contrato, así que no
  // puede ser el mismo que usamos para probar que un tercero NO puede señalar.
  arbitro = Agent.create(`arbitro@${H}`, hosts[H].url, { hosts });
  for (const a of [comprador, vendedor, tercero, arbitro]) await a.register({ adminToken: 'a' });
  await casa.libro.topup(comprador.address, 1000, 'carga de prueba');

  // Un escrow de verdad: el vendedor cotiza, el comprador acepta, quedan 400 retenidos.
  const q = await vendedor.quote({ to: comprador.address, contract: 'escrow', price: 400, concept: 'la pieza', arbiter: arbitro.address });
  // `q.id` es el id del SOBRE, no el de la cotización: la primera versión esperaba `q.quote.id` y
  // el `waitFor` se quedó diez segundos esperando algo que nunca iba a llegar con ese id.
  const cot = (await comprador.open((await comprador.waitFor((e) => e.id === q.id, { timeoutMs: 8000 })).envelope)).content.body;
  await comprador.accept(cot);
  await casa.tick();
});
after(async () => { await casa.stop(); });

test('el escrow quedó vivo: sin eso estas pruebas pasarían por la razón equivocada', async () => {
  const c = await contratoVivo();
  assert.ok(c, 'no hay contrato en held');
  assert.equal(c.amount, 400);
  assert.equal(await saldo(vendedor.address), 0, 'el dinero está retenido, no entregado');
});

test('una señal no cambia el estado, no mueve un token y no emite asiento', async () => {
  const c = await contratoVivo();
  const antes = { state: c.state, comprador: await saldo(comprador.address), vendedor: await saldo(vendedor.address), movimientos: await conMovimiento() };

  await vendedor.senalarContrato(H, c.id, 'input-required', 'necesito el dato del banco');
  await casa.tick();

  const d = await casa.store.libroGetContract(c.id);
  assert.equal(d.state, antes.state, `la señal movió el estado a ${d.state}`);
  assert.equal(await saldo(comprador.address), antes.comprador, 'la señal movió el saldo del comprador');
  assert.equal(await saldo(vendedor.address), antes.vendedor, 'la señal movió el saldo del vendedor');
  assert.equal(await conMovimiento(), antes.movimientos, 'la señal emitió un asiento CON líneas: una señal no mueve dinero');
  // Y el asiento de control que sí aparece no mueve nada: cuadra en cero por no tener líneas.
  const ultimo = (await casa.store.libroJournal()).at(-1);
  assert.deepEqual(ultimo.lines, [], 'el último asiento tras una señal tiene que ser de control, sin líneas');

  // Y sí quedó registrada, derivada del historial.
  const s = senalAbierta(d.history);
  assert.equal(s.kind, 'input-required');
  assert.match(s.reason, /banco/);
  assert.equal(s.by, vendedor.address);
  assert.ok(d.history.some((h) => h.op === 'signal'), 'la señal tiene que estar en el historial');
});

test('progress no cierra lo que bloquea; resumed sí', async () => {
  const c = await contratoVivo();
  await vendedor.senalarContrato(H, c.id, 'progress', 'voy en la mitad');
  await casa.tick();
  assert.equal(senalAbierta((await casa.store.libroGetContract(c.id)).history).kind, 'input-required', 'progress no puede cerrar un bloqueo');

  await comprador.senalarContrato(H, c.id, 'resumed');
  await casa.tick();
  assert.equal(senalAbierta((await casa.store.libroGetContract(c.id)).history), null, 'resumed tiene que cerrar');
});

test('un tercero NO puede señalar un contrato ajeno, y el rechazo lo dice', async () => {
  const c = await contratoVivo();
  const antes = (await casa.store.libroGetContract(c.id)).history.length;
  const r = await tercero.senalarContrato(H, c.id, 'input-required', 'me meto donde no me llaman');
  await casa.tick();
  assert.match(await rebote(tercero, r.envelope.id), /only the parties of this contract/);
  assert.equal((await casa.store.libroGetContract(c.id)).history.length, antes, 'el historial de un trato ajeno no se toca');
});

test('un kind inventado se rechaza, y el rechazo dice cuáles hay', async () => {
  const c = await contratoVivo();
  const r = await vendedor.senalarContrato(H, c.id, 'bloqueado-porque-si');
  await casa.tick();
  const texto = await rebote(vendedor, r.envelope.id);
  assert.match(texto, /kind must be one of/);
  assert.match(texto, /input-required/, 'el rechazo tiene que decir el vocabulario, no sólo que está mal');
});

test('un contrato terminado no recibe señales', async () => {
  const c = await contratoVivo();
  // Se libera: el trabajo se pagó y el trato quedó en Terminal.
  await comprador.release(H, c.id);
  await casa.tick();
  const cerrado = await casa.store.libroGetContract(c.id);
  assert.equal(cerrado.state, 'released');
  assert.ok(await saldo(vendedor.address) > 0, 'y el vendedor cobró, que es lo que prueba que era dinero de verdad');

  const r = await vendedor.senalarContrato(H, c.id, 'input-required', 'tarde');
  await casa.tick();
  assert.match(await rebote(vendedor, r.envelope.id), /nothing is pending on it/);
});
