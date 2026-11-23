// node --test test/
// El tablero de quien DELEGA (23-nov-2026).
//
// Defecto medido, no idea: `claude.nico@` —el Claude conectado de Nicholas— creó el encargo
// 1081c742 y su dueño NO lo veía en su tablero. Su tablero decía 1 abierto; el del asignado, 2. No
// era un permiso mal puesto: un delegado es OTRA dirección, y el tablero mira direcciones. Justo
// cuando por fin hay agentes pidiendo trabajo, el tablero deja de ser «quién le debe qué a quién».
//
// Lo que estas pruebas fijan, y el orden importa:
//   1. que el que delega VEA lo de su delegado (el defecto);
//   2. que el delegado NO vea lo de su principal (la dirección es una sola, y al revés es fuga);
//   3. que un delegado revocado deje de hablar por nadie;
//   4. que la CONSOLA —la pantalla que se mira— muestre lo mismo que el tablero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { visibleParaAlguna } from '../src/libro/encargos.js';

const P = 4892;
const CASA = 'voces.test';
const hosts = { [CASA]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, jefe, ajeno, conectado, nieto;

const unir = async (local) => (await join({ house: CASA, name: local, hosts }))._agente;
const entregar = async (p) => { const r = await p; await casa.tick(); return r; };
const idsDe = (t) => t.filas.map((f) => f.id);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-voces-'));
  casa = new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  });
  await casa.start();
  jefe = await unir('jefe');
  ajeno = await unir('ajeno');
  // El caso real: un Claude conectado, de sólo mensajes, con la llave guardada en la casa.
  conectado = await jefe.delegate('claude', { scope: { messages_only: true } });
  // Y un eslabón más abajo, para que la cadena no sea de un solo salto.
  nieto = await conectado.delegate('ayudante', { scope: { messages_only: true } });
});
after(async () => { await casa.stop(); });

test('el que delega ve en SU tablero lo que pidió su delegado', async () => {
  const r = await entregar(conectado.encargar(CASA, { concept: 'FASE 1 aprobada (urgente, demo)', assignee: ajeno.address }));
  const id = r.envelope.id;

  // Esto es exactamente lo que fallaba: el delegado lo ve y su dueño no.
  assert.ok(idsDe(await conectado.tablero(CASA)).includes(id), 'el delegado tiene que ver lo suyo');
  assert.ok(idsDe(await jefe.tablero(CASA)).includes(id), 'el que delega NO veía lo que pidió su propio Claude');
  assert.ok(idsDe(await ajeno.tablero(CASA)).includes(id), 'y el asignado lo ve, como siempre');
});

test('también lo que le pidieron al delegado, y a través de la cadena entera', async () => {
  const paraElDelegado = await entregar(ajeno.encargar(CASA, { concept: 'algo para el Claude conectado', assignee: conectado.address }));
  assert.ok(idsDe(await jefe.tablero(CASA)).includes(paraElDelegado.envelope.id),
    'el que delega responde también por lo que le PIDEN a su delegado');

  // Un salto más abajo: el delegado de su delegado.
  const delNieto = await entregar(nieto.encargar(CASA, { concept: 'del nieto' }));
  assert.ok(idsDe(await jefe.tablero(CASA)).includes(delNieto.envelope.id), 'la cadena tiene que subir más de un eslabón');
  assert.ok(idsDe(await conectado.tablero(CASA)).includes(delNieto.envelope.id), 'y el eslabón del medio también lo ve');
});

test('la dirección es UNA SOLA: el delegado nunca ve lo de su principal', async () => {
  // La mitad que importa. El delegado que motivó esto tiene la llave guardada en la CASA: si viera
  // hacia arriba, la casa estaría abriendo el trabajo entero de su dueño a una pantalla conectada.
  const delJefe = await entregar(jefe.encargar(CASA, { concept: 'cosa privada del jefe', assignee: ajeno.address }));
  const id = delJefe.envelope.id;
  assert.ok(idsDe(await jefe.tablero(CASA)).includes(id));
  assert.ok(!idsDe(await conectado.tablero(CASA)).includes(id), 'un delegado NO puede ver lo de su principal');
  assert.ok(!idsDe(await nieto.tablero(CASA)).includes(id), 'ni el nieto');
  // Y un tercero sigue sin ver nada de nadie.
  assert.ok(!idsDe(await ajeno.tablero(CASA)).some((x) => x === 'inventado'));
  const vocesDelConectado = await casa.vocesDe(conectado.address);
  assert.ok(!vocesDelConectado.includes(jefe.address), `un delegado no habla por su principal: ${vocesDelConectado.join(', ')}`);
});

test('un delegado revocado deja de hablar por su principal', async () => {
  const otro = await unir('otro');
  const temporal = await otro.delegate('temporal', { scope: { messages_only: true } });
  const r = await entregar(temporal.encargar(CASA, { concept: 'pedido antes de revocar' }));
  assert.ok(idsDe(await otro.tablero(CASA)).includes(r.envelope.id), 'antes de revocar, se ve');

  await otro._call('DELETE', `/agents/${temporal.local}`).catch(async () => {
    await casa.store.putAgent(temporal.local, { ...(await casa.store.getAgent(temporal.local)), revoked: true });
  });
  const voces = await casa.vocesDe(otro.address);
  assert.ok(!voces.includes(temporal.address), `un delegado revocado no habla por nadie: ${voces.join(', ')}`);
});

test('la vista unificada lo muestra', async () => {
  const r = await entregar(conectado.encargar(CASA, { concept: 'lo que tiene que salir en la vista', assignee: ajeno.address }));
  const v = await jefe.trabajo(CASA);
  assert.ok(v.filas.some((f) => f.id === r.envelope.id), 'la vista unificada tiene que mostrarlo');
});

test('y la CONSOLA tambien: es la PANTALLA que se abre, y es otra ruta', async () => {
  // La verificacion por mutacion dijo que esto faltaba: quitarle las voces a `/consola/datos` no
  // rompia NADA, porque la prueba de arriba va por `/trabajo`. Dos rutas distintas sirven la misma
  // vista, y la que Nicholas mira es esta. Un guardia que cubre la ruta de al lado no cubre nada.
  const r = await entregar(conectado.encargar(CASA, { concept: 'lo que tiene que salir en la consola', assignee: ajeno.address }));
  const sesion = await jefe.abrirConsola(CASA);
  const res = await fetch(`http://127.0.0.1:${P}/consola/datos`, { headers: { authorization: `Nyx5-Consola ${sesion.token}` } });
  assert.equal(res.status, 200, 'la sesion de consola tiene que servir');
  const datos = await res.json();
  assert.ok(datos.filas.some((f) => f.id === r.envelope.id),
    'la consola no muestra lo que pidio el Claude conectado de su dueno');
  assert.equal(datos.address, jefe.address);
});

test('el predicado no se da la razón solo', () => {
  const e = { from: 'a@c', assignee: 'b@c', owner: 'a@c' };
  assert.equal(visibleParaAlguna(e, []), false, 'sin voces no se ve nada');
  assert.equal(visibleParaAlguna(e, ['z@c']), false);
  assert.equal(visibleParaAlguna(e, ['z@c', 'b@c']), true);
});
