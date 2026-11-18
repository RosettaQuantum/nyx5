// node --test test/
// Fase 2 (la señal) y fase 3 (la vista unificada) de la orden del 16-nov.
//
// Las dos cosas que estas pruebas cuidan, en orden de lo que costaría equivocarse:
//
//  1. QUE UNA SEÑAL NO MUEVA NADA. Es toda su seguridad: entra al historial, y el estado y el
//     dinero quedan donde estaban. Si alguna vez una señal libera un escrow, eso tiene que ser
//     otra op con otro nombre.
//  2. QUE EL MAPEO NO PIERDA UN ESTADO. Los estados de contrato se leen de ACP, no se escriben a
//     mano: si mañana nace un décimo estado y nadie lo mapea, esto grita en vez de contestar
//     `submitted` por defecto — que es la forma silenciosa de que un contrato terminado aparezca
//     como recién pedido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACP, ACP_DESENLACE } from '../src/libro/contratos.js';
import { BLOQUEAN, SENALES, senalAbierta, validarSenal } from '../src/libro/senal.js';
import { ESTADOS, aplicarPaso, crearEncargo, senalDeEncargo, senalarEncargo } from '../src/libro/encargos.js';
import { A2A_DE_CONTRATO, ESTADOS_DE_CONTRATO, a2aDeContrato, vista } from '../src/libro/vista.js';

const PIDE = 'nicholas@nyx5.com';
const HACE = 'sigo-cto@nyx5.com';
const OTRO = 'rosetta@nyx5.com';
const enc = (extra = {}) => crearEncargo({ id: 'e1', from: PIDE, concept: 'la pieza', assignee: HACE, ...extra });
const trabajando = (extra) => aplicarPaso(enc(extra), 'tomar', { por: HACE });
const contrato = (state, extra = {}) => ({
  id: `c-${state}`, kind: 'escrow', state, concept: `trato ${state}`, amount: 400,
  buyer: PIDE, seller: HACE, created: '2026-11-18T00:00:00.000Z', updated: '2026-11-18T01:00:00.000Z',
  history: [], ...extra,
});

// ---------- fase 2: la señal ----------

test('el vocabulario de la señal son las cuatro de la orden, y nada más', () => {
  assert.deepEqual([...SENALES], ['input-required', 'auth-required', 'resumed', 'progress']);
  assert.deepEqual([...BLOQUEAN], ['input-required', 'auth-required']);
  for (const malo of ['bloqueado', 'waiting', '', null, 'INPUT-REQUIRED']) {
    assert.throws(() => validarSenal({ kind: malo }), (e) => e.code === 400, `kind inválido aceptado: ${malo}`);
  }
});

test('una señal NO cambia el estado de un encargo (salvo auth-required) ni toca el dinero', () => {
  const t = trabajando();
  for (const kind of ['input-required', 'progress']) {
    const s = senalarEncargo(t, { kind, reason: 'x', por: HACE });
    assert.equal(s.state, 'working', `${kind} movió el estado a ${s.state}`);
    assert.equal(s.rev, t.rev + 1, 'la señal sí avanza rev: es un cambio del documento');
  }
  // La única excepción, y es deliberada: en A2A `auth-required` ES un estado, no una nota.
  const a = senalarEncargo(t, { kind: 'auth-required', reason: 'falta que firme legal', por: PIDE });
  assert.equal(a.state, 'auth-required');
  // Y `resumed` lo devuelve a donde estaba, no a un valor fijo.
  assert.equal(senalarEncargo(a, { kind: 'resumed', por: PIDE }).state, 'working');
  // Ninguna señal introduce un campo de plata.
  for (const s of [senalarEncargo(t, { kind: 'progress', por: HACE }), a]) {
    for (const k of ['price', 'amount', 'escrow']) assert.ok(!(k in s), `la señal metió ${k}`);
  }
});

