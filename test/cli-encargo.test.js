// node --test test/
// La CLI y los encargos, con el BINARIO de verdad contra una casa de verdad.
//
// Defecto medido el 24-nov-2026, y me lo caze a mi mismo: mande una senal con
// `nyx5 encargo --op signal --kind progress` y la casa la rechazo. La CLI ofrecia la op `signal`
// y NO mandaba el `kind` — solo `note` —, asi que el comando salia bien, la casa contestaba
// `kind must be one of: ...` y el que lo corrio se enteraba por un rebote del postmaster varios
// minutos despues. Una superficie que ofrece una op y no manda lo que esa op exige es una promesa
// publicada; es el mismo defecto que `nyx5_attach` mandando a un campo de `nyx5_send` que no
// existia, y van tres en el mismo dia.
//
// Por eso esto NO se prueba leyendo la fuente: se corre el binario y se mira el encargo en la casa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { SENALES } from '../src/libro/senal.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nyx5.js');
const P = 4896;
const CASA = 'cliencargo.test';
const hosts = { [CASA]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, jefe, obrero, archivoHosts, llaveJefe, llaveObrero;

const correr = async (args) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args],
      { env: { ...process.env, NYX5_HOSTS: archivoHosts, NYX5_TIMEOUT_MS: '20000' } });
    return { code: 0, stdout, stderr };
  } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
};
const guardar = (a, nombre) => {
  const f = path.join(tmp, nombre);
  fs.writeFileSync(f, JSON.stringify({ address: a.address, estafeta: a.estafeta, keys: a.keys }));
  return f;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-clienc-'));
  archivoHosts = path.join(tmp, 'hosts.json');
  fs.writeFileSync(archivoHosts, JSON.stringify(hosts));
  casa = await new Estafeta({
    domain: CASA, port: P, dataDir: path.join(tmp, CASA), adminToken: 't', hosts,
    workerIntervalMs: 60, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  }).start();
  jefe = (await join({ house: CASA, name: 'jefe', hosts }))._agente;
  obrero = (await join({ house: CASA, name: 'obrero', hosts }))._agente;
  llaveJefe = guardar(jefe, 'jefe.json');
  llaveObrero = guardar(obrero, 'obrero.json');
});
after(async () => { await casa.stop(); });

test('sin --kind la senal NO sale, y la CLI dice cuales valen', async () => {
  // Falla ANTES de leer una llave y antes de tocar la red: lo barato primero. Comprobarlo despues
  // de cargar la llave hacia que el error visible fuera el de la llave y el verdadero no se viera.
  const r = await correr(['encargo', '--op', 'signal', '--id', 'cualquiera']);
  assert.equal(r.code, 2);
  for (const k of SENALES) assert.match(r.stderr, new RegExp(k), `la CLI no nombra el kind ${k}`);
  assert.match(r.stderr, /--reason/, 'no dice como explicar la senal');
});

test('la senal LLEGA a la casa con su kind y su razon', async () => {
  const creado = await correr(['encargar', '--agent', llaveJefe, '--concept', 'algo que se traba', '--to', obrero.address, '--json']);
  assert.equal(creado.code, 0, creado.stderr);
  const id = JSON.parse(creado.stdout).envelope.id;
  await casa.tick();
  assert.equal((await correr(['encargo', '--agent', llaveObrero, '--op', 'tomar', '--id', id, '--json'])).code, 0);
  await casa.tick();

  const r = await correr(['encargo', '--agent', llaveObrero, '--op', 'signal', '--id', id,
    '--kind', 'auth-required', '--reason', 'falta que alguien autorice el token', '--json']);
  assert.equal(r.code, 0, r.stderr);
  await casa.tick();

  // La verdad esta en la casa, no en lo que imprimio el comando.
  const fila = (await jefe.tablero(CASA, { state: 'auth-required' })).filas.find((f) => f.id === id);
  assert.ok(fila, 'la senal no llego: el encargo no quedo esperando autorizacion');
  assert.equal(fila.senal.kind, 'auth-required');
  assert.equal(fila.senal.reason, 'falta que alguien autorice el token', 'la razon se perdio por el camino');
});

test('un paso lleva la EVIDENCIA, que ninguna superficie podia escribir', async () => {
  const creado = await correr(['encargar', '--agent', llaveJefe, '--concept', 'entregar con prueba', '--to', obrero.address, '--json']);
  const id = JSON.parse(creado.stdout).envelope.id;
  await casa.tick();
  await correr(['encargo', '--agent', llaveObrero, '--op', 'tomar', '--id', id, '--json']);
  await casa.tick();
  const sha = 'a'.repeat(64);
  const r = await correr(['encargo', '--agent', llaveObrero, '--op', 'entregar', '--id', id,
    '--note', 'ahi va', '--evidence', sha, '--url', 'https://ejemplo.test/entrega.json', '--json']);
  assert.equal(r.code, 0, r.stderr);
  await casa.tick();

  // La entrega vive en `delivered`, no en el historial: el log dice QUE paso, `delivered` dice con
  // QUE se entrego. Esta prueba lo aprendio mirando primero donde no era.
  const e = await casa.store.encargoGet(id);
  assert.ok(e.delivered, 'no quedo la entrega');
  assert.equal(e.delivered.evidence_sha256, sha, 'la evidencia no llego: hay que creerle al que entrega');
  assert.equal(e.delivered.url, 'https://ejemplo.test/entrega.json');
  assert.equal(e.delivered.note, 'ahi va');
});
