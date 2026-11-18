// Nyx5/1 — Encargos: el trabajo interno de una casa, con dueño y estado, y SIN dinero.
//
// Qué resuelve. Hasta hoy una tarea no tenía dónde vivir: el catálogo de `tareas@` es
// configuración, y una tarea tomada quedaba como un escrow común en `nyx5_libro_contratos`,
// reconocible sólo por `terms.seed_task`. Así, nadie podía preguntar «qué le pedí a quién y en
// qué va» sin leer dinero. Un encargo es exactamente esa pregunta: quién lo pidió, quién lo
// tiene, en qué estado está, y de qué encargo mayor cuelga.
//
// La frontera que no se cruza, y es la razón de que este archivo no llame al Libro ni una vez:
// **la plata se mueve sólo contra prueba determinista.** Un encargo puede declarar un criterio
// (`verify`, la misma forma que lee `verifica@`) y puede quedar marcado como incompleto, pero
// cumplirlo NO paga nada y no toca reputación. El juicio sirve para reportar; el dinero, nunca.
// Por eso un encargo tampoco lleva precio: `SIN_PLATA` lo rechaza al nacer, cerrado.
//
// Y los ciclos no se comprueban, se vuelven imposibles: el padre tiene que existir cuando nace
// el hijo y `parent_id` no se puede cambiar después. Un bosque por construcción. El tope de
// profundidad es lo único que hace falta, y existe para que el tablero no tenga que recorrer una
// cadena sin fondo.

import { LibroError } from './errores.js';

const iso = (t = Date.now()) => new Date(t).toISOString();

export const ESTADOS = Object.freeze(['open', 'taken', 'delivered', 'done', 'cancelled']);
// Lo que el tablero mira: un encargo cerrado no vuelve a aparecer salvo que se pida.
export const ABIERTOS = Object.freeze(['open', 'taken', 'delivered']);
export const FINALES = Object.freeze(['done', 'cancelled']);
export const PROFUNDIDAD_MAX = 3;
export const CONCEPTO_MAX = 200;
export const DETALLE_MAX = 4000;

// Los campos que convertirían un encargo en un contrato por la puerta de atrás. La lista es
// CORTA a propósito: precisión sobre cobertura, porque un falso positivo retiene trabajo bueno.
// Son nombres de campo, no palabras del texto: un encargo que dice «subir el precio» pasa.
export const SIN_PLATA = Object.freeze(['price', 'amount', 'currency', 'escrow', 'bond', 'fee', 'tokens', 'arbiter']);

// Quién puede hacer cada paso, y desde dónde. `pide` = quien encargó; `hace` = el asignado.
export const PASOS = Object.freeze({
  tomar:    { de: ['open'],                          a: 'taken',     quien: 'hace' },
  entregar: { de: ['taken'],                          a: 'delivered', quien: 'hace' },
  cerrar:   { de: ['delivered'],                      a: 'done',      quien: 'pide' },
  devolver: { de: ['delivered'],                      a: 'taken',     quien: 'pide' },
  cancelar: { de: ['open', 'taken', 'delivered'],     a: 'cancelled', quien: 'pide' },
});

const texto = (v, max, campo) => {
  if (typeof v !== 'string' || !v.trim()) throw new LibroError(400, `${campo} tiene que ser un texto no vacío`);
  const t = v.trim();
  if (t.length > max) throw new LibroError(400, `${campo} supera ${max} caracteres`);
  return t;
};

/**
 * Nace un encargo. `padre` es el encargo del que cuelga, ya leído de la bodega (no su id): así
 * la comprobación de que existe no se puede saltar por olvido de quien llama.
 */