test('progress no abre ni cierra; resumed cierra; la abierta se deriva del historial', () => {
  let x = trabajando();
  assert.equal(senalDeEncargo(x), null, 'sin señales no hay ninguna abierta');
  x = senalarEncargo(x, { kind: 'input-required', reason: 'falta el dato del banco', por: HACE });
  assert.equal(senalDeEncargo(x).kind, 'input-required');
  assert.match(senalDeEncargo(x).reason, /banco/);
  x = senalarEncargo(x, { kind: 'progress', reason: 'voy en la mitad', por: HACE });
  assert.equal(senalDeEncargo(x).kind, 'input-required', 'progress no puede cerrar lo que bloquea');
  x = senalarEncargo(x, { kind: 'resumed', por: HACE });
  assert.equal(senalDeEncargo(x), null, 'resumed cierra la anterior');
  // Y no hay campo «señal actual»: se deriva. Borrar el log borra la señal, que es lo correcto.
  assert.ok(!('senal' in x) && !('signal' in x), 'la señal abierta no puede vivir en un campo: sería una segunda verdad');
});

test('una señal de un tercero se rechaza, y un encargo terminado no recibe señales', () => {
  const t = trabajando();
  assert.throws(() => senalarEncargo(t, { kind: 'progress', por: OTRO }), (e) => e.code === 403);
  assert.throws(() => senalarEncargo(t, { kind: 'progress' }), (e) => e.code === 403, 'sin remitente no se señala');
  const cerrado = aplicarPaso(t, 'cancelar', { por: PIDE });
  assert.throws(() => senalarEncargo(cerrado, { kind: 'input-required', por: PIDE }), (e) => e.code === 409);
});

test('senalAbierta lee las dos formas de historial: history de contrato y log de encargo', () => {
  const h = [{ at: '1', by: PIDE, op: 'deliver' }, { at: '2', by: PIDE, op: 'signal', kind: 'input-required', reason: 'r' }];
  assert.equal(senalAbierta(h).kind, 'input-required');
  const l = [{ at: '1', by: PIDE, paso: 'tomar' }, { at: '2', by: PIDE, paso: 'signal', kind: 'auth-required' }];
  assert.equal(senalAbierta(l).kind, 'auth-required');
  assert.equal(senalAbierta([]), null);
});

// ---------- fase 3: la vista unificada ----------

test('el mapeo cubre TODOS los estados de contrato, leídos de ACP y no escritos a mano', () => {
  // El guardia que importa: la lista sale de ACP. Un estado nuevo sin mapear grita acá en vez de
  // caer a `submitted`, que haría ver un trato terminado como recién pedido.
  for (const s of ESTADOS_DE_CONTRATO) {
    const a2a = a2aDeContrato(contrato(s));
    assert.ok(ESTADOS.includes(a2a), `${s} no mapea a un estado A2A válido: ${a2a}`);
    if (s !== 'accepted') assert.ok(a2a !== 'submitted' || s === 'accepted', `${s} cayó al defecto 'submitted': falta mapearlo`);
  }
  assert.equal(ESTADOS_DE_CONTRATO.length, 9, 'si cambió la cantidad de estados de contrato, hay que revisar el mapeo');
});

test('el mapeo es exactamente el que dicta la orden', () => {
  assert.equal(a2aDeContrato(contrato('accepted')), 'submitted');
  for (const s of ['held', 'posted', 'active']) assert.equal(a2aDeContrato(contrato(s)), 'working', s);
  for (const s of ['released', 'settled']) assert.equal(a2aDeContrato(contrato(s)), 'completed', s);
  assert.equal(a2aDeContrato(contrato('refunded')), 'canceled');
  assert.equal(a2aDeContrato(contrato('forfeited')), 'failed');
});

