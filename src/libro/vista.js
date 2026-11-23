// Nyx5/1 — La vista unificada: TODO el trabajo en una lista, hable de dinero o no.
// Fase 3 de la orden del 16-nov.
//
// EL PROBLEMA. Un contrato y un encargo son cosas distintas —uno mueve tokens y el otro no— pero
// la pregunta de quien mira el tablero es la misma: *¿qué hay abierto, de quién depende, y qué
// está esperando algo?* Hasta aquí había que mirar dos listas con dos vocabularios y cruzarlas a
// ojo, que es exactamente el trabajo que un tablero existe para no hacer.
//
// LO QUE ESTO NO HACE, y es deliberado:
//   · No crea ninguna tabla ni ningún estado nuevo para los contratos. Lee lo que hay y lo
//     traduce. La orden lo pide así y la razón es dura: un estado de contrato duplicado en otra
//     tabla es una segunda verdad sobre dinero.
//   · No decide nada. Es una LECTURA. No mueve un token, no cambia un estado y no cierra un padre
//     porque sus hijos cerraron.
//   · No oculta el vocabulario de origen: cada fila lleva su `state` nativo y, si es contrato, su
//     `acp`. Traducir y además borrar el original es pedirle a quien audita que confíe.

import { ACP, estadoACP } from './contratos.js';
import { ABIERTOS, FINALES, atascado, progreso, senalDeEncargo, visibleParaAlguna } from './encargos.js';
import { senalAbierta } from './senal.js';

/**
 * El mapeo del spec v0.2, estado de contrato -> estado A2A. Escrito como la orden lo dicta, con
 * `delivered` aparte porque es el único que depende de algo más que el nombre.
 *
 *   accepted                  -> submitted
 *   held, posted, active      -> working
 *   delivered                 -> working si el contrato declara verificador
 *                                input-required si depende de una persona
 *   released, settled         -> completed
 *   refunded                  -> canceled   (y el desenlace ACP sigue siendo "returned")
 *   forfeited                 -> failed
 */
export const A2A_DE_CONTRATO = Object.freeze({
  accepted: 'submitted',
  held: 'working',
  posted: 'working',
  active: 'working',
  released: 'completed',
  settled: 'completed',
  refunded: 'canceled',
  forfeited: 'failed',
  // `delivered` NO va aquí a propósito: lo resuelve `a2aDeContrato`, porque su respuesta depende
  // de si hay verificador. Ponerlo con un valor fijo aquí sería la forma silenciosa de perder esa
  // distinción, y hay una prueba que exige que este objeto no lo declare.
});

/**
 * Por qué `delivered` es el caso interesante: una entrega con verificador declarado sigue siendo
 * TRABAJO —falta que una prueba determinista corra, y eso ocurre sin que nadie haga nada— mientras
 * una entrega sin verificador está esperando que **una persona** la revise, y eso es
 * `input-required`. Es la misma distinción que define el estado de un encargo entregado.
 */
export function a2aDeContrato(c) {
  if (!c || !c.state) return 'submitted';
  if (c.state === 'delivered') return c.verifier ? 'working' : 'input-required';
  return A2A_DE_CONTRATO[c.state] || 'submitted';
}

/** Las partes de un contrato, para saber si una fila es de quien pregunta. */
const partesDe = (c) => [c.seller, c.buyer, c.verifier, c.arbiter].filter(Boolean);

/** Una fila del tablero, con la misma forma venga de donde venga. */
export function filaDeContrato(c, ahora = Date.now()) {
  const a2a = a2aDeContrato(c);
  return {
    id: c.id,
    tipo: 'contrato',
    // El vocabulario común, y debajo el propio: traducir sin dejar el original es pedir confianza.
    state: a2a,
    nativo: c.state,
    acp: estadoACP(c),
    titulo: c.concept || '(sin concepto)',
    // `de` es quien encarga y `quien` el que hace, igual que en un encargo: en un contrato el
    // comprador pide y el vendedor hace.
    de: c.buyer || null,
    quien: c.seller || null,
    partes: partesDe(c),
    abierto: ABIERTOS.includes(a2a),
    actualizado: c.updated || c.created || null,
    senal: senalAbierta(c.history || []),
    // Lo único que un contrato tiene y un encargo no, y no se esconde: hay dinero en juego.
    monto: typeof c.amount === 'number' ? c.amount : null,
    verificador: c.verifier || null,
    progreso: null,
  };
}