export function crearEncargo(pedido, ahora = Date.now()) {
  // El guardia mira lo que LLEGA, no lo que se construye. Medido al escribir la prueba: como
  // este constructor arma un objeto nuevo campo por campo, un `price` de entrada se caía solo y
  // el encargo nacía sin precio y SIN ERROR. Quien lo pidió habría quedado creyendo que cobra.
  sinPlata(pedido);
  const { id, from, assignee = null, concept, detail = null, verify = null, parent = null } = pedido || {};
  if (!id) throw new LibroError(400, 'un encargo necesita id');
  if (!from) throw new LibroError(400, 'un encargo necesita saber quién lo pide');
  const e = {
    nyx5: '1', kind: 'encargo', id: String(id),
    from: String(from),
    assignee: assignee ? String(assignee) : null,
    parent_id: parent ? String(parent.id) : null,
    depth: parent ? Number(parent.depth || 0) + 1 : 0,
    concept: texto(concept, CONCEPTO_MAX, 'concept'),
    detail: detail == null ? null : texto(detail, DETALLE_MAX, 'detail'),
    verify: normalizarVerify(verify),
    state: 'open',
    // `rev` es el candado del paso, no decoración: la bodega sólo acepta un cambio si el `rev`
    // que trae es el que tiene guardado. Se cuenta en vez de comparar `updated` porque dos pasos
    // dentro del mismo milisegundo traen el MISMO ISO y la comparación los dejaría pasar los dos.
    rev: 0,
    created: iso(ahora), updated: iso(ahora),
    delivered: null, closed: null,
    log: [{ at: iso(ahora), by: String(from), paso: 'crear', state: 'open' }],
  };
  if (e.depth > PROFUNDIDAD_MAX) throw new LibroError(409, `un encargo no cuelga más de ${PROFUNDIDAD_MAX} niveles`);
  // Un padre cerrado no recibe hijos nuevos: el progreso que ya se reportó dejaría de ser cierto.
  if (parent && FINALES.includes(parent.state)) throw new LibroError(409, `el encargo padre ${parent.id} ya está ${parent.state}`);
  return sinPlata(e);
}

// El criterio determinista, si lo hay, en la misma forma que lee `verifica@`. Cumplirlo NO paga.
export function normalizarVerify(v) {
  if (v == null) return null;
  const lista = Array.isArray(v) ? v : [v];
  if (!lista.length) return null;
  for (const c of lista) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new LibroError(400, 'cada verify es un objeto { type, ... }');
    if (typeof c.type !== 'string' || !c.type) throw new LibroError(400, 'cada verify necesita type');
  }
  return lista;
}

/**
 * El guardia que mantiene el dinero afuera. Falla CERRADO: si aparece un campo de plata, el
 * encargo no nace y no se guarda. Mira el nivel de arriba y `terms`, que es donde un contrato
 * los lleva.
 */
export function sinPlata(e) {
  for (const sitio of [e, e.terms]) {
    if (!sitio || typeof sitio !== 'object') continue;
    for (const k of SIN_PLATA) {
      if (Object.hasOwn(sitio, k)) throw new LibroError(400, `un encargo no lleva ${k}: el trabajo interno no mueve plata (si hay que pagar, es una cotización a libro@)`);
    }
  }
  return e;
}

/**
 * Aplica un paso. Devuelve el encargo NUEVO (no muta el que entró) o lanza LibroError.
 * `por` es quien firma el sobre: la autoridad no se pregunta, se compara.
 */
export function aplicarPaso(encargo, paso, opciones = {}, ahora = Date.now()) {
  // Misma razón que en `crearEncargo`: el paso tampoco es una puerta para meter plata.
  sinPlata(opciones);
  const { por, note = null, evidence_sha256 = null, url = null, verdict = null } = opciones;
  const p = PASOS[paso];
  if (!p) throw new LibroError(400, `paso desconocido: ${paso}. Los que hay: ${Object.keys(PASOS).join(', ')}`);
  if (!por) throw new LibroError(403, 'un paso necesita saber quién lo da');
  if (!p.de.includes(encargo.state)) throw new LibroError(409, `no se puede ${paso} un encargo que está ${encargo.state} (sólo desde ${p.de.join(' o ')})`);

  // Quién manda. `tomar` sin asignado lo puede dar cualquiera —así se publica trabajo abierto—,
  // pero con asignado puesto sólo lo toma él: un encargo con dueño no se lo queda un tercero.
  if (p.quien === 'pide' && por !== encargo.from) throw new LibroError(403, `sólo ${encargo.from}, que lo encargó, puede ${paso}`);
  if (p.quien === 'hace') {
    if (encargo.assignee && por !== encargo.assignee) throw new LibroError(403, `este encargo es de ${encargo.assignee}`);
    if (!encargo.assignee && paso !== 'tomar') throw new LibroError(409, 'este encargo no tiene dueño todavía: alguien tiene que tomarlo primero');
  }

  const e = { ...encargo, rev: Number(encargo.rev || 0) + 1, updated: iso(ahora), state: p.a, log: [...(encargo.log || []), { at: iso(ahora), by: String(por), paso, state: p.a, ...(note ? { note: texto(note, DETALLE_MAX, 'note') } : {}) }] };
  if (paso === 'tomar') e.assignee = String(por);
  if (paso === 'entregar') e.delivered = { at: iso(ahora), by: String(por), note: note ? texto(note, DETALLE_MAX, 'note') : null, evidence_sha256: evidence_sha256 || null, url: url || null };
  // Devolver borra la entrega: si quedara, el tablero contaría como entregado algo que volvió
  // a estar en curso, que es exactamente la clase de número maquillado que no se reporta.
  if (paso === 'devolver') e.delivered = null;
  if (paso === 'cerrar' || paso === 'cancelar') e.closed = { at: iso(ahora), by: String(por), verdict: verdict || (paso === 'cerrar' ? 'done' : 'cancelled'), note: note || null };
  return sinPlata(e);
}

