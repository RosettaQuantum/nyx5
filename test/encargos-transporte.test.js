// node --test test/
// Los encargos por la puerta de verdad: un sobre FIRMADO a encargos@, y el tablero como lectura
// firmada. Lo que se prueba aquí es lo que una prueba de unidad sobre el módulo no puede ver:
//   - que el id del encargo sea el del sobre, así reentregar no crea dos (invariante 4);
//   - que la autoridad salga de la FIRMA y no del cuerpo (nadie se nombra dueño escribiéndolo);
//   - que el tablero no se pueda leer sin firma, y que muestre sólo de lo que uno es parte;
//   - que `owner` haga visible el árbol entero a quien lo empezó, que es la suma que pide un PM;
//   - que una casa SIN catálogo de trabajo pagado tenga encargos@ igual (es lo que forzó que los
//     encargos tengan dirección propia en vez de colgarse de tareas@).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { MEDIA_ENCARGO } from '../src/libro/encargos.js';
import { signObject } from '../src/nucleo/crypto.js';

const P = 4186;
const hosts = { 'e.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa, jefe, obrero, tercero;

// OJO con la firma de `join`: los parámetros son `{ house, name, hosts }` y **`house` vale
// `nyx5.com` por defecto**. La primera versión de este archivo pasaba `{ estafeta, local, dir }`,
// que `join` ignora entero, así que la prueba se unió a la CASA DE PRODUCCIÓN y registró ahí un
// agente de nombre sugerido en cada corrida. Una prueba que apunta al terreno equivocado no es un
// detalle de estilo: escribe de verdad donde no debe.
const unir = async (local) => (await join({ house: 'e.test', name: local, hosts }))._agente;

// `send` devuelve el TRABAJO EN COLA, no el resultado de la entrega: Nyx5 es store-and-forward.
// Por eso cada envío se fuerza con un tick, y un rechazo NO vuelve como valor de retorno sino
// como rebote del postmaster al buzón del remitente. Asertar sobre lo que devuelve `send` era
// mirar el acuse del cartero y creer que era la respuesta del destinatario.
const entregar = async (promesa) => { const r = await promesa; await casa.tick(); return r; };
const rebote = async (agente, idDelSobre) => {
  for (const m of await casa.store.listMailHistory(agente.local, { limit: 50 })) {
    const b = m.envelope?.content?.body;
    const cuerpo = typeof b === 'string' ? b : JSON.stringify(b || '');
    if (String(m.envelope?.from).startsWith('postmaster@') && cuerpo.includes(idDelSobre)) return cuerpo;
  }
  return null;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-enc-t-'));
  casa = new Estafeta({
    domain: 'e.test', port: P, dataDir: path.join(tmp, 'e.test'), adminToken: 't', hosts,
    workerIntervalMs: 50, policy: { registration: 'open', registrations_per_minute: 200 },
    // A PROPÓSITO sin `tareas`: esta casa no paga nada y los encargos tienen que funcionar igual.
    log: () => {},
  });
  await casa.start();
  jefe = await unir('jefe');
  obrero = await unir('obrero');
  tercero = await unir('tercero');
});
after(async () => { await casa.stop(); });

test('una casa sin catálogo de trabajo pagado tiene encargos@ y NO tiene tareas@', async () => {
  assert.equal(await casa.store.getAgent('tareas'), null, 'sin catálogo no se levanta el mostrador pagado');
  const rec = await casa.store.getAgent('encargos');
  assert.ok(rec, 'encargos@ existe en toda casa');
  assert.deepEqual(rec.capabilities.accepts, [MEDIA_ENCARGO]);
  assert.equal(rec.capabilities.listed, false, 'un mostrador interno no se anuncia en el directorio');
  assert.ok(Estafeta.RESERVED.has('encargos'), 'el nombre tiene que estar reservado o alguien lo registra');
});

test('un sobre firmado crea el encargo, y el id del encargo es el del sobre', async () => {
  const r = await entregar(jefe.encargar('e.test', { concept: 'revisar el candado del escrow', assignee: 'obrero@e.test' }));
  const t = await jefe.tablero('e.test');
  const fila = t.filas.find((f) => f.id === r.envelope.id);
  assert.ok(fila, `el encargo tiene que llamarse como el sobre (${r.envelope.id})`);
  assert.equal(fila.state, 'open');
  assert.equal(fila.assignee, 'obrero@e.test');
  assert.equal(fila.from, 'jefe@e.test');
});

test('reentregar el mismo sobre no crea un segundo encargo', async () => {
  const r = await entregar(jefe.encargar('e.test', { concept: 'el mismo sobre dos veces' }));
  const sobre = (await casa.store.listOutbox('jefe')).find((o) => o.envelope?.id === r.envelope.id)?.envelope;
  const antes = (await casa.store.encargoList()).length;
  // Se vuelve a meter EL MISMO sobre firmado por la puerta de entrada, como haría un reintento.
  const dup = await casa.inbound(sobre || r.envelope);
  assert.equal(dup.ok, true, `la reentrega tiene que ser aceptada: ${dup.reason || ''}`);
  assert.equal((await casa.store.encargoList()).length, antes, 'la reentrega no crea otro encargo');
});

