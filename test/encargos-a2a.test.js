// node --test test/
// El vocabulario A2A del encargo, y los tres campos que la orden pedía (project, reason, due).
//
// Por qué existe este archivo aparte: el encargo nació con CINCO estados míos
// (open/taken/delivered/done/cancelled) y la orden que Nicholas aprobó pide los OCHO de A2A. Lo
// cambié al releer la orden, no porque algo fallara — el spec acordado manda sobre mi vocabulario.
// Y el cambio dejó un defecto real que estas pruebas cierran: `progreso` sumaba `por.done +
// por.cancelled`, dos nombres que dejaron de existir, así que devolvía NaN sin que nada reventara.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABIERTOS, ESTADOS, FINALES, PASOS, PROYECTO_MAX, RAZON_MAX, TOPES_H,
  aplicarPaso, crearEncargo, progreso,
} from '../src/libro/encargos.js';

const PIDE = 'nicholas@nyx5.com';
const HACE = 'sigo-cto@nyx5.com';
const base = (extra = {}) => crearEncargo({ id: 'e1', from: PIDE, concept: 'probar el vocabulario', ...extra });
const hasta = (e, pasos) => pasos.reduce((x, [paso, por]) => aplicarPaso(x, paso, { por }), e);

test('los ocho estados son los de A2A, escritos uno por uno', () => {
  // Literal a propósito: si alguien "mejora" el vocabulario, esta prueba lo dice. El valor de
  // hablar A2A es que otro lo entienda sin traducir, y eso se pierde con un nombre propio.
  assert.deepEqual([...ESTADOS], [
    'submitted', 'working', 'input-required', 'auth-required',
    'completed', 'canceled', 'failed', 'rejected',
  ]);
  // `canceled` con UNA ele, como A2A. Dos eles es el error de dedo que rompe la interoperación.
  assert.ok(ESTADOS.includes('canceled') && !ESTADOS.includes('cancelled'), 'canceled va con una sola ele');
  assert.deepEqual([...ABIERTOS, ...FINALES].sort(), [...ESTADOS].sort(), 'todo estado es abierto o final, sin huecos');
  for (const s of ABIERTOS) assert.ok(TOPES_H[s] > 0, `${s} no tiene tope de tiempo: se atascaría invisible`);
  for (const s of FINALES) assert.ok(!TOPES_H[s], `${s} es final y no debería tener tope`);
});

test('una entrega que espera revisión es input-required, no un estado propio', () => {
  // Es la decisión menos obvia del mapeo y la que más se presta a inventar un sexto estado: una
  // entrega hecha NO está completa y NO sigue en trabajo — depende de una persona, y A2A ya tiene
  // esa palabra. Es el mismo criterio que la fase 3 aplica a un contrato sin verificador.
  const entregado = hasta(base(), [['tomar', HACE], ['entregar', HACE]]);
  assert.equal(entregado.state, 'input-required');
  assert.ok(entregado.delivered, 'y la entrega queda registrada, que es otra cosa que el estado');
  assert.equal(aplicarPaso(entregado, 'cerrar', { por: PIDE }).state, 'completed');
});

test('auth-required no lo alcanza ningún paso: lo pone una señal', () => {
  // Está en el vocabulario porque A2A lo tiene y porque la fase 2 lo usa, pero NINGÚN paso lleva
  // ahí. Si mañana alguien agrega un paso que lo alcance, esta prueba lo obliga a decidirlo.
  assert.ok(ESTADOS.includes('auth-required'));
  assert.ok(!Object.values(PASOS).some((p) => p.a === 'auth-required'), 'ningún paso puede llevar a auth-required');
  // Pero sí se sale de ahí: un encargo bloqueado por una autorización se puede cancelar.
  assert.ok(PASOS.cancelar.de.includes('auth-required'), 'un encargo en auth-required tiene que poder cancelarse');
});

test('failed lo dicta quien hace; rejected, quien pide', () => {
  const trabajando = hasta(base(), [['tomar', HACE]]);
  // `rendirse` existe para que `failed` sea alcanzable. Sin él, un encargo imposible sólo podía
  // acabar cancelado, y «retirado» no es lo mismo que «intentado y no se pudo».
  assert.equal(aplicarPaso(trabajando, 'rendirse', { por: HACE }).state, 'failed');
  assert.throws(() => aplicarPaso(trabajando, 'rendirse', { por: PIDE }), (e) => e.code === 403, 'el que pide no se rinde por el que hace');

  const entregado = aplicarPaso(trabajando, 'entregar', { por: HACE });
  assert.equal(aplicarPaso(entregado, 'rechazar', { por: PIDE }).state, 'rejected');
  assert.throws(() => aplicarPaso(entregado, 'rechazar', { por: HACE }), (e) => e.code === 403, 'el que hace no rechaza su propia entrega');
  // Y `devolver` sigue siendo distinto: vuelve al trabajo en vez de terminar.
  assert.equal(aplicarPaso(entregado, 'devolver', { por: PIDE }).state, 'working');
});

