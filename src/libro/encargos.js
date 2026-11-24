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
import { senalAbierta, senalesDe, validarSenal } from './senal.js';

// Los mensajes de rechazo van en INGLÉS porque salen al usuario: vuelven al remitente como razón
// del rebote del postmaster. Los comentarios y los nombres del dominio siguen en español, que es
// la convención de la casa. El guardia de `test/documentacion.test.js` lo vigila.

const iso = (t = Date.now()) => new Date(t).toISOString();

// El sobre que pide o mueve un encargo. Tipo propio, no `op` del Libro: así ninguna lectura del
// Libro lo encuentra por error y el rechazo dice de qué mostrador se trata.
export const MEDIA_ENCARGO = 'application/nyx5.encargo+json';
// El aviso que la casa le deja en el buzon a la contraparte cuando un encargo nace o se mueve.
// Tiene media propio para que un agente pueda filtrarlo del resto de su correo sin adivinar.
export const MEDIA_AVISO_ENCARGO = 'application/nyx5.encargo-aviso+json';

// Los OCHO estados de A2A, que es el vocabulario que pide la orden (SPEC v0.2). No son invencion
// de esta casa: quien ya integro A2A entiende un encargo sin traducir nada. La primera version de
// este archivo traia cinco estados mios (open/taken/delivered/done/cancelled) y los cambie cuando
// relei la orden: el spec acordado manda sobre mi vocabulario.
//
// Y OJO con uno, porque no es obvio: una entrega que espera revision NO es `completed` ni un
// estado propio, es **`input-required`** — depende de una persona. Es exactamente lo que dice el
// mapeo de la fase 3 para un contrato sin verificador, y para un encargo siempre es asi, porque un
// encargo no tiene arbitro.
export const ESTADOS = Object.freeze([
  'submitted',       // pedido, nadie lo tomo
  'working',         // alguien lo tiene y esta en eso
  'input-required',  // espera a una persona: la entrega esta hecha y hay que revisarla, o falta un dato
  'auth-required',   // espera una autorizacion que no es de las partes
  'completed',       // cerrado y aceptado
  'canceled',        // retirado por quien lo pidio (una `l`, como en A2A)
  'failed',          // no se pudo
  'rejected',        // la entrega no sirvio y no se va a reintentar
]);
// Lo que el tablero mira: un encargo cerrado no vuelve a aparecer salvo que se pida.
export const ABIERTOS = Object.freeze(['submitted', 'working', 'input-required', 'auth-required']);
export const FINALES = Object.freeze(['completed', 'canceled', 'failed', 'rejected']);
export const PROFUNDIDAD_MAX = 3;
export const CONCEPTO_MAX = 200;
export const PROYECTO_MAX = 40;
export const RAZON_MAX = 500;
export const DETALLE_MAX = 4000;
// `verify` llega de afuera y se guarda: sin tope, un remitente decide cuánto ocupa una fila.
export const VERIFY_MAX = 10;

// Los campos que convertirían un encargo en un contrato por la puerta de atrás. La lista es
// CORTA a propósito: precisión sobre cobertura, porque un falso positivo retiene trabajo bueno.
// Son nombres de campo, no palabras del texto: un encargo que dice «subir el precio» pasa.
export const SIN_PLATA = Object.freeze(['price', 'amount', 'currency', 'escrow', 'bond', 'fee', 'tokens', 'arbiter']);

// Quién puede hacer cada paso, y desde dónde. `pide` = quien encargó; `hace` = el asignado.
export const PASOS = Object.freeze({
  tomar:    { de: ['submitted'],                                         a: 'working',        quien: 'hace' },
  entregar: { de: ['working'],                                           a: 'input-required', quien: 'hace' },
  cerrar:   { de: ['input-required'],                                    a: 'completed',      quien: 'pide' },
  devolver: { de: ['input-required'],                                    a: 'working',        quien: 'pide' },
  // `rendirse` existe para que `failed` sea alcanzable por quien HACE. Sin el, un encargo que no
  // se puede cumplir solo tenia la salida de que el que pidio lo cancelara, y eso cuenta como
  // retirado y no como intentado: dos cosas distintas en el tablero.
  rendirse: { de: ['working', 'input-required'],                          a: 'failed',         quien: 'hace' },
  // `rechazar` es del que pide: la entrega no sirve y no se reintenta. Distinto de `devolver`,
  // que la manda de vuelta al trabajo.
  rechazar: { de: ['input-required'],                                    a: 'rejected',       quien: 'pide' },
  cancelar: { de: ['submitted', 'working', 'input-required', 'auth-required'], a: 'canceled',  quien: 'pide' },
});