export function filaDeEncargo(e, hijos = [], ahora = Date.now()) {
  return {
    id: e.id,
    tipo: 'encargo',
    state: e.state,
    nativo: e.state,
    acp: null,
    titulo: e.concept || '(sin concepto)',
    de: e.from || null,
    quien: e.assignee || null,
    partes: [e.from, e.assignee, e.owner].filter(Boolean),
    abierto: ABIERTOS.includes(e.state),
    actualizado: e.updated || e.created || null,
    senal: senalDeEncargo(e),
    monto: null,
    verificador: null,
    project: e.project || null,
    due: e.due || null,
    parent_id: e.parent_id || null,
    atascado: atascado(e, ahora),
    progreso: hijos.length ? progreso(hijos) : null,
  };
}

/**
 * La vista: contratos y encargos en una sola lista, filtrada por quien pregunta.
 *
 * `para` es la dirección que lee. Una fila se muestra si es parte de ella — en un encargo eso
 * incluye al dueño del árbol, que es lo que deja a quien empezó algo ver las ramas que no pidió
 * él. Sin `para`, no se filtra (es la lectura de la casa).
 *
 * `voces` son todas las direcciones por las que responde quien lee: ella y sus delegados. Se usa
 * SOLO para los encargos, a propósito. Un contrato mueve dinero y quién puede leerlo es otra
 * decisión, con sus propias superficies; en la práctica no se pierde nada, porque el delegado que
 * motivó esto es de sólo mensajes y no puede tener contratos. Si algún día un delegado con plata
 * tiene que verse aquí, que sea una decisión escrita, no el arrastre de este arreglo.
 */
export function vista({ contratos = [], encargos = [], para = null, voces = null, ahora = Date.now() } = {}) {
  const quienes = voces?.length ? voces : (para ? [para] : []);
  const hijosDe = new Map();
  for (const e of encargos) if (e.parent_id) hijosDe.set(e.parent_id, [...(hijosDe.get(e.parent_id) || []), e]);

  const filas = [
    ...contratos.filter((c) => !para || partesDe(c).includes(para)).map((c) => filaDeContrato(c, ahora)),
    ...encargos.filter((e) => !para || visibleParaAlguna(e, quienes)).map((e) => filaDeEncargo(e, hijosDe.get(e.id) || [], ahora)),
  ];

  // El orden es el del tablero y dice en qué mirar primero: lo que ESPERA A ALGUIEN arriba (una
  // señal abierta o un atasco), y dentro de cada grupo lo más viejo primero. Lo cerrado al final.
  const peso = (f) => (!f.abierto ? 3 : f.senal || f.atascado ? 0 : 1);
  filas.sort((a, b) => peso(a) - peso(b) || String(a.actualizado).localeCompare(String(b.actualizado)));

  const abiertas = filas.filter((f) => f.abierto);
  return {
    total: filas.length,
    abiertos: abiertas.length,
    // «Te necesitan»: lo que espera a una persona. Es la vista que la orden pide para el panel, y
    // se calcula aquí y no en la superficie, para que dos superficies no la calculen distinto.
    te_necesitan: abiertas.filter((f) => f.state === 'input-required' || f.senal?.kind === 'input-required').length,
    bloqueados: abiertas.filter((f) => f.senal).length,
    atascados: abiertas.filter((f) => f.atascado).length,
    por_estado: Object.fromEntries([...ABIERTOS, ...FINALES].map((s) => [s, filas.filter((f) => f.state === s).length])),
    por_tipo: { contrato: filas.filter((f) => f.tipo === 'contrato').length, encargo: filas.filter((f) => f.tipo === 'encargo').length },
    filas,
  };
}

/** Los estados de contrato que el mapeo tiene que cubrir, leídos de ACP y no escritos a mano. */
export const ESTADOS_DE_CONTRATO = Object.freeze(Object.keys(ACP));