test('la autoridad sale de la firma: un tercero no mueve el encargo de otro', async () => {
  const r = await entregar(jefe.encargar('e.test', { concept: 'sólo para el obrero', assignee: 'obrero@e.test' }));
  const id = r.envelope.id;
  // El tercero intenta tomarlo. Que el cuerpo diga lo que quiera es indiferente: `env.from` ya
  // pasó la cadena dominio -> agente -> firma, y el paso se compara contra ESO.
  const malo = await entregar(tercero.encargoPaso('e.test', 'tomar', id));
  assert.equal((await casa.store.encargoGet(id)).state, 'open', 'el encargo no se movió');
  assert.match(await rebote(tercero, malo.envelope.id) || '', /belongs to obrero@e\.test/, 'y el tercero recibe el rechazo por rebote, con la razón');
  // Y el dueño sí puede.
  await entregar(obrero.encargoPaso('e.test', 'tomar', id));
  assert.equal((await casa.store.encargoGet(id)).state, 'taken');
  // El que hace no se cierra su propio encargo: eso lo decide quien lo pidió.
  await entregar(obrero.encargoPaso('e.test', 'entregar', id, { note: 'listo' }));
  await entregar(obrero.encargoPaso('e.test', 'cerrar', id));
  assert.equal((await casa.store.encargoGet(id)).state, 'delivered', 'el obrero no puede cerrar');
  await entregar(jefe.encargoPaso('e.test', 'cerrar', id));
  assert.equal((await casa.store.encargoGet(id)).state, 'done');
});

test('el tablero exige firma y muestra sólo de lo que uno es parte', async () => {
  const r = await entregar(jefe.encargar('e.test', { concept: 'privado del jefe y el obrero', assignee: 'obrero@e.test' }));
  // Sin firma: 401, igual que el buzón y el Libro.
  const sin = await fetch(`http://127.0.0.1:${P}/encargos`);
  assert.equal(sin.status, 401, 'el tablero no se lee sin firma');

  const deJefe = await jefe.tablero('e.test');
  const deObrero = await obrero.tablero('e.test');
  const deTercero = await tercero.tablero('e.test');
  assert.ok(deJefe.filas.some((f) => f.id === r.envelope.id), 'quien lo pidió lo ve');
  assert.ok(deObrero.filas.some((f) => f.id === r.envelope.id), 'quien lo hace lo ve');
  assert.ok(!deTercero.filas.some((f) => f.id === r.envelope.id), 'un cuarto que pasa por aquí no ve nada');
  assert.equal(deJefe.address, 'jefe@e.test');
});

test('owner hace visible el árbol entero a quien lo empezó, aunque la rama sea de otros', async () => {
  const raiz = await entregar(jefe.encargar('e.test', { concept: 'la pieza grande', assignee: 'obrero@e.test' }));
  await entregar(obrero.encargoPaso('e.test', 'tomar', raiz.envelope.id));
  // El obrero cuelga una subtarea y se la pide al tercero. El jefe no es parte de ESE encargo.
  const hijo = await entregar(obrero.encargar('e.test', { concept: 'la parte del tercero', assignee: 'tercero@e.test', parent: raiz.envelope.id }));
  const guardado = await casa.store.encargoGet(hijo.envelope.id);
  assert.ok(guardado, `el hijo tenía que crearse: ${JSON.stringify(hijo.rejected || hijo)}`);
  assert.equal(guardado.parent_id, raiz.envelope.id);
  assert.equal(guardado.from, 'obrero@e.test');
  assert.equal(guardado.owner, 'jefe@e.test', 'el dueño del árbol es quien lo empezó, heredado al nacer');

  const t = await jefe.tablero('e.test');
  assert.ok(t.filas.some((f) => f.id === hijo.envelope.id), 'el jefe ve la rama que no pidió él');
  const fila = t.filas.find((f) => f.id === raiz.envelope.id);
  assert.equal(fila.progreso.total, 1, 'y la raíz reporta el progreso de sus hijos');
  assert.equal(fila.progreso.abiertos, 1);
  assert.equal(fila.progreso.completo, false);
});

test('un tercero no cuelga trabajo del árbol de otro', async () => {
  const raiz = await entregar(jefe.encargar('e.test', { concept: 'árbol ajeno' }));
  assert.ok(await casa.store.encargoGet(raiz.envelope.id), 'la raíz sí tiene que existir, o esta prueba pasa por la razón equivocada');
  const malo = await entregar(tercero.encargar('e.test', { concept: 'me cuelgo aquí', parent: raiz.envelope.id }));
  assert.equal(await casa.store.encargoGet(malo.envelope.id), null, 'el hijo del tercero no debió crearse');
  assert.match(await rebote(tercero, malo.envelope.id) || '', /not yours to hang work from/);
});