const direccion = (v) => {
  const d = String(v).trim();
  if (!DIRECCION.test(d)) throw new LibroError(400, `assignee does not look like an address: ${d}`);
  return d.toLowerCase();
};

// `due` en ISO-8601, y tiene que ser una fecha de verdad: un plazo ilegible es un plazo que nadie
// puede vencer, y el tablero lo mostraria como si existiera.
const fecha = (v) => {
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new LibroError(400, `due must be an ISO-8601 date, and got: ${String(v).slice(0, 40)}`);
  return new Date(t).toISOString();
};

const texto = (v, max, campo) => {
  if (typeof v !== 'string' || !v.trim()) throw new LibroError(400, `${campo} must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new LibroError(400, `${campo} is longer than ${max} characters`);
  return t;
};

/**
 * Nace un encargo. `padre` es el encargo del que cuelga, ya leído de la bodega (no su id): así
 * la comprobación de que existe no se puede saltar por olvido de quien llama.
 */
// Un `assignee` que no es una dirección es un dueño que no puede tomar nunca lo que se le dio:
// una promesa sin nada detrás. Se comprueba la FORMA, no que exista (puede ser de otra casa).
const DIRECCION = /^[a-z0-9]([a-z0-9._-]{0,62})@[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/i;

export function crearEncargo(pedido, ahora = Date.now()) {
  // El guardia mira lo que LLEGA, no lo que se construye. Medido al escribir la prueba: como
  // este constructor arma un objeto nuevo campo por campo, un `price` de entrada se caía solo y
  // el encargo nacía sin precio y SIN ERROR. Quien lo pidió habría quedado creyendo que cobra.
  sinPlata(pedido);
  const { id, from, assignee = null, concept, detail = null, verify = null, parent = null,
          project = null, reason = null, due = null } = pedido || {};
  if (!id) throw new LibroError(400, 'an encargo needs an id');
  if (!from) throw new LibroError(400, 'an encargo needs to know who is asking');
  const e = {
    nyx5: '1', kind: 'encargo', id: String(id),
    from: String(from),
    // `owner` es el `from` de la RAÍZ, heredado al nacer. Existe para que quien empezó un árbol
    // pueda verlo entero sin que la lectura tenga que subir la cadena de padres consulta por
    // consulta: un hijo que `sigo-cto@` le pide a `sigo-editor@` sigue siendo visible para quien
    // encargó lo de arriba. Es la suma padre->hijos del tablero, en un campo y un predicado.
    owner: parent ? String(parent.owner || parent.from) : String(from),
    assignee: assignee ? direccion(assignee) : null,
    parent_id: parent ? String(parent.id) : null,
    depth: parent ? Number(parent.depth || 0) + 1 : 0,
    concept: texto(concept, CONCEPTO_MAX, 'concept'),
    detail: detail == null ? null : texto(detail, DETALLE_MAX, 'detail'),
    verify: normalizarVerify(verify),
    // Los tres de la orden. `project` se hereda del padre si no se declara: una subtarea pertenece
    // al mismo proyecto que lo que cuelga arriba, y obligar a repetirlo es invitar a que divergan.
    project: project != null ? texto(project, PROYECTO_MAX, 'project') : (parent ? parent.project || null : null),
    reason: reason == null ? null : texto(reason, RAZON_MAX, 'reason'),
    due: due == null ? null : fecha(due),
    state: 'submitted',
    // `rev` es el candado del paso, no decoración: la bodega sólo acepta un cambio si el `rev`
    // que trae es el que tiene guardado. Se cuenta en vez de comparar `updated` porque dos pasos
    // dentro del mismo milisegundo traen el MISMO ISO y la comparación los dejaría pasar los dos.
    rev: 0,
    created: iso(ahora), updated: iso(ahora),
    delivered: null, closed: null,
    log: [{ at: iso(ahora), by: String(from), paso: 'crear', state: 'submitted' }],
  };
  if (e.depth > PROFUNDIDAD_MAX) throw new LibroError(409, `an encargo does not hang more than ${PROFUNDIDAD_MAX} levels deep`);
  // Un padre cerrado no recibe hijos nuevos: el progreso que ya se reportó dejaría de ser cierto.
  if (parent && FINALES.includes(parent.state)) throw new LibroError(409, `the parent encargo ${parent.id} is already ${parent.state}`);
  return sinPlata(e);
}

// El criterio determinista, si lo hay, en la misma forma que lee `verifica@`. Cumplirlo NO paga.
export function normalizarVerify(v) {
  if (v == null) return null;
  const lista = Array.isArray(v) ? v : [v];
  if (!lista.length) return null;
  if (lista.length > VERIFY_MAX) throw new LibroError(400, `an encargo declares at most ${VERIFY_MAX} criteria`);
  for (const c of lista) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new LibroError(400, 'each verify must be an object { type, ... }');
    if (typeof c.type !== 'string' || !c.type) throw new LibroError(400, 'each verify needs a type');
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
      if (Object.hasOwn(sitio, k)) throw new LibroError(400, `an encargo carries no ${k}: internal work moves no money (if it has to be paid, it is a quote to libro@)`);
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
  if (!p) throw new LibroError(400, `unknown step ${paso}; the steps are: ${Object.keys(PASOS).join(', ')}`);
  if (!por) throw new LibroError(403, 'a step needs to know who is taking it');
  if (!p.de.includes(encargo.state)) throw new LibroError(409, `cannot ${paso} an encargo that is ${encargo.state} (only from ${p.de.join(' or ')})`);

  // Quién manda. `tomar` sin asignado lo puede dar cualquiera —así se publica trabajo abierto—,
  // pero con asignado puesto sólo lo toma él: un encargo con dueño no se lo queda un tercero.
  if (p.quien === 'pide' && por !== encargo.from) throw new LibroError(403, `only ${encargo.from}, who asked for it, can ${paso}`);
  if (p.quien === 'hace') {
    if (encargo.assignee && por !== encargo.assignee) throw new LibroError(403, `this encargo belongs to ${encargo.assignee}`);
    if (!encargo.assignee && paso !== 'tomar') throw new LibroError(409, 'this encargo has no owner yet: somebody has to take it first');
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

/**
 * La señal en un encargo: la misma idea y el mismo vocabulario que en un contrato. Entra en el
 * `log` con `paso: 'signal'` y NO toca `state` ni `rev`... con una excepción deliberada:
 *
 * `auth-required` SÍ mueve el estado, porque en A2A ese es un estado y no una nota. Es la única
 * señal que lo hace, y mueve sólo en una dirección (hacia auth-required); `resumed` lo devuelve a
 * donde estaba. Para un contrato no se hace: ahí los estados son del dinero y no se tocan.
 *
 * Quién puede: las partes (quien pidió, quien hace, el dueño del árbol). Un tercero no.
 */
export function senalarEncargo(encargo, { kind, reason = null, por } = {}, ahora = Date.now()) {
  if (!por) throw new LibroError(403, 'a signal needs to know who is sending it');
  if (!visiblePara(encargo, por)) throw new LibroError(403, 'only the parties of this encargo can signal');
  if (FINALES.includes(encargo.state)) throw new LibroError(409, `this encargo is ${encargo.state} and nothing is pending on it`);
  const v = validarSenal({ kind, reason });
  const entrada = { at: iso(ahora), by: String(por), paso: 'signal', kind: v.kind, reason: v.reason, state: encargo.state };
  const e = { ...encargo, rev: Number(encargo.rev || 0) + 1, updated: iso(ahora), log: [...(encargo.log || []), entrada] };
  if (v.kind === 'auth-required') {
    // De dónde volver cuando llegue el `resumed`. Se guarda en la entrada del log, no en un campo
    // nuevo del encargo: el historial ya es el lugar donde vive lo que pasó.
    entrada.volver_a = encargo.state;
    e.state = 'auth-required';
    entrada.state = 'auth-required';
  } else if (v.kind === 'resumed' && encargo.state === 'auth-required') {
    const puesta = [...(encargo.log || [])].reverse().find((h) => h.paso === 'signal' && h.kind === 'auth-required');
    e.state = puesta?.volver_a && !FINALES.includes(puesta.volver_a) ? puesta.volver_a : 'working';
    entrada.state = e.state;
  }
  return sinPlata(e);
}

/** La señal abierta de un encargo, derivada de su log. */
export const senalDeEncargo = (e) => senalAbierta(e?.log || []);
export const senalesDeEncargo = (e) => senalesDe(e?.log || []);

// ----- lo que ve el tablero -----

/**
 * Progreso de un padre según sus hijos. REPORTA, no actúa: cerrar al padre porque sus hijos
 * cerraron sería una decisión que no tomó quien encargó.
 */
export function progreso(hijos = []) {
  const por = Object.fromEntries(ESTADOS.map((s) => [s, 0]));
  for (const h of hijos) if (Object.hasOwn(por, h.state)) por[h.state]++;
  const total = hijos.length;
  // Se cuenta desde FINALES y no nombrando estados a mano. La primera version sumaba
  // `por.done + por.cancelled` y al pasar al vocabulario A2A esos dos dejaron de existir: las dos
  // sumas daban NaN y `abiertos` salia NaN sin que nada reventara. Un total clavado a un nombre
  // deja de contar en silencio el dia que el nombre cambia.
  const cerrados = FINALES.reduce((n, s) => n + (por[s] || 0), 0);
  return {
    total, ...por,
    abiertos: total - cerrados,
    // `completo` exige al menos uno COMPLETADO: tres hijos cancelados no son un padre cumplido.
    completo: total > 0 && cerrados === total && por.completed > 0,
  };
}

// Topes de tiempo, en horas. Son del tablero, no del protocolo: mueven lo que se MIRA, nunca
// lo que se puede hacer. Por eso un encargo atascado no se cancela solo.
// Un tope por cada estado ABIERTO, sin huecos: un estado sin tope se atasca sin que el tablero lo
// diga, y hay una prueba que lo exige. `auth-required` lleva el tope mas corto de todos porque es
// el unico que espera a alguien que NO es parte del encargo: nadie lo va a mirar por su cuenta.
export const TOPES_H = Object.freeze({
  submitted: 24,
  working: 72,
  'input-required': 24,
  'auth-required': 12,
});

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
  // La razon dice QUIEN tiene la pelota, que es la unica cosa accionable de un atasco.
  const razon = e.state === 'submitted' ? (e.assignee ? `nadie lo ha tomado y es de ${e.assignee}` : 'nadie lo ha tomado')
    : e.state === 'working' ? `${e.assignee} lo tiene y no ha entregado`
    : e.state === 'auth-required' ? 'espera una autorizacion de fuera del encargo'
    : `entregado y ${e.from} no lo ha revisado`;
  return { horas, tope, razon, espera: e.state === 'working' ? e.assignee : e.from };
}

/**
 * ¿Puede este agente ver este encargo? Las tres son partes de verdad: quien lo pidió, quien lo
 * hace, y quien empezó el árbol. Un cuarto que pase por aquí no ve nada: la lista blanca es la
 * del encargo, no la de la casa.
 */
export function visiblePara(e, quien) {
  return e.from === quien || e.assignee === quien || (e.owner || e.from) === quien;
}

// El mismo predicado para QUIEN HABLA POR VARIAS DIRECCIONES. Nacio de un defecto medido el
// 23-nov-2026: `claude.nico@` —el Claude conectado de Nicholas— creo el encargo 1081c742 y su
// dueno NO lo veia en su tablero. No era un permiso mal puesto: un delegado es otra direccion, y
// el tablero mira direcciones. Quien delega responde por lo que su delegado pide, asi que tiene
// que verlo; si no, el tablero deja de ser «quien le debe que a quien» justo cuando por fin hay
// agentes pidiendo trabajo.
// La direccion es UNA SOLA: el que delega ve lo de su delegado, NUNCA al reves. Un delegado de
// solo mensajes que viera el trabajo entero de su principal seria una fuga, y ese delegado es
// precisamente el que tiene la llave guardada en la casa.
export function visibleParaAlguna(e, voces = []) {
  return voces.some((q) => visiblePara(e, q));
}

/** El tablero: lo abierto, agrupado, con lo atascado señalado y el progreso de cada padre. */
// `estados` dice QUE SE PINTA, y por defecto es lo abierto. Nacio de un filtro que no podia casar
// nunca: `/encargos?state=completed` pedia a la bodega solo los completados y despues el tablero los
// filtraba otra vez a lo ABIERTO, asi que devolvia cero filas SIEMPRE, con el trabajo ahi guardado.
// Un cero que no puede ser otra cosa no es una medicion. El conteo `abiertos` sigue contando lo
// abierto: es cuanto trabajo hay vivo, no cuantas filas se pidieron.
export function tablero(encargos = [], ahora = Date.now(), topes = TOPES_H, { estados = null } = {}) {
  const abiertos = encargos.filter((e) => ABIERTOS.includes(e.state));
  const mostrados = estados?.length ? encargos.filter((e) => estados.includes(e.state)) : abiertos;
  const hijosDe = new Map();
  for (const e of encargos) if (e.parent_id) hijosDe.set(e.parent_id, [...(hijosDe.get(e.parent_id) || []), e]);
  const filas = mostrados.map((e) => ({
    id: e.id, state: e.state, concept: e.concept, from: e.from, assignee: e.assignee, owner: e.owner || e.from,
    parent_id: e.parent_id || null, updated: e.updated,
    // `due` y `project` se GUARDABAN desde el principio y el tablero no los sacaba, asi que un
    // plazo era un campo que nadie podia mirar: declarado y sin nada detras. El tablero no marca
    // todavia lo VENCIDO (`atascado` mide tiempo en el estado, que es otra cosa): da la fecha y
    // quien lee compara. Marcarlo seria politica de la casa sobre una fecha que puso otro.
    due: e.due || null, project: e.project || null,
    atascado: atascado(e, ahora, topes),
    senal: senalDeEncargo(e),
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