test('delivered depende del verificador, y eso no se puede clavar en la tabla', () => {
  // CON verificador sigue siendo trabajo: falta que una prueba determinista corra, y eso pasa sin
  // que nadie haga nada. SIN verificador espera a una persona.
  assert.equal(a2aDeContrato(contrato('delivered', { verifier: 'verifica@nyx5.com' })), 'working');
  assert.equal(a2aDeContrato(contrato('delivered')), 'input-required');
  // Y no puede estar en la tabla con un valor fijo, porque eso perdería la distinción en silencio.
  assert.ok(!('delivered' in A2A_DE_CONTRATO), 'delivered no puede tener un valor fijo en el mapeo');
});

test('refunded es canceled en A2A y sigue siendo "returned" en ACP', () => {
  const f = vista({ contratos: [contrato('refunded')] }).filas[0];
  assert.equal(f.state, 'canceled', 'el vocabulario común dice canceled');
  assert.equal(f.nativo, 'refunded', 'y el nativo no se pierde');
  assert.equal(f.acp.outcome, 'returned', 'el desenlace ACP se conserva');
  assert.equal(ACP_DESENLACE.refunded, 'returned');
  assert.equal(f.acp.phase, ACP.refunded);
});

test('la vista junta las dos cosas, filtra por quien pregunta y no inventa columnas', () => {
  const t = vista({
    contratos: [contrato('held'), contrato('released', { id: 'c-ajeno', buyer: OTRO, seller: OTRO })],
    encargos: [trabajando(), crearEncargo({ id: 'e-ajeno', from: OTRO, concept: 'de otro' })],
    para: PIDE,
  });
  assert.equal(t.por_tipo.contrato, 1, 'el contrato ajeno no se muestra');
  assert.equal(t.por_tipo.encargo, 1, 'el encargo ajeno tampoco');
  // Las dos filas tienen la MISMA forma: eso es lo que hace que un tablero las pueda pintar junto.
  const claves = t.filas.map((f) => ['id', 'tipo', 'state', 'nativo', 'titulo', 'de', 'quien', 'abierto', 'senal'].every((k) => k in f));
  assert.deepEqual(claves, [true, true], 'las filas no comparten forma');
  // Un contrato lleva monto y un encargo nunca.
  assert.equal(t.filas.find((f) => f.tipo === 'contrato').monto, 400);
  assert.equal(t.filas.find((f) => f.tipo === 'encargo').monto, null);
});

test('«te necesitan» cuenta lo que espera a una persona, de los dos tipos', () => {
  const entregadoSinVerificador = contrato('delivered');
  const entregadoConVerificador = contrato('delivered', { id: 'c-ver', verifier: 'verifica@nyx5.com' });
  const encSenalado = senalarEncargo(trabajando(), { kind: 'input-required', reason: 'falta un dato', por: HACE });
  const t = vista({ contratos: [entregadoSinVerificador, entregadoConVerificador], encargos: [encSenalado] });
  assert.equal(t.te_necesitan, 2, 'el contrato sin verificador y el encargo señalado');
  assert.equal(t.bloqueados, 1, 'sólo el encargo tiene señal abierta');
  assert.equal(t.por_estado['input-required'], 1);
  assert.equal(t.por_estado.working, 2, 'el entregado con verificador sigue siendo trabajo');
});

test('el orden pone arriba lo que espera a alguien, y lo cerrado al final', () => {
  const viejoSinSenal = contrato('held', { id: 'c-viejo', updated: '2026-11-01T00:00:00.000Z' });
  const nuevoConSenal = contrato('held', { id: 'c-senal', updated: '2026-11-18T00:00:00.000Z', history: [{ at: '2026-11-18T00:00:00.000Z', by: PIDE, op: 'signal', kind: 'input-required' }] });
  const cerrado = contrato('released', { id: 'c-cerrado', updated: '2026-10-01T00:00:00.000Z' });
  const t = vista({ contratos: [cerrado, viejoSinSenal, nuevoConSenal] });
  assert.deepEqual(t.filas.map((f) => f.id), ['c-senal', 'c-viejo', 'c-cerrado'],
    'lo que espera a alguien va arriba aunque sea lo más nuevo, y lo cerrado al final aunque sea lo más viejo');
  assert.equal(t.abiertos, 2);
});
