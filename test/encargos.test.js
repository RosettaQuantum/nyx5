// node --test test/
// Encargos (SPEC v0.2, opción B): trabajo interno con dueño y estado, SIN dinero.
//
// Cada prueba de aquí está escrita contra un defecto que este diseño puede tener de verdad, no
// contra un ejemplo inventado:
//   - que la plata entre por la puerta de atrás (un encargo con precio = un contrato de cero);
//   - que algún día alguien cablee los encargos al Libro y aparezca un asiento sin dinero;
//   - que el último en escribir borre la transición del primero (medido ya dos veces en esta casa);
//   - que `devolver` deje la entrega puesta y el tablero cuente como entregado algo que volvió;
//   - que la migración no sea SQL válido, que es un defecto que ninguna prueba de unidad ve.
import { test as _test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/nucleo/almacen.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import {
  ABIERTOS, ESTADOS, FINALES, PASOS, PROFUNDIDAD_MAX, SIN_PLATA, TOPES_H, VERIFY_MAX,
  aplicarPaso, atascado, crearEncargo, progreso, tablero,
} from '../src/libro/encargos.js';

const test = (name, ...rest) => { const fn = rest.pop(); const opts = (rest[0] && typeof rest[0] === 'object') ? rest[0] : {}; return _test(name, sqliteAvailable ? opts : { ...opts, skip: 'node:sqlite no disponible (Node 22+)' }, fn); };
const d1store = () => { const db = openLocalD1(); db._raw.exec(MIGRACIONES); return new D1Store(db); };
const filestore = () => new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-encargos-')));

const PIDE = 'nicholas@nyx5.com';
const HACE = 'sigo-cto@nyx5.com';
const OTRO = 'rosetta@nyx5.com';
const base = (extra = {}) => crearEncargo({ id: 'e1', from: PIDE, concept: 'revisar el candado del escrow', ...extra });

// ---------- 1. el dinero no entra ----------

_test('un encargo con precio no nace: sin esto vuelve el contrato de valor cero', () => {
  for (const campo of SIN_PLATA) {
    assert.throws(() => crearEncargo({ id: 'x', from: PIDE, concept: 'c', [campo]: 1 }),
      (e) => e.code === 400 && new RegExp(campo).test(e.message), `un encargo con ${campo} tiene que ser rechazado`);
  }
  // Y en `terms`, que es donde un contrato los lleva de verdad.
  assert.throws(() => { const e = base(); e.terms = { price: 0 }; return aplicarPaso(e, 'tomar', { por: HACE }); },
    (e) => e.code === 400 && /price/.test(e.message), 'terms.price tiene que ser rechazado también');
});

_test('el texto del encargo puede hablar de plata: el guardia mira campos, no palabras', () => {
  const e = crearEncargo({ id: 'e2', from: PIDE, concept: 'subir el precio del plan a 20 USD', detail: 'el fee queda en 0,5%' });
  assert.equal(e.state, 'open');
  assert.match(e.concept, /precio/);
});

_test('un criterio sin tope y un dueño que no es dirección no entran', () => {
  // `verify` llega de afuera y se GUARDA: sin tope, el remitente decide cuánto ocupa la fila.
  assert.throws(() => crearEncargo({ id: 'v', from: PIDE, concept: 'c', verify: Array.from({ length: VERIFY_MAX + 1 }, () => ({ type: 'sha256' })) }),
    (e) => e.code === 400 && /at most/.test(e.message));
  assert.equal(crearEncargo({ id: 'v', from: PIDE, concept: 'c', verify: Array.from({ length: VERIFY_MAX }, () => ({ type: 'sha256' })) }).verify.length, VERIFY_MAX);
  // Un `assignee` que no es una dirección es un dueño que no podría tomar nunca lo que se le dio.
  for (const malo of ['obrero', 'obrero@', '@casa.test', 'obrero@casa', 'dos @ casa.test']) {
    assert.throws(() => crearEncargo({ id: 'a', from: PIDE, concept: 'c', assignee: malo }), (e) => e.code === 400 && /does not look like an address/.test(e.message), `${malo} no es una dirección`);
  }
  // Se guarda en minúsculas, porque el paso compara cadenas: `Obrero@` no podría tomar lo suyo.
  assert.equal(crearEncargo({ id: 'a', from: PIDE, concept: 'c', assignee: 'Obrero@Casa.Test' }).assignee, 'obrero@casa.test');
});

// ---------- 2. un encargo nunca produce un asiento ----------

test('el ciclo completo de un encargo no deja ni un asiento ni un contrato', async () => {
  for (const store of [filestore(), d1store()]) {
    const quien = store.constructor.name;
    let e = base();
    assert.equal(await store.encargoCrear(e), true, `${quien}: el encargo tiene que entrar`);
    for (const [paso, por] of [['tomar', HACE], ['entregar', HACE], ['cerrar', PIDE]]) {
      const antes = await store.encargoGet(e.id);
      e = aplicarPaso(antes, paso, { por });
      assert.equal(await store.encargoPaso(e, antes.rev), true, `${quien}: ${paso} tiene que entrar`);
    }
    assert.equal((await store.encargoGet('e1')).state, 'done');
    // El terreno, no el diseño: se le pregunta al LIBRO si se movió algo.
    assert.deepEqual(await store.libroJournal(), [], `${quien}: un encargo no escribe en el diario`);
    assert.deepEqual(await store.libroListContracts(), [], `${quien}: un encargo no crea contratos`);
    assert.equal((await store.libroState()).seq, 0, `${quien}: un encargo no consume número de asiento`);
  }
});

// ---------- 3. la autoridad se compara, no se pregunta ----------

_test('sólo el asignado entrega y sólo quien encargó cierra', () => {
  const tomado = aplicarPaso(base(), 'tomar', { por: HACE });
  assert.equal(tomado.assignee, HACE);
  assert.throws(() => aplicarPaso(tomado, 'entregar', { por: OTRO }), (e) => e.code === 403);
  const entregado = aplicarPaso(tomado, 'entregar', { por: HACE });
  assert.throws(() => aplicarPaso(entregado, 'cerrar', { por: HACE }), (e) => e.code === 403, 'el que hace no se cierra su propio encargo');
  assert.throws(() => aplicarPaso(entregado, 'cerrar', { por: OTRO }), (e) => e.code === 403);
  assert.equal(aplicarPaso(entregado, 'cerrar', { por: PIDE }).state, 'done');
});

_test('un encargo con dueño no se lo queda un tercero', () => {
  const conDueno = base({ assignee: HACE });
  assert.throws(() => aplicarPaso(conDueno, 'tomar', { por: OTRO }), (e) => e.code === 403 && new RegExp(HACE).test(e.message));
  assert.equal(aplicarPaso(conDueno, 'tomar', { por: HACE }).state, 'taken');
});

_test('ningún paso sale de un estado que no lo admite, y los finales no se mueven', () => {
  const cerrado = aplicarPaso(aplicarPaso(aplicarPaso(base(), 'tomar', { por: HACE }), 'entregar', { por: HACE }), 'cerrar', { por: PIDE });
  for (const paso of Object.keys(PASOS)) {
    assert.throws(() => aplicarPaso(cerrado, paso, { por: PIDE }), (e) => e.code === 409, `un encargo done no admite ${paso}`);
  }
  assert.throws(() => aplicarPaso(base(), 'entregar', { por: HACE }), (e) => e.code === 409, 'no se entrega lo que nadie tomó');
});

// ---------- 4. el candado del paso ----------

test('dos pasos desde la misma lectura: pasa uno y el otro se entera', async () => {
  for (const store of [filestore(), d1store()]) {
    const quien = store.constructor.name;
    await store.encargoCrear(base());
    const leido = await store.encargoGet('e1');
    // Dos actores que leyeron el MISMO encargo y dan pasos distintos. Antes de este candado, el
    // segundo escribía encima y la transición del primero desaparecía sin error.
    const a = aplicarPaso(leido, 'tomar', { por: HACE });
    const b = aplicarPaso(leido, 'cancelar', { por: PIDE });
    assert.equal(await store.encargoPaso(a, leido.rev), true, `${quien}: el primero entra`);
    assert.equal(await store.encargoPaso(b, leido.rev), false, `${quien}: el segundo NO puede pisar`);
    assert.equal((await store.encargoGet('e1')).state, 'taken', `${quien}: queda el del primero`);
  }
});

test('crear dos veces el mismo id devuelve false en vez de pisar en silencio', async () => {
  for (const store of [filestore(), d1store()]) {
    const quien = store.constructor.name;
    assert.equal(await store.encargoCrear(base()), true);
    assert.equal(await store.encargoCrear(base({ concept: 'otra cosa' })), false, `${quien}: el segundo tiene que avisar`);
    assert.match((await store.encargoGet('e1')).concept, /candado del escrow/, `${quien}: el primero queda intacto`);
  }
});

// ---------- 5. devolver borra la entrega ----------

_test('devolver deja el encargo en curso y SIN entrega: el tablero no cuenta lo que volvió', () => {
  const entregado = aplicarPaso(aplicarPaso(base(), 'tomar', { por: HACE }), 'entregar', { por: HACE, note: 'listo' });
  assert.ok(entregado.delivered, 'la entrega tiene que quedar registrada');
  const devuelto = aplicarPaso(entregado, 'devolver', { por: PIDE, note: 'falta el caso del rev' });
  assert.equal(devuelto.state, 'taken');
  assert.equal(devuelto.delivered, null, 'una entrega devuelta no sigue puesta');
  assert.equal(devuelto.assignee, HACE, 'sigue siendo de quien lo tenía');
  // El historial sí conserva las dos vueltas: lo que se borra es el estado, no la memoria.
  assert.deepEqual(devuelto.log.map((l) => l.paso), ['crear', 'tomar', 'entregar', 'devolver']);
});

// ---------- 6. el árbol es un bosque por construcción ----------

test('un hijo necesita un padre que exista, y el padre no se puede cambiar después', async () => {
  const store = d1store();
  const padre = base();
  await store.encargoCrear(padre);
  const hijo = crearEncargo({ id: 'h1', from: PIDE, concept: 'la parte del candado', parent: padre });
  assert.equal(hijo.parent_id, 'e1');
  assert.equal(hijo.depth, 1);
  await store.encargoCrear(hijo);
  // Ningún paso toca parent_id ni depth: por eso no hace falta comprobar ciclos.
  const movido = aplicarPaso(hijo, 'tomar', { por: HACE });
  assert.equal(movido.parent_id, 'e1');
  assert.equal(movido.depth, 1);
  assert.deepEqual((await store.encargoList({ parent: 'e1' })).map((e) => e.id), ['h1']);
  assert.deepEqual((await store.encargoList({ parent: null })).map((e) => e.id), ['e1'], 'parent:null pide los de raíz, no todos');
});

_test('no se cuelga más allá del tope, ni de un padre ya cerrado', () => {
  let p = base();
  for (let i = 1; i <= PROFUNDIDAD_MAX; i++) p = crearEncargo({ id: `n${i}`, from: PIDE, concept: `nivel ${i}`, parent: p });
  assert.equal(p.depth, PROFUNDIDAD_MAX);
  assert.throws(() => crearEncargo({ id: 'x', from: PIDE, concept: 'uno más', parent: p }), (e) => e.code === 409 && /levels deep/.test(e.message));
  const cerrado = aplicarPaso(base(), 'cancelar', { por: PIDE });
  assert.throws(() => crearEncargo({ id: 'y', from: PIDE, concept: 'tarde', parent: cerrado }), (e) => e.code === 409 && /already cancelled/.test(e.message));
});

// ---------- 7. el tablero ----------

_test('el progreso de un padre se reporta y no se cierra solo', () => {
  const hijos = [base(), base(), base()].map((h, i) => (i === 0 ? aplicarPaso(aplicarPaso(aplicarPaso(h, 'tomar', { por: HACE }), 'entregar', { por: HACE }), 'cerrar', { por: PIDE }) : h));
  const pr = progreso(hijos);
  assert.equal(pr.total, 3);
  assert.equal(pr.done, 1);
  assert.equal(pr.abiertos, 2);
  assert.equal(pr.completo, false);
  // Todos cerrados: `completo` lo DICE, pero ningún paso del padre ocurre por eso.
  const todos = hijos.map((h) => (FINALES.includes(h.state) ? h : aplicarPaso(aplicarPaso(aplicarPaso(h, 'tomar', { por: HACE }), 'entregar', { por: HACE }), 'cerrar', { por: PIDE })));
  assert.equal(progreso(todos).completo, true);
  assert.equal(progreso([]).completo, false, 'un padre sin hijos no está completo por no tener ninguno');
});

_test('atascado es una cuenta de tiempo, igual en cualquier máquina', () => {
  const ahora = Date.parse('2026-11-17T12:00:00.000Z');
  const viejo = { ...base(), updated: '2026-11-15T12:00:00.000Z' };
  const a = atascado(viejo, ahora);
  assert.equal(a.horas, 48);
  assert.equal(a.tope, TOPES_H.open);
  assert.match(a.razon, /nadie lo ha tomado/);
  assert.equal(atascado({ ...viejo, updated: '2026-11-17T11:00:00.000Z' }, ahora), null, 'una hora no está atascada');
  // Un encargo cerrado no se atasca: no hay nada que esperar.
  for (const state of FINALES) assert.equal(atascado({ ...viejo, state }, ahora), null, `${state} no se atasca`);
});

_test('el tablero pone arriba lo atascado, aunque sea más nuevo que lo que no lo está', () => {
  const ahora = Date.parse('2026-11-17T12:00:00.000Z');
  // El caso que distingue los dos ordenamientos, y que la primera versión de esta prueba NO
  // tenía: `enCurso` es MÁS VIEJO (30 h) pero no está atascado, porque el tope de `taken` son
  // 72 h; `trabado` es más nuevo (25 h) y sí lo está, porque el de `open` son 24. Con el fixture
  // anterior (todo `open`) ordenar por fecha sola daba el mismo resultado y la mutación que
  // quitaba el criterio de atasco no hacía gritar a nadie: una simetría no prueba nada.
  const enCurso = { ...base(), id: 'encurso', state: 'taken', assignee: HACE, updated: '2026-11-16T06:00:00.000Z' };
  const trabado = { ...base(), id: 'trabado', updated: '2026-11-16T11:00:00.000Z' };
  const fresco = { ...base(), id: 'fresco', updated: '2026-11-17T11:59:00.000Z' };
  const cerrado = { ...base(), id: 'cerrado', state: 'done' };
  assert.equal(atascado(enCurso, ahora), null, 'el fixture sólo sirve si enCurso NO está atascado');
  assert.ok(atascado(trabado, ahora), 'el fixture sólo sirve si trabado SÍ lo está');
  assert.ok(Date.parse(enCurso.updated) < Date.parse(trabado.updated), 'y si enCurso es el más viejo de los dos');

  const t = tablero([fresco, enCurso, cerrado, trabado], ahora);
  assert.equal(t.total, 4);
  assert.equal(t.abiertos, 3, 'lo cerrado no cuenta como abierto');
  assert.equal(t.atascados, 1);
  assert.deepEqual(t.filas.map((f) => f.id), ['trabado', 'encurso', 'fresco'], 'lo atascado va arriba y el resto por antigüedad');
  assert.equal(t.por_estado.done, 1);
  assert.ok(!t.filas.some((f) => f.id === 'cerrado'), 'el tablero no muestra lo cerrado');
});

// ---------- 8. la migración es SQL de verdad ----------

test('la 0010 crea la tabla y los dos índices, y los filtros los usan', async () => {
  const db = openLocalD1();
  db._raw.exec(MIGRACIONES);
  const tabla = db._raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nyx5_encargos'").get();
  assert.ok(tabla, 'la migración 0010 tiene que crear nyx5_encargos');
  const indices = db._raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nyx5_encargos'").all().map((r) => r.name);
  for (const i of ['nyx5_encargos_estado', 'nyx5_encargos_padre']) assert.ok(indices.includes(i), `falta el índice ${i}`);
  // Que el índice exista no dice que la consulta lo use: se lo pregunta al planificador.
  const plan = db._raw.prepare("EXPLAIN QUERY PLAN SELECT doc FROM nyx5_encargos WHERE json_extract(doc, '$.state') IN ('open')").all().map((r) => r.detail).join(' ');
  assert.match(plan, /nyx5_encargos_estado/, `el filtro por estado tiene que usar el índice, y el plan dice: ${plan}`);
});

test('los dos almacenes contestan lo mismo a las mismas preguntas', async () => {
  const respuestas = [];
  for (const store of [filestore(), d1store()]) {
    await store.encargoCrear(base());
    await store.encargoCrear(base({ id: 'e2', concept: 'segundo' }));
    const leido = await store.encargoGet('e2');
    await store.encargoPaso(aplicarPaso(leido, 'tomar', { por: HACE }), leido.rev);
    respuestas.push({
      abiertos: (await store.encargoList({ state: ABIERTOS })).map((e) => e.id),
      tomados: (await store.encargoList({ state: 'taken' })).map((e) => e.id),
      ninguno: await store.encargoList({ state: [] }),
      faltante: await store.encargoGet('no-existe'),
    });
  }
  assert.deepEqual(respuestas[0], respuestas[1], 'FileStore y D1Store no pueden diferir: las pruebas locales dejarían de ver un defecto de producción');
  assert.deepEqual(respuestas[0].tomados, ['e2']);
  assert.equal(respuestas[0].faltante, null);
  assert.deepEqual(respuestas[0].ninguno, [], 'una lista de estados vacía no devuelve todo');
});

_test('los estados y los pasos declarados son consistentes entre sí', () => {
  for (const [nombre, p] of Object.entries(PASOS)) {
    assert.ok(ESTADOS.includes(p.a), `el paso ${nombre} va a un estado que no existe`);
    for (const d of p.de) assert.ok(ESTADOS.includes(d), `el paso ${nombre} sale de un estado que no existe`);
    assert.ok(['pide', 'hace'].includes(p.quien), `el paso ${nombre} no dice quién manda`);
  }
  assert.deepEqual([...ABIERTOS, ...FINALES].sort(), [...ESTADOS].sort(), 'todo estado es abierto o final, sin huecos');
  // Todo estado abierto tiene un tope de tiempo, o un encargo podría quedarse atascado invisible.
  for (const s of ABIERTOS) assert.ok(TOPES_H[s] > 0, `el estado ${s} no tiene tope de tiempo: se atascaría sin que el tablero lo diga`);
});
