// node --test test/
// La sesión de la consola: mirar el tablero desde un navegador sin mover la llave.
//
// Lo que estas pruebas cuidan, en orden de lo que costaría equivocarse:
//
//  1. QUE LA BASE NO GUARDE EL TOKEN. Quien lea un respaldo se lleva hashes, no sesiones vivas.
//  2. QUE LA SESIÓN SÓLO LEA. No firma, no opera el Libro, no emite otra sesión, y sólo ve lo de
//     SU dirección. Un token filtrado es una vista de lectura que caduca sola, no una llave.
//  3. QUE CADUQUE DE VERDAD. Una sesión que no vence es una llave con otro nombre.
//  4. QUE LA PÁGINA NO TRAIGA DATOS. El HTML se sirve sin autenticar a propósito: no hay nada
//     adentro. Si algún día trae una fila, el token tendría que viajar en la URL y quedaría
//     escrito en el registro de accesos.
//  5. QUE UN TOKEN INVENTADO, UNO VENCIDO Y UNO DEFORME DEN LO MISMO. Respuestas distintas le
//     dicen a quien prueba si acertó la forma.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { sha256hex } from '../src/nucleo/crypto.js';
import * as consola from '../src/correo/consola.js';

const P = 4881;
const H = 'consola.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
const U = `http://127.0.0.1:${P}`;
let tmp, casa, nico, otro;

const datos = (token) => fetch(`${U}/consola/datos`, token === undefined ? {} : { headers: { authorization: `Nyx5-Consola ${token}` } });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-consola-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 'a', hosts, publicUrl: U,
    workerIntervalMs: 100, libro: { welcome: 0 }, log: () => {},
  }).start();
  nico = Agent.create(`nicholas@${H}`, U, { hosts });
  otro = Agent.create(`otro@${H}`, U, { hosts });
  for (const a of [nico, otro]) await a.register({ adminToken: 'a' });
  // Un encargo de cada uno, para poder comprobar que la consola no cruza direcciones.
  await nico.encargar(H, { concept: 'lo de nicholas', assignee: `otro@${H}` });
  await otro.encargar(H, { concept: 'lo de otro, que nicholas no pidió ni hace' });
  await casa.tick();
});
after(async () => { await casa.stop(); });

test('la firma emite la sesión, y la base guarda el HASH y no el token', async () => {
  const r = await nico.abrirConsola(H);
  assert.equal(r.address, nico.address);
  assert.ok(consola.esquemaToken.test(r.token), `el token no tiene la forma esperada: ${r.token}`);
  assert.ok(r.url.includes('#t='), 'el token tiene que ir en el FRAGMENTO, no en el query string');
  assert.ok(!r.url.includes('?t='), 'un token en el query string queda escrito en los registros');
  assert.ok(Date.parse(r.vence) > Date.now(), 'la sesión tiene que venir con su vencimiento');

  // EL PUNTO: en la base está el hash. Buscar por el token en claro no encuentra nada.
  assert.equal(await casa.store.kvGet(consola.NS, r.token), null, 'el token en claro está en la base');
  const guardada = await casa.store.kvGet(consola.NS, sha256hex(r.token));
  assert.ok(guardada, 'no se guardó la sesión bajo el hash del token');
  assert.equal(guardada.address, nico.address);
  assert.ok(!JSON.stringify(guardada).includes(r.token), 'la fila guardada contiene el token');
});

test('sin sesión no hay datos, y un token inventado, deforme o vencido dan lo MISMO', async () => {
  assert.equal((await datos(undefined)).status, 401, 'sin cabecera');
  assert.equal((await datos('')).status, 401, 'vacío');
  assert.equal((await datos('corto')).status, 401, 'deforme');
  assert.equal((await datos('../../etc/passwd')).status, 401, 'con forma de ruta');
  assert.equal((await datos('A'.repeat(43))).status, 401, 'con la forma correcta pero inventado');
  // Vencido: se abre con vida negativa y se pide igual.
  const { token } = await consola.abrir(casa.store, nico.address, Date.now() - 2000, 1000);
  assert.equal((await datos(token)).status, 401, 'una sesión vencida sigue sirviendo');
});

