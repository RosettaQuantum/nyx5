// node --test test/
// Retirar una dirección PROPIA de la casa. Nace de un hueco real del 17-nov-2026: `revoke`
// exigía `rec.delegation`, así que una dirección registrada por la puerta abierta no se podía
// retirar por ninguna puerta. Lo descubrí teniendo que limpiar 10 que una prueba mía registró
// por error en producción, y la única alternativa era editar la fila a mano — lo que deja la
// certificación sin cubrir el cuerpo, es decir una tarjeta que ya no verifica. Retirar por
// corrupción no es retirar.
//
// Lo que estas pruebas cuidan, en orden de lo que costaría equivocarse:
//   - que NUNCA se pueda retirar una dirección de sistema (retirar libro@ rompe la casa);
//   - que lo haga sólo la casa, y no un agente cualquiera pidiéndolo por su cuenta;
//   - que la tarjeta quede FIRMADA con su `revoked` dentro, no editada por detrás;
//   - que el resolver deje de aceptarla de verdad, que es el punto de todo esto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { verifyObject } from '../src/nucleo/crypto.js';

const P = 4188;
const H = 'retiro.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

const retirar = (local, headers = {}) => fetch(`http://127.0.0.1:${P}/agents/${local}/revoke`, { method: 'POST', headers });
const comoCasa = { authorization: 'Bearer secreto-de-la-casa' };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-retiro-'));
  casa = new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 'secreto-de-la-casa', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); });

test('una dirección de sistema NO se retira, aunque lo pida la casa', async () => {
  // Es el que más caro sale: sin este guardia, retirar libro@ o verifica@ deja la casa sin
  // Libro y sin árbitro, y la tarjeta firmada de vuelta diría que es correcto.
  for (const sys of ['libro', 'verifica', 'postmaster', 'encargos']) {
    const r = await retirar(sys, comoCasa);
    assert.equal(r.status, 403, `${sys}@ no se puede retirar`);
    const rec = await casa.store.getAgent(sys);
    if (rec) assert.ok(!rec.revoked, `${sys}@ sigue vivo`);
  }
});

test('la casa retira una dirección que se registró sola, y la tarjeta queda FIRMADA', async () => {
  const a = await join({ house: H, name: 'pasajero', hosts });
  assert.ok(await casa.store.getAgent('pasajero'));

  const r = await retirar('pasajero', comoCasa);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.address, `pasajero@${H}`);
  assert.ok(j.revoked?.at, 'dice cuándo');
  assert.equal(j.revoked.by, `casa@${H}`, 'y quién');
  assert.equal(j.retired, true, 'se distingue de revocar un delegado');

  // Lo que de verdad importa: la tarjeta que la casa SIRVE verifica con su `revoked` dentro. Se
  // comprueba sobre lo servido y no sobre la fila, porque `webhook` y `notify_email` son privados
  // y quedan fuera de la firma a propósito: verificar la fila entera da falso siempre, y eso
  // escondería el defecto de verdad. Si alguien editara la fila por detrás, el cuerpo servido
  // dejaría de cuadrar con la certificación y esto fallaría.
  const rec = await casa.store.getAgent('pasajero');
  assert.ok(rec.revoked, 'la fila lo dice');
  assert.ok(Date.parse(rec.valid_until) <= Date.now(), 'y la tarjeta ya venció');
  const servida = await (await fetch(`http://127.0.0.1:${P}/agents/pasajero`)).json();
  assert.ok(servida.revoked, 'la tarjeta pública lo dice');
  assert.ok(verifyObject(servida, casa.keys.sig, 'certification'), 'la certificación de la casa cubre el cuerpo CON su revoked');

  // Y el resolver deja de aceptarla, que es el punto.
  await assert.rejects(() => casa.resolver.agentCard(`pasajero@${H}`), (e) => /revoked|expired|venc/i.test(e.message), 'el resolver tiene que rechazarla');
});

test('retirar dos veces no es un error, y lo dice', async () => {
  await join({ house: H, name: 'dos-veces', hosts });
  assert.equal((await retirar('dos-veces', comoCasa)).status, 200);
  const otra = await retirar('dos-veces', comoCasa);
  assert.equal(otra.status, 200);
  assert.equal((await otra.json()).already, true, 'la segunda vez avisa que ya estaba');
});

test('sin el token de la casa, una dirección sin delegante no se retira', async () => {
  const a = await join({ house: H, name: 'ajeno', hosts });
  // Sin credencial ninguna: la respuesta es la de antes (no hay tal subagente), para no confirmar
  // por la puerta quién existe y quién no.
  assert.equal((await retirar('ajeno')).status, 404);
  // Y con la firma del propio interesado tampoco: una dirección sin delegante sólo la retira la
  // casa. Antes este camino no existía; que exista no puede abrirlo a cualquiera.
  const conFirma = await retirar('ajeno', { authorization: a._agente._auth('POST', '/agents/ajeno/revoke') });
  assert.equal(conFirma.status, 404);
  assert.ok(!(await casa.store.getAgent('ajeno')).revoked, 'sigue vivo');
});

test('una dirección que no existe da 404, no un retiro fantasma', async () => {
  assert.equal((await retirar('nadie-de-aqui', comoCasa)).status, 404);
});