test('un padre que no existe se rechaza, no se convierte en un encargo de raíz', async () => {
  // El defecto que esto cierra: sin el 404, `crearEncargo` recibía `parent: null` y el encargo
  // nacía igual, suelto, sin que nadie se enterara de que la rama que pidió no existe. Un hijo
  // huérfano que parece trabajo de primer nivel es exactamente la clase de número que miente.
  const r = await entregar(jefe.encargar('e.test', { concept: 'cuelgo de un fantasma', parent: 'no-existe-este-id' }));
  assert.equal(await casa.store.encargoGet(r.envelope.id), null, 'no se guarda nada');
  assert.match(await rebote(jefe, r.envelope.id) || '', /no encargo with id no-existe-este-id/);
});

test('un id ajeno no entrega el encargo de otro: el id del sobre lo elige quien envía', async () => {
  const r = await entregar(jefe.encargar('e.test', { concept: 'secreto del jefe y el obrero', detail: 'el detalle que no debe salir', assignee: 'obrero@e.test' }));
  const victima = await casa.store.encargoGet(r.envelope.id);
  assert.ok(victima, 'la víctima tiene que existir o esta prueba pasa por la razón equivocada');
  // El tercero arma un sobre FIRMADO POR ÉL con el id del encargo ajeno. Es la única forma de
  // llegar aquí: `send` genera su propio id, así que se construye a mano, como haría un atacante.
  const sobre = signObject({
    nyx5: '1', id: victima.id, from: tercero.address, to: [`encargos@e.test`], created: new Date().toISOString(),
    expires: null, thread: null, in_reply_to: null, type: 'task',
    content: { media: MEDIA_ENCARGO, body: { op: 'crear', concept: 'a ver qué me devuelves' } },
  }, tercero.keys);
  // Capa 1, por la puerta: `seen` ya ataja un id repetido antes de llegar al mostrador.
  const porLaPuerta = JSON.stringify(await casa.inbound(sobre));
  assert.ok(!porLaPuerta.includes('el detalle que no debe salir'), `inbound no puede devolver contenido ajeno: ${porLaPuerta.slice(0, 200)}`);

  // Capa 2, el guardia mismo. Se GOLPEA EL MÉTODO porque por `inbound` esta línea es inalcanzable
  // —`seen` responde primero— y un guardia que ninguna prueba alcanza es un guardia sin probar:
  // al quitarlo, la prueba de arriba seguía verde. Esta es la que grita.
  const directo = await casa._encargo(sobre);
  const texto = JSON.stringify(directo);
  assert.equal(directo.ok, false, `el mostrador tiene que rechazarlo: ${texto.slice(0, 200)}`);
  assert.equal(directo.code, 409);
  assert.ok(!texto.includes('el detalle que no debe salir'), 'y sin filtrar el detalle ajeno');
  assert.ok(!texto.includes('secreto del jefe'), 'ni el concepto');
  // Y el encargo de la víctima queda intacto.
  assert.equal((await casa.store.encargoGet(victima.id)).concept, victima.concept);

  // Quien SÍ es parte recupera el suyo ante el mismo id: es la reentrega legítima, que no se rompe.
  const propio = signObject({ ...sobre, from: jefe.address, content: { media: MEDIA_ENCARGO, body: { op: 'crear', concept: 'reentrega' } } }, jefe.keys);
  const mio = await casa._encargo(propio);
  assert.equal(mio.ok, true);
  assert.equal(mio.result.duplicate, true);
  assert.equal(mio.result.encargo.concept, victima.concept, 'una parte sí recupera el suyo');
});

test('un encargo con precio se rechaza en la puerta, no se guarda sin precio', async () => {
  const r = await entregar(jefe.encargoOp('e.test', { op: 'crear', concept: 'pagarme 500', price: 500 }));
  assert.equal(await casa.store.encargoGet(r.envelope.id), null, 'no se guarda');
  assert.match(await rebote(jefe, r.envelope.id) || '', /carries no price/, 'y el remitente se entera de por qué, en vez de creer que cobra');
});

test('ni un encargo ni su ciclo completo mueven el Libro de la casa', async () => {
  const antes = await casa.store.libroState();
  const r = await entregar(jefe.encargar('e.test', { concept: 'nada de esto cuesta', assignee: 'obrero@e.test' }));
  for (const [paso, quien] of [['tomar', obrero], ['entregar', obrero], ['cerrar', jefe]]) {
    await entregar(quien.encargoPaso('e.test', paso, r.envelope.id));
  }
  assert.equal((await casa.store.encargoGet(r.envelope.id)).state, 'done');
  // El terreno: se le pregunta al Libro, no al encargo.
  assert.equal((await casa.store.libroState()).seq, antes.seq, 'el número de asiento no se movió');
  const contratos = await casa.store.libroListContracts();
  assert.ok(!contratos.some((c) => c.id === r.envelope.id || c.terms?.encargo), 'ningún contrato nació de un encargo');
});
