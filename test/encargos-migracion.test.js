// node --test test/
// La migración 0011 traduce estados, y SÓLO estados.
//
// Se prueba contra el defecto que esta migración puede cometer y que sería invisible: `delivered`
// es a la vez un ESTADO y el nombre del CAMPO que guarda la entrega. Un reemplazo de texto sobre
// el documento renombraría el campo y la entrega quedaría invisible — el encargo diría que nadie
// entregó nada. Por eso la migración usa `json_set` sobre `$.state`, y por eso esta prueba mete un
// encargo con entrega hecha y comprueba que el campo sobrevive.
import { test as _test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import { ESTADOS } from '../src/libro/encargos.js';

const test = (n, f) => _test(n, sqliteAvailable ? {} : { skip: 'node:sqlite no disponible' }, f);

// Un encargo tal como lo escribía la versión del 17-nov: vocabulario viejo y con entrega hecha.
const VIEJO = (id, state) => ({
  nyx5: '1', kind: 'encargo', id, from: 'nicholas@nyx5.com', owner: 'nicholas@nyx5.com',
  assignee: 'sigo-cto@nyx5.com', parent_id: null, depth: 0, rev: 3,
  concept: 'algo de antes', detail: null, verify: null, state,
  created: '2026-11-17T10:00:00.000Z', updated: '2026-11-17T12:00:00.000Z',
  delivered: { at: '2026-11-17T12:00:00.000Z', by: 'sigo-cto@nyx5.com', note: 'la entrega que no se puede perder', evidence_sha256: null, url: null },
  closed: null,
  log: [
    { at: '2026-11-17T10:00:00.000Z', by: 'nicholas@nyx5.com', paso: 'crear', state: 'open' },
    { at: '2026-11-17T11:00:00.000Z', by: 'sigo-cto@nyx5.com', paso: 'tomar', state: 'taken' },
    { at: '2026-11-17T12:00:00.000Z', by: 'sigo-cto@nyx5.com', paso: 'entregar', state: 'delivered' },
  ],
});

test('la 0011 traduce los cinco estados viejos y no toca el campo de la entrega', async () => {
  const db = openLocalD1();
  // Primero el esquema SIN la 0011, para poder sembrar documentos viejos y migrarlos después.
  const todas = MIGRACIONES;
  const corte = todas.indexOf('-- 0011 · Los encargos pasan al vocabulario A2A');
  assert.ok(corte > 0, 'no se encontró la 0011 en el concatenado de migraciones');
  db._raw.exec(todas.slice(0, corte));

  const store = new D1Store(db);
  const viejos = [['e-open', 'open'], ['e-taken', 'taken'], ['e-deliv', 'delivered'], ['e-done', 'done'], ['e-canc', 'cancelled']];
  for (const [id, st] of viejos) await store.encargoCrear(VIEJO(id, st));
  // Uno que ya está en el vocabulario nuevo: la migración no puede tocarlo.
  await store.encargoCrear({ ...VIEJO('e-nuevo', 'working'), log: [{ at: '2026-11-18T00:00:00.000Z', by: 'x@y.test', paso: 'crear', state: 'submitted' }] });

  db._raw.exec(todas.slice(corte));

  const esperado = { 'e-open': 'submitted', 'e-taken': 'working', 'e-deliv': 'input-required', 'e-done': 'completed', 'e-canc': 'canceled', 'e-nuevo': 'working' };
  for (const [id, st] of Object.entries(esperado)) {
    const e = await store.encargoGet(id);
    assert.equal(e.state, st, `${id} quedó en ${e.state} y debía quedar en ${st}`);
    assert.ok(ESTADOS.includes(e.state), `${id} quedó con un estado que no existe: ${e.state}`);
  }

  // LO QUE DE VERDAD IMPORTA: la entrega sigue ahí, con su texto intacto.
  const conEntrega = await store.encargoGet('e-deliv');
  assert.ok(conEntrega.delivered, 'el CAMPO delivered desapareció: un reemplazo de texto renombró el campo junto al estado');
  assert.equal(conEntrega.delivered.note, 'la entrega que no se puede perder');
  assert.equal(conEntrega.delivered.by, 'sigo-cto@nyx5.com');

  // El historial queda legible: ninguna etiqueta del vocabulario viejo.
  for (const id of Object.keys(esperado)) {
    for (const l of (await store.encargoGet(id)).log) {
      assert.ok(ESTADOS.includes(l.state), `${id} tiene un paso del historial con estado viejo: ${l.state}`);
      assert.ok(l.at && l.by && l.paso, 'la migración no puede borrar hechos del historial, sólo traducir su etiqueta');
    }
  }
  // Y los hechos siguen siendo los mismos: tres pasos, en su orden, con sus autores.
  assert.deepEqual(conEntrega.log.map((l) => l.paso), ['crear', 'tomar', 'entregar']);
  assert.deepEqual(conEntrega.log.map((l) => l.state), ['submitted', 'working', 'input-required']);

  // Los tres campos nuevos existen en todos, aunque sea en null.
  for (const id of Object.keys(esperado)) {
    const e = await store.encargoGet(id);
    for (const campo of ['project', 'reason', 'due']) {
      assert.ok(campo in e, `${id} no tiene el campo ${campo}: una lectura con dos caminos deja uno sin probar`);
    }
  }
});

test('correr la 0011 dos veces deja lo mismo', async () => {
  const db = openLocalD1();
  db._raw.exec(MIGRACIONES);
  const store = new D1Store(db);
  await store.encargoCrear(VIEJO('e-idem', 'open'));
  const corte = MIGRACIONES.indexOf('-- 0011 · Los encargos pasan al vocabulario A2A');
  db._raw.exec(MIGRACIONES.slice(corte));
  const una = await store.encargoGet('e-idem');
  db._raw.exec(MIGRACIONES.slice(corte));
  const dos = await store.encargoGet('e-idem');
  assert.equal(una.state, 'submitted');
  assert.deepEqual(dos, una, 'la migración tiene que ser idempotente');
});
