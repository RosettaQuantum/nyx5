// node --test test/
// El tope de red del CLIENTE (18-nov-2026). Nació de un defecto medido, no de una idea: Nicholas
// corrió `nyx5 consola` y le dijo `error: fetch failed`. La casa estaba sana —contestaba en 0,3 s
// una vez conectada—, pero de 12 conexiones a nyx5.com desde su red, 3 tardaron más de 3 s en
// establecerse y dos pasaron de 16 s: se pierde el primer SYN y TCP reintenta con espera creciente.
// Con el tope en 10 s, el comando moría cerca de 1 de cada 4 veces y el mensaje no decía nada.
//
// Lo que estas pruebas cuidan, en orden de lo que de verdad se puede romper:
//  1. que el tope por defecto no vuelva a ser corto;
//  2. que la perilla LLEGUE al `fetch` — un valor de configuración que nadie lee es un placebo,
//     así que se mide el comportamiento, no la constante;
//  3. que un valor basura no apague el tope (sin tope, un comando se cuelga para siempre);
//  4. que nadie reintroduzca un literal corto en el cliente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, TOPE_RED_MS, topeDeRed, esFallaDeRed } from '../src/correo/agente.js';
import { generateKeys } from '../src/nucleo/crypto.js';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Un fetch que tarda `ms` y HONRA la señal, como la haría una red real. Si no la honrara, la
// prueba del tope pasaría sola y no mediría nada.
const fetchQueTarda = (ms) => (_url, init) => new Promise((resolver, rechazar) => {
  const t = setTimeout(() => resolver(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })), ms);
  init?.signal?.addEventListener('abort', () => {
    clearTimeout(t);
    rechazar(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  });
});

const agenteCon = (fetchImpl) => new Agent({
  address: 'prueba@casa.test', keys: generateKeys(), estafeta: 'https://casa.test', fetchImpl,
});

const conEnv = async (valor, fn) => {
  const antes = process.env.NYX5_TIMEOUT_MS;
  if (valor === null) delete process.env.NYX5_TIMEOUT_MS; else process.env.NYX5_TIMEOUT_MS = valor;
  try { return await fn(); } finally {
    if (antes === undefined) delete process.env.NYX5_TIMEOUT_MS; else process.env.NYX5_TIMEOUT_MS = antes;
  }
};

test('el tope por defecto aguanta una conexión que se reintenta', async () => {
  await conEnv(null, () => {
    assert.equal(topeDeRed(), TOPE_RED_MS);
    // 24 s fue el peor caso MEDIDO; el tope tiene que quedar por encima con margen. Si alguien lo
    // baja a 10 s otra vez, esto grita antes de que lo sufra una persona.
    assert.ok(TOPE_RED_MS >= 25_000, `el tope del cliente bajó a ${TOPE_RED_MS} ms`);
  });
});

test('la perilla llega de verdad al fetch: corta cuando toca y no corta cuando no', async () => {
  // Corto: el tope es menor que lo que tarda la red, así que la llamada se aborta.
  await conEnv('60', async () => {
    const a = agenteCon(fetchQueTarda(400));
    await assert.rejects(() => a._call('GET', '/loquesea'), (e) => e.name === 'TimeoutError');
  });
  // Largo: la MISMA red lenta, con tope suficiente, responde. Sin este segundo lado, un fetch
  // siempre roto haría pasar la prueba de arriba sin que la perilla hiciera nada.
  await conEnv('3000', async () => {
    const a = agenteCon(fetchQueTarda(400));
    assert.deepEqual(await a._call('GET', '/loquesea'), { ok: true });
  });
});

test('un valor basura cae al tope por defecto, nunca a "sin tope"', async () => {
  for (const malo of ['0', '-5', 'pronto', '', 'NaN']) {
    await conEnv(malo, () => assert.equal(topeDeRed(), TOPE_RED_MS, `NYX5_TIMEOUT_MS=${malo} no cayó al tope`));
  }
});

test('el cliente no vuelve a clavar un tope corto en una llamada', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/correo/agente.js'), 'utf8');
  const clavados = [...src.matchAll(/AbortSignal\.timeout\(\s*([\d_]+)\s*\)/g)].map((m) => Number(m[1].replace(/_/g, '')));
  const cortos = clavados.filter((n) => n < 25_000);
  assert.deepEqual(cortos, [], `el cliente tiene topes cortos clavados: ${cortos.join(', ')} ms`);
});

// El ALCANCE es parte del arreglo, no un detalle: el tope de `verifica.js` es del ÁRBITRO y entra
// en el contrato que mueve dinero (una prueba que tarda más de su tope queda indecisa, y nadie
// decide). Subirlo "de paso" cambiaría veredictos. Esta prueba fija que no se tocó.
test('el árbitro conserva su propio tope', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/libro/verifica.js'), 'utf8');
  assert.ok(!src.includes('topeDeRed'), 'verifica.js tomó el tope del cliente: su tope es del contrato');
});

// ---------- el mensaje ----------
// El otro lado del mismo defecto: `error: fetch failed` no dice a quién no se llegó ni que
// reintentar suele bastar. Con PRECISIÓN, no cobertura: un consejo de red sobre un error que NO
// es de red manda a la persona a mirar su wifi cuando le falta saldo, y eso cuesta más que callar.
test('se distingue no haber llegado de que la casa dijera que no', () => {
  for (const e of [
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    new TypeError('fetch failed'),
    new Error('connect ECONNREFUSED 127.0.0.1:443'),
    new Error('getaddrinfo ENOTFOUND nyx5.com'),
    new Error('socket hang up'),
  ]) assert.ok(esFallaDeRed(e), `no reconoció una falla de red: ${e.message}`);

  for (const e of [
    Object.assign(new Error('insufficient balance'), { status: 402 }),
    Object.assign(new Error('no such agent'), { status: 404 }),
    Object.assign(new Error('HTTP 401'), { status: 401 }),
    new Error('body or attachments required'),
    undefined, null,
  ]) assert.ok(!esFallaDeRed(e), `tomó por falla de red algo que no lo es: ${e?.message}`);
});

test('el CLI lo dice, no sólo lo sabe', async () => {
  // Punta a punta: una casa que no existe, un tope mínimo, y el binario de verdad. Sin esto, el
  // clasificador podría estar perfecto y no estar cableado a nada — que es el modo de fallo de
  // esta casa (un guardia que nadie corre no es parte de la cadena).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-tope-'));
  const llave = path.join(dir, 'a.json');
  fs.writeFileSync(llave, JSON.stringify({ address: 'prueba@casa.test', estafeta: 'http://127.0.0.1:1', keys: generateKeys() }));
  const r = spawnSync(process.execPath, [path.join(raiz, 'bin/nyx5.js'), 'balance', '--agent', llave],
    { encoding: 'utf8', env: { ...process.env, NYX5_TIMEOUT_MS: '300' } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not reach the house/, `el CLI no explicó la falla de red:\n${r.stderr}`);
  assert.match(r.stderr, /NYX5_TIMEOUT_MS/, 'el CLI no dice cómo subir el tope');
});
