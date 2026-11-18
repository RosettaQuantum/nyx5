// Nyx5/1 — La sesión de la consola: mirar el tablero desde un navegador sin mover la llave.
//
// EL PROBLEMA. El tablero es una lectura FIRMADA: cada petición lleva un token Ed25519 con nonce
// y ventana de cinco minutos. Un navegador no puede firmar con la llave del Mac sin que la llave
// viva en el navegador, y una llave en un navegador es una llave que se puede filtrar con una
// extensión, una pestaña y un descuido.
//
// LA FORMA. La llave del Mac EMITE una sesión corta y se queda donde está. La consola lleva un
// token opaco que no sirve para nada más: sólo lee, no firma nada, no opera el Libro y no puede
// emitir otra sesión. Si se filtra, lo que se filtró es una vista de lectura que caduca sola.
//
// TRES DECISIONES QUE NO SON DE ESTILO:
//
// 1. SE GUARDA EL HASH DEL TOKEN, NO EL TOKEN. Quien lea la base —un respaldo, una consulta de
//    soporte, un volcado— se lleva hashes, no sesiones vivas. Es la misma razón por la que nadie
//    guarda contraseñas en claro, y cuesta una línea.
// 2. EL TOKEN VIAJA EN EL FRAGMENTO DE LA URL (`#t=...`), nunca en el query string. El fragmento
//    NO se manda al servidor: no aparece en el registro de accesos, ni en el referrer, ni en el
//    historial que se sincroniza. Un token en `?t=` queda escrito en cada registro que la URL
//    atraviesa.
// 3. CADUCA SOLA, y corto. Doce horas es un día de trabajo: alcanza para una jornada y no para
//    que una pestaña olvidada en un café siga mirando el tablero la semana que viene.

import { sha256hex, b64u } from '../nucleo/crypto.js';
import { randomBytes } from 'node:crypto';

export const NS = 'consola';
/** Doce horas: una jornada. Ver la decisión 3 de la cabecera. */
export const VIDA_MS = 12 * 3600_000;
/** 32 bytes de azar. No es un identificador: es una credencial, y se trata como tal. */
export const LARGO_BYTES = 32;

export const esquemaToken = /^[A-Za-z0-9_-]{43}$/;

/** El token en claro (sólo existe una vez, en la respuesta) y su hash, que es lo que se guarda. */
export function nuevoToken() {
  const token = b64u(randomBytes(LARGO_BYTES));
  return { token, hash: sha256hex(token) };
}

/** Del header `Authorization: Nyx5-Consola <token>`. En la cabecera, nunca en la URL. */
export function tokenDe(rx) {
  const h = (rx?.headers?.authorization || '').trim();
  const m = /^Nyx5-Consola\s+([A-Za-z0-9_-]+)$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Abre una sesión para `address`. Devuelve el token en claro UNA vez; después sólo vive su hash.
 * `extra` deja constancia de desde dónde se abrió, sin guardar nada identificatorio de una persona.
 */
export async function abrir(store, address, ahora = Date.now(), vida = VIDA_MS) {
  const { token, hash } = nuevoToken();
  await store.kvPut(NS, hash, { address, abierta: new Date(ahora).toISOString(), vence: new Date(ahora + vida).toISOString() }, ahora + vida);
  return { token, vence: new Date(ahora + vida).toISOString() };
}

/**
 * Devuelve la dirección de la sesión, o null. Falla cerrado ante cualquier duda: un token con
 * forma rara no se busca siquiera, porque buscar es tocar la base con lo que mandó un extraño.
 */
export async function dueno(store, token, ahora = Date.now()) {
  if (!token || !esquemaToken.test(token)) return null;
  const s = await store.kvGet(NS, sha256hex(token), ahora);
  return s?.address || null;
}

/** Cierra una sesión concreta. Lo usa `nyx5 consola --off`. */
export async function cerrar(store, token) {
  if (!token || !esquemaToken.test(token)) return false;
  const h = sha256hex(token);
  if (!await store.kvGet(NS, h)) return false;
  await store.kvDelete?.(NS, h);
  return true;
}