test('un token deforme ni siquiera toca la base', async () => {
  // Esto se mide, no se promete. Quitar la comprobación de forma no cambia la RESPUESTA —un token
  // basura no encuentra nada igual— así que una prueba de comportamiento no lo ve. Lo que sí se
  // ve es si la casa fue a la base con lo que mandó un extraño: cada petición basura sería una
  // lectura de base gratis para quien la manda.
  const real = casa.store.kvGet.bind(casa.store);
  let lecturas = 0;
  casa.store.kvGet = async (ns, k, n) => { if (ns === consola.NS) lecturas++; return real(ns, k, n); };
  try {
    for (const basura of ['', 'corto', '../../etc/passwd', 'a'.repeat(200), 'con espacio aqui']) {
      assert.equal((await datos(basura)).status, 401, `${basura} no dio 401`);
    }
    assert.equal(lecturas, 0, `la casa consultó la base ${lecturas} vez/veces con un token deforme`);
    // Y con uno BIEN formado sí consulta: si no, esta prueba pasaría por no consultar nunca.
    await datos('A'.repeat(43));
    assert.equal(lecturas, 1, 'con un token bien formado sí tiene que consultar');
  } finally { casa.store.kvGet = real; }
});

test('la sesión sólo ve lo de SU dirección', async () => {
  const mio = await nico.abrirConsola(H);
  const ajeno = await otro.abrirConsola(H);

  const dm = await (await datos(mio.token)).json();
  assert.equal(dm.address, nico.address);
  assert.ok(dm.filas.some((f) => f.titulo === 'lo de nicholas'), 'no veo lo mío');
  assert.ok(!dm.filas.some((f) => f.titulo.includes('lo de otro')), 'la consola está cruzando direcciones');

  const da = await (await datos(ajeno.token)).json();
  assert.equal(da.address, otro.address);
  // `otro` es el asignado de lo de nicholas, así que SÍ lo ve: es parte. Lo que no puede pasar es
  // que vea algo de lo que no es parte, y eso lo cubre la aserción de arriba.
  assert.ok(da.filas.some((f) => f.titulo.includes('lo de otro')));
  // Y las cifras vienen calculadas por la casa, no por la página.
  for (const k of ['abiertos', 'te_necesitan', 'bloqueados', 'atascados', 'por_estado']) {
    assert.ok(k in dm, `la casa no entregó ${k}: la página tendría que calcularlo, y entonces dos consolas mostrarían dos tableros`);
  }
});

test('la sesión NO sirve para firmar, operar ni abrir otra sesión', async () => {
  const { token } = await nico.abrirConsola(H);
  const cab = { authorization: `Nyx5-Consola ${token}` };
  // Las rutas firmadas no la aceptan: su puerta es otra.
  for (const ruta of ['/trabajo', '/encargos', `/mailbox/${nico.local}`]) {
    const r = await fetch(`${U}${ruta}`, { headers: cab });
    assert.equal(r.status, 401, `${ruta} aceptó un token de consola`);
  }
  // Y no emite otra sesión: eso exige la firma.
  assert.equal((await fetch(`${U}/consola/sesion`, { method: 'POST', headers: cab })).status, 401, 'un token de consola emitió otra sesión');
});

test('la página se sirve sin autenticar PORQUE no trae datos adentro', async () => {
  const r = await fetch(`${U}/consola`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  const html = await r.text();
  // El guardia que importa: ni un dato, ni una dirección, ni un id de encargo en el HTML servido.
  assert.ok(!html.includes('lo de nicholas'), 'la página trae datos adentro');
  assert.ok(!html.includes(nico.address), 'la página trae una dirección adentro');
  assert.ok(!/Nyx5-Consola\s+[A-Za-z0-9_-]{43}/.test(html), 'la página trae un token adentro');
  // Y pide los datos aparte, por la cabecera.
  assert.match(html, /\/consola\/datos/);
  assert.match(html, /authorization/i);
});

test('cerrar la sesión la apaga, y no hace falta firma para soltarla', async () => {
  const { token } = await nico.abrirConsola(H);
  assert.equal((await datos(token)).status, 200);
  const r = await fetch(`${U}/consola/sesion`, { method: 'DELETE', headers: { authorization: `Nyx5-Consola ${token}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).closed, true);
  assert.equal((await datos(token)).status, 401, 'la sesión cerrada sigue sirviendo');
  // Cerrar dos veces no es un error ni una pista: 404 y nada más.
  assert.equal((await fetch(`${U}/consola/sesion`, { method: 'DELETE', headers: { authorization: `Nyx5-Consola ${token}` } })).status, 404);
});

test('dos sesiones de la misma dirección son independientes', async () => {
  const a = await nico.abrirConsola(H);
  const b = await nico.abrirConsola(H);
  assert.notEqual(a.token, b.token, 'dos sesiones no pueden compartir token');
  await fetch(`${U}/consola/sesion`, { method: 'DELETE', headers: { authorization: `Nyx5-Consola ${a.token}` } });
  assert.equal((await datos(a.token)).status, 401, 'la cerrada tiene que morir');
  assert.equal((await datos(b.token)).status, 200, 'cerrar una no puede matar la otra');
});