test('project, reason y due: validados, y project se hereda del padre', () => {
  const e = base({ project: 'consola', reason: 'lo pidió Nicholas el 18-nov', due: '2026-11-30' });
  assert.equal(e.project, 'consola');
  assert.match(e.reason, /Nicholas/);
  assert.equal(e.due, '2026-11-30T00:00:00.000Z', 'due se normaliza a ISO con zona');

  // Un plazo ilegible es un plazo que nadie puede vencer, y el tablero lo mostraría como si existiera.
  for (const malo of ['la semana que viene', '30/11/2026', '', 'ayer']) {
    assert.throws(() => base({ due: malo }), (x) => x.code === 400 && /ISO-8601/.test(x.message), `due inválido aceptado: ${malo}`);
  }
  assert.throws(() => base({ project: 'x'.repeat(PROYECTO_MAX + 1) }), (x) => x.code === 400);
  assert.throws(() => base({ reason: 'x'.repeat(RAZON_MAX + 1) }), (x) => x.code === 400);

  // El hijo hereda el proyecto: una subtarea pertenece a lo mismo que lo de arriba, y obligar a
  // repetirlo es invitar a que divergan.
  const hijo = crearEncargo({ id: 'h', from: PIDE, concept: 'la parte de abajo', parent: e });
  assert.equal(hijo.project, 'consola');
  // Pero se puede declarar distinto a propósito, y entonces manda lo declarado.
  assert.equal(crearEncargo({ id: 'h2', from: PIDE, concept: 'otra cosa', parent: e, project: 'otro' }).project, 'otro');
  // Sin padre y sin declarar, es null: nunca se inventa un proyecto.
  assert.equal(base().project, null);
});

test('progreso nunca devuelve NaN, y no cuenta nombrando estados a mano', () => {
  // EL DEFECTO REAL, medido el 18-nov al cambiar el vocabulario: `cerrados` se calculaba como
  // `por.done + por.cancelled`. Los dos nombres dejaron de existir, la suma dio NaN y `abiertos`
  // salió NaN sin que ninguna prueba gritara. Ahora se cuenta recorriendo FINALES.
  const uno = hasta(base(), [['tomar', HACE], ['entregar', HACE], ['cerrar', PIDE]]);
  const pr = progreso([uno, base(), base()]);
  for (const [k, v] of Object.entries(pr)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} salió ${v}`);
  }
  assert.equal(pr.total, 3);
  assert.equal(pr.completed, 1);
  assert.equal(pr.abiertos, 2);
  assert.equal(pr.completo, false);

  // Cada estado final cuenta como cerrado, los cuatro.
  const cuatro = [
    hasta(base(), [['tomar', HACE], ['entregar', HACE], ['cerrar', PIDE]]),
    aplicarPaso(base(), 'cancelar', { por: PIDE }),
    hasta(base(), [['tomar', HACE], ['rendirse', HACE]]),
    hasta(base(), [['tomar', HACE], ['entregar', HACE], ['rechazar', PIDE]]),
  ];
  const t = progreso(cuatro);
  assert.equal(t.abiertos, 0, 'los cuatro finales tienen que contar como cerrados');
  assert.equal(t.completo, true, 'con al menos uno completado y ninguno abierto, está completo');

  // Tres cancelados NO son un padre cumplido: `completo` exige al menos un `completed`.
  const ninguno = progreso([1, 2, 3].map(() => aplicarPaso(base(), 'cancelar', { por: PIDE })));
  assert.equal(ninguno.abiertos, 0);
  assert.equal(ninguno.completo, false, 'todo cancelado no es completo');
});

test('cada paso declarado es coherente con el vocabulario', () => {
  for (const [nombre, p] of Object.entries(PASOS)) {
    assert.ok(ESTADOS.includes(p.a), `el paso ${nombre} va a un estado que no existe: ${p.a}`);
    for (const d of p.de) assert.ok(ESTADOS.includes(d), `el paso ${nombre} sale de un estado que no existe: ${d}`);
    assert.ok(['pide', 'hace'].includes(p.quien), `el paso ${nombre} no dice quién manda`);
    assert.ok(!FINALES.includes(p.a) || !p.de.some((d) => FINALES.includes(d)), `el paso ${nombre} mueve un estado final`);
  }
  // Todo estado final tiene que ser alcanzable, o es decoración en el vocabulario.
  for (const f of FINALES) {
    assert.ok(Object.values(PASOS).some((p) => p.a === f), `${f} no lo alcanza ningún paso: es decoración`);
  }
});
