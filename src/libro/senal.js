// Nyx5/1 — La señal: decir «esto está esperando algo» sin mover el estado ni el dinero.
// Fase 2 de la orden del 16-nov.
//
// QUÉ PROBLEMA RESUELVE. Un contrato en `held` y un encargo en `working` se ven iguales en el
// tablero, y no lo son: uno puede estar avanzando y el otro llevar tres días esperando que una
// persona conteste un dato. El estado dice en qué punto del ciclo está el trabajo; la señal dice
// **qué lo tiene detenido ahora**. Son dos preguntas distintas y por eso no comparten campo.
//
// LA REGLA QUE LA HACE SEGURA, y es la razón de que esto no sea una op más del Libro: **una señal
// no cambia el estado base y no mueve un token.** Es una entrada en el historial y nada más. Si
// mañana alguien quiere que una señal libere un escrow, eso es otra op con otro nombre y otra
// discusión — la frontera es la misma de los encargos: el dinero se mueve sólo contra prueba.
//
// POR QUÉ ESTE ARCHIVO EXISTE, en vez de dos listas iguales. El vocabulario lo usan los contratos
// (`src/libro/contratos.js`) y los encargos (`src/libro/encargos.js`), y dos listas que tienen que
// decir lo mismo terminan diciendo cosas distintas: es la lección de la casa sobre un contrato en
// dos artefactos. Aquí vive una.

import { LibroError } from './errores.js';

/** Las cuatro de la orden, y ninguna más. Un `kind` libre convierte el historial en basura. */
export const SENALES = Object.freeze(['input-required', 'auth-required', 'resumed', 'progress']);

/**
 * Las que DETIENEN. `resumed` las cierra y `progress` no abre ni cierra nada: es una nota de
 * avance, que es justo lo que alguien quiere mandar sin declararse bloqueado.
 */
export const BLOQUEAN = Object.freeze(['input-required', 'auth-required']);

export const RAZON_MAX = 500;

export function validarSenal({ kind, reason } = {}) {
  if (!SENALES.includes(kind)) throw new LibroError(400, `kind must be one of: ${SENALES.join(', ')}`);
  if (reason != null) {
    if (typeof reason !== 'string') throw new LibroError(400, 'reason must be a string');
    const r = reason.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (r.length > RAZON_MAX) throw new LibroError(400, `reason is longer than ${RAZON_MAX} characters`);
    return { kind, reason: r || null };
  }
  return { kind, reason: null };
}

/**
 * La señal abierta se DERIVA del historial, no se guarda en un campo. Un campo «señal actual»
 * sería una segunda verdad que mantener al lado del historial que ya la contiene, y las dos se
 * desincronizan el día que alguien escribe una y olvida la otra.
 *
 * Se recorre de atrás hacia adelante y manda la primera que decide:
 *   · una que bloquea  -> esa está abierta;
 *   · `resumed`        -> no hay ninguna abierta (cerró lo que hubiera);
 *   · `progress`       -> se salta, no decide nada.
 *
 * `entradas` es el historial: `history` en un contrato, `log` en un encargo. Las dos formas traen
 * `{ at, by }`; la señal agrega `kind` y `reason`.
 */
export function senalAbierta(entradas = [], marca = 'signal') {
  for (let i = entradas.length - 1; i >= 0; i--) {
    const h = entradas[i];
    if (!h || (h.op !== marca && h.paso !== marca)) continue;
    if (h.kind === 'resumed') return null;
    if (BLOQUEAN.includes(h.kind)) return { kind: h.kind, reason: h.reason || null, at: h.at, by: h.by };
    // `progress` no decide: sigue mirando hacia atrás.
  }
  return null;
}

/** Todas las señales de un historial, en orden. Para el detalle de una fila del tablero. */
export function senalesDe(entradas = [], marca = 'signal') {
  return entradas.filter((h) => h && (h.op === marca || h.paso === marca))
    .map((h) => ({ kind: h.kind, reason: h.reason || null, at: h.at, by: h.by }));
}