// ----- lo que ve el tablero -----

/**
 * Progreso de un padre según sus hijos. REPORTA, no actúa: cerrar al padre porque sus hijos
 * cerraron sería una decisión que no tomó quien encargó.
 */
export function progreso(hijos = []) {
  const por = Object.fromEntries(ESTADOS.map((s) => [s, 0]));
  for (const h of hijos) if (Object.hasOwn(por, h.state)) por[h.state]++;
  const total = hijos.length;
  const cerrados = por.done + por.cancelled;
  return { total, ...por, abiertos: total - cerrados, completo: total > 0 && cerrados === total && por.done > 0 };
}

// Topes de tiempo, en horas. Son del tablero, no del protocolo: mueven lo que se MIRA, nunca
// lo que se puede hacer. Por eso un encargo atascado no se cancela solo.
export const TOPES_H = Object.freeze({ open: 24, taken: 72, delivered: 24 });

/**
 * ¿Por qué está atascado esto? Devuelve null, o la razón con las horas. Es una cuenta de
 * tiempo, no una opinión: el mismo encargo da la misma respuesta en cualquier máquina.
 */
export function atascado(e, ahora = Date.now(), topes = TOPES_H) {
  const tope = topes[e.state];
  if (!tope) return null;
  const desde = Date.parse(e.updated || e.created);
  if (!Number.isFinite(desde)) return null;
  const horas = Math.floor((ahora - desde) / 3600_000);
  if (horas < tope) return null;
  const razon = e.state === 'open' ? (e.assignee ? `nadie lo ha tomado y es de ${e.assignee}` : 'nadie lo ha tomado')
    : e.state === 'taken' ? `${e.assignee} lo tiene y no ha entregado`
    : `entregado y ${e.from} no lo ha cerrado`;
  return { horas, tope, razon };
}

/** El tablero: lo abierto, agrupado, con lo atascado señalado y el progreso de cada padre. */
export function tablero(encargos = [], ahora = Date.now(), topes = TOPES_H) {
  const abiertos = encargos.filter((e) => ABIERTOS.includes(e.state));
  const hijosDe = new Map();
  for (const e of encargos) if (e.parent_id) hijosDe.set(e.parent_id, [...(hijosDe.get(e.parent_id) || []), e]);
  const filas = abiertos.map((e) => ({
    id: e.id, state: e.state, concept: e.concept, from: e.from, assignee: e.assignee,
    parent_id: e.parent_id || null, updated: e.updated,
    atascado: atascado(e, ahora, topes),
    progreso: hijosDe.has(e.id) ? progreso(hijosDe.get(e.id)) : null,
  }));
  // Lo atascado primero y lo más viejo arriba: el tablero se lee de arriba hacia abajo y lo que
  // pide una decisión no puede estar al final.
  filas.sort((a, b) => Number(!!b.atascado) - Number(!!a.atascado) || String(a.updated).localeCompare(String(b.updated)));
  return {
    total: encargos.length,
    abiertos: abiertos.length,
    atascados: filas.filter((f) => f.atascado).length,
    por_estado: Object.fromEntries(ESTADOS.map((s) => [s, encargos.filter((e) => e.state === s).length])),
    filas,
  };
}
