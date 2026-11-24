// node --test test/
// El medidor (24-nov-2026, demo del 27-nov): una dirección viva atiende pedidos de medición sin
// modelo. Aquí se prueba: el alta (sólo la casa, prueba de posesión, custodia declarada, uno por
// casa, y que no conviva con un cerebro ni con un ejecutor); el recorrido completo (pedido, ficha
// firmada y cifrada, acta sellada en la notaría, sello verificable, pedido y recibo confirmados);
// el acuse cuando la medición tarda; reintentos y errores en palabras (nunca silencio); que lo que
// no es un pedido queda para quien lea el buzón; la ayuda una vez; cupos; dos relojes a la vez;
// la verificación por el MCP de Rosetta; y que el dominio pedido nunca se vuelve una URL.
// Rosetta y la API de Anthropic son de mentira: aquí no sale nada a la red.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeys, sha256hex, canonical, verifyObject, signObject } from '../src/nucleo/crypto.js';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { atenderMedidor, interpretar, dominioValido, sectorDe, NS, NS_CUPO, CUPO, MARCA_ACTA, TEXTOS } from '../src/correo/medidor.js';

const P = 4917;
const H = 'medidor.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const ROSETTA = 'https://rosetta.example/v1/medicion';
const RESPALDO = 'https://respaldo.example/v1/medicion';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, casa, nicholas, rosetta, colega, extrano;
// El medidor es una dirección NUEVA cuya llave nace en la bóveda (decisión de Nicholas, 24-nov).
const LOCAL_M = 'medicion-rosetta';
const MEDIDOR = `${LOCAL_M}@${H}`;
let llamadasApi = 0;
const llamadas = [];   // cada llamada al instrumento: { url, body }
// El instrumento de mentira. `guion` es una cola de respuestas; vacía = medición correcta al toque.
const guion = [];
const fichaDe = (dominio) => `# Ficha Rosetta · Seguridad post-cuántica\n**${dominio}** · Banca\n\n| RQ.S.00 | Nota Q-Ready | **B** |`;
const okDe = (body) => ({ ok: true, instrumento: 'rosetta-sondas-envivo/1', dominio: body.dominio, medido_utc: new Date().toISOString(),
  qex: { valor: 61, version: 'QEX-1.2' }, nota: { letra: 'B', version: 'QREADY-NOTA-2.1' },
  presentacion: { markdown: fichaDe(body.dominio), ficha: { url_dominio: `https://rosettaquantum.com/es/q-ready/medicion/?dominio=${body.dominio}` } } });
const responder = (status, json, headers = {}) => new Response(typeof json === 'string' ? json : JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
async function instrumento(url, init) {
  const body = JSON.parse(init.body);
  llamadas.push({ url: String(url), body });
  const paso = guion.shift();
  if (typeof paso === 'function') return paso(url, body, init);
  if (String(url).endsWith('/mcp')) return responder(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } });
  return responder(200, okDe(body));
}
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, { method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
// Todas las respuestas de rosetta@ a un sobre, abiertas, en orden de llegada.
async function respuestasA(quien, id, { cuantas = 1, timeoutMs = 8000 } = {}) {
  const hasta = Date.now() + timeoutMs;
  for (;;) {
    const ms = (await quien.inbox({ limit: 200 })).filter((m) => m.envelope.from === MEDIDOR && m.envelope.in_reply_to === id);
    if (ms.length >= cuantas || Date.now() > hasta) {
      const abiertos = [];
      for (const m of ms.sort((a, b) => Date.parse(a.envelope.created) - Date.parse(b.envelope.created))) abiertos.push(await quien.open(m.envelope));
      return abiertos;
    }
    await espera(100);
  }
}
const pendienteEnRosetta = async (id) => (await casa.store.listMail(LOCAL_M)).some((m) => m.envelope.id === id);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-medidor-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {},
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
    // Hay clave de la API: si algo la llamara, se sabría. El medidor no la llama.
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: async () => { llamadasApi++; throw new Error('la API no se llama'); } },
    medidor: { enabled: true, urls: [ROSETTA, RESPALDO], fetchImpl: instrumento, tiempos: { acuseMs: 300, kickMs: 2000, cronMs: 3000 } },
  }).start();
  nicholas = Agent.create(`nicholas@${H}`, URL_CASA, { hosts });
  rosetta = Agent.create(`rosetta@${H}`, URL_CASA, { hosts });
  colega = Agent.create(`colega@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  for (const a of [nicholas, extrano]) await a.register({ adminToken: 't' });
  // rosetta@ existe y NO es el medidor: su llave es suya y no se toca.
  await rosetta.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [nicholas.address] } });
  // colega@ filtra por lista: el alta del medidor le abre la vuelta.
  await colega.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [nicholas.address] } });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('interpretar: dominio y sector del texto, nunca el dominio de una dirección; JSON explícito; el acta no es un pedido', { timeout: 60_000 }, () => {
  const a = interpretar({ body: 'Hola rosetta@nyx5.com, por favor mide santander.cl, sector banca.' });
  assert.deepEqual([a.accion, a.dominio, a.sector, a.idioma], ['medir', 'santander.cl', 'banca', 'es']);
  assert.equal(interpretar({ body: 'mide https://www.Santander.CL/personas en bancos' }).dominio, 'santander.cl', 'sin www, minúsculas, desde una URL');
  assert.equal(interpretar({ body: 'escríbele a rosetta@nyx5.com' }).accion, null, 'el dominio de una dirección no es un pedido');
  assert.equal(interpretar({ body: 'mide localhost.localhost, sector banca' }).dominio, null);
  assert.equal(interpretar({ body: 'measure example.com, sector banca' }).idioma, 'en');
  assert.deepEqual(interpretar({ body: { dominio: 'bci.cl', sector: 'banca' } }), { accion: 'medir', dominio: 'bci.cl', crudo: 'bci.cl', sector: 'banca', idioma: 'es' });
  assert.equal(interpretar({ body: 'inicia la verificación de santander.cl' }).accion, 'verificar');
  assert.equal(interpretar({ body: 'comprueba la verificación de santander.cl' }).accion, 'comprobar');
  assert.equal(interpretar({ body: 'mide algo por favor' }).accion, 'ayuda');
  assert.equal(interpretar({ body: 'hola, ¿cómo va el informe?' }).accion, null, 'charla: no es para el medidor');
  assert.equal(interpretar({ body: 'nada' }, { tipo: 'task' }).accion, 'ayuda', 'un task sin dominio recibe la ayuda');
  assert.equal(interpretar({ body: `Medición de santander.cl · sector banca ${MARCA_ACTA}` }).accion, null, 'una respuesta nuestra citada no se vuelve a medir');
  // Homógrafos y nombres con letras fuera de ASCII: nunca se mide OTRO dominio en silencio.
  assert.equal(interpretar({ body: 'mide münchen.de, sector banca' }).dominio ?? null, null, 'no «nchen.de»');
  assert.equal(interpretar({ body: 'mide sántander.cl, sector banca' }).dominio ?? null, null, 'no «santander.cl» ni «ntander.cl»');
  assert.equal(interpretar({ body: 'mide \u0441antander.cl, sector banca' }).dominio ?? null, null, 'una c cirílica no se convierte en otro dominio');
  assert.equal(dominioValido('-malo.cl'), null); assert.equal(dominioValido('a'.repeat(64) + '.cl'), null); assert.equal(dominioValido('xn--bcher-kva.ch'), 'xn--bcher-kva.ch');
  assert.equal(sectorDe('Minería'), 'mineria'); assert.equal(sectorDe('sin sector'), null);
});

test('alta: la llave NACE en la bóveda, no se importa ni sale; la tarjeta declara la custodia; uno por casa; no convive con cerebro ni ejecutor', { timeout: 60_000 }, async () => {
  const cuerpo = { local: LOCAL_M, owner: nicholas.address, allow: [nicholas.address, colega.address] };
  assert.equal((await fetch(`${URL_CASA}/admin/medidor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) })).status, 401);
  const conLlave = await admin('POST', '/admin/medidor', { ...cuerpo, keys: rosetta.keys });
  assert.equal(conLlave.status, 400, 'no hay puerta para importar una llave'); assert.match(conLlave.body.reason, /born in the vault/);
  assert.equal((await admin('POST', '/admin/medidor', { ...cuerpo, local: 'rosetta' })).status, 409, 'una dirección viva (rosetta@) no se convierte en medidor');
  assert.equal((await admin('POST', '/admin/medidor', { local: LOCAL_M })).status, 400, 'sin lista no hay medidor');
  const alta = await admin('POST', '/admin/medidor', cuerpo);
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  assert.equal(alta.body.address, MEDIDOR);
  assert.equal(alta.body.custody.keys, 'house'); assert.equal(alta.body.custody.via, 'medidor');
  // La llave sólo existe sellada en la bóveda: ninguna respuesta trae la privada, y la de la bóveda es la de la tarjeta.
  const deBoveda = await casa.llavesDeBoveda(LOCAL_M);
  assert.ok(deBoveda?.sigPriv && deBoveda?.encPriv, 'la bóveda tiene la llave');
  assert.equal(deBoveda.sig, alta.body.sig);
  for (const secreto of [deBoveda.sigPriv, deBoveda.encPriv]) assert.equal(JSON.stringify(alta.body).includes(secreto), false, 'la respuesta del alta no trae la llave privada');
  const crudo = await casa.store.kvGet('boveda', LOCAL_M);
  assert.equal(JSON.stringify(crudo).includes(deBoveda.sigPriv), false, 'en el almacén está sellada, no en claro');
  const card = await nicholas.resolver.agentCard(MEDIDOR);
  assert.equal(card.custody.via, 'medidor', 'la tarjeta pública lo dice'); assert.equal(card.custody.keys, 'house');
  assert.equal(card.profile.display_name, 'Medidor de Rosetta');
  assert.equal(card.delegation, undefined, 'dirección raíz de la casa, sin la firma de rosetta@');
  assert.deepEqual(card.inbox.allowlist, [nicholas.address, colega.address]);
  colega.resolver.invalidate(`agent:${colega.address}`);
  assert.ok((await nicholas.resolver.agentCard(colega.address)).inbox.allowlist.includes(MEDIDOR), 'la vuelta queda abierta en la lista de colega@');
  assert.equal((await nicholas.resolver.agentCard(rosetta.address)).sig, rosetta.keys.sig, 'rosetta@ no cambió');
  assert.equal((await nicholas.resolver.agentCard(rosetta.address)).custody, undefined);
  assert.equal((await admin('POST', '/admin/medidor', { local: 'otro-medidor', allow: [nicholas.address] })).status, 409, 'uno por casa');
  const adoptar = await admin('POST', '/admin/assistants', { adopt: true, local: LOCAL_M, keys: generateKeys(), config: { budget_usd: 1 } });
  assert.equal(adoptar.status, 409, JSON.stringify(adoptar.body));
  const ejecutor = await admin('POST', '/admin/executors', { local: LOCAL_M, provider: 'github', repo: 'a/b', token: 'x'.repeat(40) });
  assert.equal(ejecutor.status, 409, JSON.stringify(ejecutor.body)); assert.match(ejecutor.body.reason, /measurer/);
  const leer = await admin('GET', '/admin/medidor');
  assert.equal(leer.body.medidor.local, LOCAL_M); assert.equal(leer.body.medidor.enabled, true);
  assert.equal(JSON.stringify(leer.body).includes(deBoveda.sigPriv), false);
});

test('los textos son los aprobados: el código sirve exactamente lo sellado en docs/aprobados', { timeout: 60_000 }, () => {
  const doc = JSON.parse(fs.readFileSync(path.join(raiz, 'docs/aprobados/medidor-textos.json'), 'utf8'));
  const sha = fs.readFileSync(path.join(raiz, 'docs/aprobados/medidor-textos.sha256'), 'utf8').split(/\s+/)[0];
  assert.equal(sha256hex(canonical(doc.textos)), sha, 'el archivo aprobado no cambió');
  for (const lang of ['es', 'en']) {
    assert.deepEqual(Object.keys(TEXTOS[lang]).sort(), Object.keys(doc.textos[lang]).sort(), `${lang}: ni un texto de más ni de menos`);
    for (const [k, v] of Object.entries(TEXTOS[lang])) assert.equal(typeof v === 'function' ? v(...doc.muestras[k]) : v, doc.textos[lang][k], `${lang}.${k}`);
  }
});

test('el recorrido: pide, recibe UNA respuesta firmada y cifrada con la ficha, y el acta queda sellada y se verifica', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  const t0 = Date.now();
  const pedido = await nicholas.send({ to: MEDIDOR, body: 'Por favor mide santander.cl, sector banca.' });
  const [r, ...otras] = await respuestasA(nicholas, pedido.id);
  assert.ok(r, 'llegó la respuesta');
  await espera(300);
  assert.equal((await respuestasA(nicholas, pedido.id, { timeoutMs: 0 })).length, 1, 'medición rápida: una sola respuesta, sin acuse');
  assert.equal(otras.length, 0);
  assert.ok(Date.now() - t0 < 5000, `tardó ${Date.now() - t0} ms`);
  assert.equal(r.encrypted, true, 'la ficha viaja cifrada');
  assert.equal(r.sender.address, MEDIDOR); assert.equal(r.sender.custody.via, 'medidor', 'firmada con la llave del medidor');
  assert.equal(r.thread, pedido.thread || pedido.id, 'en el hilo del pedido');
  const texto = r.content.body;
  assert.match(texto, /^Medición de santander\.cl · sector banca\nNota Q-Ready: B \(QREADY-NOTA-2\.1\) · QEX 61\/100 \(QEX-1\.2\)/);
  assert.ok(texto.includes(fichaDe('santander.cl')), 'la ficha va tal cual');
  // El acta: su sha256 canónico es el hash sellado, y el sello verifica con la llave de la casa.
  const acta = JSON.parse(texto.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(acta.acta, MARCA_ACTA); assert.equal(acta.dominio, 'santander.cl'); assert.equal(acta.pedido.sobre, pedido.id);
  assert.equal(acta.pedido.de, nicholas.address);
  assert.equal(acta.ficha_markdown_sha256, sha256hex(fichaDe('santander.cl')));
  const sha = sha256hex(canonical(acta));
  assert.ok(texto.includes(`sha256 del acta: ${sha}`));
  assert.ok(texto.includes(`${URL_CASA}/notaria/${sha}`));
  const publico = await fetch(`${URL_CASA}/notaria/${sha}`).then((x) => x.json());
  assert.equal(publico.seals.length, 1);
  const sello = publico.seals[0];
  assert.equal(sello.by, MEDIDOR); assert.equal(sello.sha256, sha);
  const kid = (await fetch(`${URL_CASA}/.well-known/nyx5.json`).then((x) => x.json())).keys.map((k) => k.sig);
  assert.ok(kid.includes(sello.signature.kid) && verifyObject(sello, sello.signature.kid), 'el sello lo firmó la casa');
  assert.equal(JSON.stringify(publico).includes('santander'), false, 'el dominio del cliente NO se publica en la notaría');
  const enMensaje = JSON.parse([...texto.matchAll(/```json\n([\s\S]*?)\n```/g)][1][1]);
  assert.equal(enMensaje.id, sello.id, 'el sello viaja también en el mensaje');
  // El instrumento se llamó UNA vez, a la URL configurada, con el dominio en el CUERPO.
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, ROSETTA);
  assert.deepEqual([llamadas[0].body.dominio, llamadas[0].body.sector], ['santander.cl', 'banca']);
  // El pedido y el recibo de la notaría quedaron confirmados: el buzón no acumula.
  assert.equal(await pendienteEnRosetta(pedido.id), false, 'el pedido se confirmó');
  await espera(400);
  const deLibro = (await casa.store.listMail(LOCAL_M)).filter((m) => m.envelope.from === `libro@${H}`);
  assert.equal(deLibro.length, 0, 'el recibo de la notaría que causó el medidor se confirma');
  assert.equal(llamadasApi, 0, 'no se llamó a la API de Anthropic');
});

test('si tarda: primero «midiendo…» y después la ficha, en el mismo hilo', { timeout: 60_000 }, async () => {
  guion.push(async (url, body) => { await espera(800); return responder(200, okDe(body)); });
  const pedido = await nicholas.send({ to: MEDIDOR, body: 'mide bci.cl, sector banca' });
  const rs = await respuestasA(nicholas, pedido.id, { cuantas: 2 });
  assert.equal(rs.length, 2);
  assert.equal(rs[0].content.body, TEXTOS.es.acuse('bci.cl', 'banca'));
  assert.match(rs[1].content.body, /^Medición de bci\.cl/);
});

test('el acuse se cuenta desde que el pedido LLEGÓ: si esperó más que el umbral, «Recibido…» sale antes que la ficha aunque la medición sea rápida', { timeout: 60_000 }, async () => {
  // Medido en producción el 24-nov: el reloj tomaba el pedido 25 s después de llegado, medía en 3 s y
  // el acuse no salía nunca. Aquí el pedido espera 700 ms (umbral 300) y la medición tarda 150 ms.
  casa.medidor.enabled = false;
  const p = await nicholas.send({ to: MEDIDOR, body: 'mide copec.cl, sector energia' });
  for (let i = 0; i < 50 && !(await pendienteEnRosetta(p.id)); i++) await espera(50);
  await espera(700);
  guion.push(async (url, body) => { await espera(150); return responder(200, okDe(body)); });
  casa.medidor.enabled = true;
  await atenderMedidor(casa);
  const rs = await respuestasA(nicholas, p.id, { cuantas: 2 });
  assert.equal(rs.length, 2, 'acuse y ficha');
  assert.equal(rs[0].content.body, TEXTOS.es.acuse('copec.cl', 'energia'));
  assert.match(rs[1].content.body, /^Medición de copec\.cl/);
});

test('el medidor corre antes que el resto del tick: contesta aunque el índice se cuelgue', { timeout: 60_000 }, async () => {
  // Medido en producción el 24-nov: con el medidor al final del tick, el de la petición nunca llegaba
  // a él. Aquí el rastreo del índice no termina nunca y el pedido igual se contesta en segundos.
  const indice = casa.index.enabled, rastreo = casa._indexCrawlIfDue;
  casa.index.enabled = true;
  casa._indexCrawlIfDue = () => new Promise(() => {});
  try {
    const t0 = Date.now();
    const p = await nicholas.send({ to: MEDIDOR, body: 'mide enap.cl, sector energia' });
    const [r] = await respuestasA(nicholas, p.id, { timeoutMs: 5000 });
    assert.ok(r, 'contestó con el índice colgado');
    assert.match(r.content.body, /^Medición de enap\.cl/);
    assert.ok(Date.now() - t0 < 5000);
  } finally { casa.index.enabled = indice; casa._indexCrawlIfDue = rastreo; }
});

test('nunca silencio: un 503 avisa y reintenta, y un desafío del borde prueba la URL de respaldo', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  guion.push(() => responder(503, { ok: false }), () => responder(503, { ok: false }));
  const pedido = await nicholas.send({ to: MEDIDOR, body: 'mide falabella.com, sector retail' });
  const rs = await respuestasA(nicholas, pedido.id, { cuantas: 2 });
  assert.match(rs[0].content.body, /^El instrumento de Rosetta no respondió \(respondió 503; respondió 503\)\. Reintento en menos de un minuto \(intento 2 de 3\)\.$/);
  assert.match(rs[1].content.body, /^Medición de falabella\.com · sector retail/);
  llamadas.length = 0;
  guion.push(() => responder(403, '<html>challenge</html>', { 'cf-mitigated': 'challenge' }));
  const p2 = await nicholas.send({ to: MEDIDOR, body: 'mide entel.cl, sector telecom' });
  const [r2] = await respuestasA(nicholas, p2.id);
  assert.match(r2.content.body, /^Medición de entel\.cl/);
  assert.deepEqual(llamadas.map((l) => l.url), [ROSETTA, RESPALDO], 'el desafío del borde cae al respaldo');
  // Si los dos orígenes responden con el desafío, el aviso lo nombra (no «respondió 403» a secas).
  const desafio = () => responder(403, { ok: false }, { 'cf-mitigated': 'challenge' });
  guion.push(desafio, desafio);
  const p3 = await nicholas.send({ to: MEDIDOR, body: 'mide wom.cl, sector telecom' });
  const rs3 = await respuestasA(nicholas, p3.id, { cuantas: 2 });
  assert.match(rs3[0].content.body, /\(el borde pidió un desafío; el borde pidió un desafío\)/);
});

test('un error de Rosetta vuelve en palabras, sin sello; tres fallas cierran con el motivo', { timeout: 60_000 }, async () => {
  guion.push(() => responder(400, { ok: false, error: 'Sector desconocido. Use uno de: banca.' }));
  const p1 = await nicholas.send({ to: MEDIDOR, body: { dominio: 'ejemplo.cl', sector: 'banca' } });
  const [r1] = await respuestasA(nicholas, p1.id);
  assert.equal(r1.content.body, TEXTOS.es.fallo('ejemplo.cl', 'Sector desconocido. Use uno de: banca.'));
  assert.equal(await pendienteEnRosetta(p1.id), false);
  for (let i = 0; i < 6; i++) guion.push(() => { throw new TypeError('fetch failed'); });
  const p2 = await nicholas.send({ to: MEDIDOR, body: 'mide caido.cl, sector banca' });
  const rs = await respuestasA(nicholas, p2.id, { cuantas: 2, timeoutMs: 10_000 });
  assert.match(rs[0].content.body, /^El instrumento de Rosetta no respondió \(error de red; error de red\)/);
  assert.equal(rs[1].content.body, TEXTOS.es.fallo('caido.cl', 'error de red; error de red'));
  assert.equal(await pendienteEnRosetta(p2.id), false, 'cerrado tras el último intento');
  guion.length = 0;
});

test('falta el sector o el dominio no es válido: se dice, sin medir', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  const p1 = await nicholas.send({ to: MEDIDOR, body: 'mide nuevo.cl' });
  const [r1] = await respuestasA(nicholas, p1.id);
  assert.equal(r1.content.body, TEXTOS.es.falta_sector('nuevo.cl'), 'sin sector y sin una medición anterior de ese dominio');
  const p2 = await nicholas.send({ to: MEDIDOR, body: { dominio: '127.0.0.1', sector: 'banca' } });
  const [r2] = await respuestasA(nicholas, p2.id);
  assert.equal(r2.content.body, TEXTOS.es.dominio_invalido('127.0.0.1'));
  assert.deepEqual(llamadas.filter((l) => ['nuevo.cl', '127.0.0.1'].includes(l.body.dominio)), [], 'ni una llamada al instrumento por estos pedidos');
  assert.equal(llamadas.length, 0, `llamadas sueltas: ${JSON.stringify(llamadas.map((l) => l.body.dominio || l.body.params?.name))}`);
});

test('lo que no es un pedido queda para quien lea el buzón: ni se contesta ni se confirma; la ayuda va una vez', { timeout: 60_000 }, async () => {
  const charla = await colega.send({ to: MEDIDOR, body: 'hola, ¿cómo va el informe del lunes?' });
  const ayuda = await colega.send({ to: MEDIDOR, body: 'necesito una medición, ¿qué haces?' });
  const [r] = await respuestasA(colega, ayuda.id);
  assert.equal(r.content.body, TEXTOS.es.ayuda(MEDIDOR));
  await espera(600);
  assert.equal((await respuestasA(colega, charla.id, { timeoutMs: 0 })).length, 0, 'la charla no se contesta');
  assert.equal((await respuestasA(colega, ayuda.id, { timeoutMs: 0 })).length, 1, 'la ayuda va UNA vez aunque pasen varios relojes');
  assert.equal(await pendienteEnRosetta(charla.id), true, 'la charla sigue pendiente para la otra mente');
  assert.equal(await pendienteEnRosetta(ayuda.id), true, 'el pedido de ayuda también: no es del medidor cerrarlo');
  // Tres ayudas por remitente y día: la cuarta no sale (dos contestadores no se contestan para siempre).
  await casa.store.kvPut(NS_CUPO, `ayuda:${colega.address}:${new Date().toISOString().slice(0, 10)}`, CUPO.ayudaPorRemitenteDia);
  const otra = await colega.send({ to: MEDIDOR, body: '¿qué sabes medir?' });
  await espera(600);
  assert.equal((await respuestasA(colega, otra.id, { timeoutMs: 0 })).length, 0, 'sobre el cupo de ayudas no se contesta');
});

test('a un desconocido no se le contesta ni se le mide: ni con un intro ni con un sobre firmado que entró sin estar en la lista', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  const intro = await extrano.send({ to: MEDIDOR, type: 'intro', body: 'mide santander.cl, sector banca' });
  // Lo que entra a un buzón por lista sin estar en ella (un aval, §9): firmado y verificado, pero la lista no lo eligió.
  const colado = signObject({ nyx5: '1', id: randomUUID(), from: extrano.address, to: [MEDIDOR], created: new Date().toISOString(), expires: null,
    thread: null, in_reply_to: null, type: 'message', content: { media: 'text/plain', body: 'mide santander.cl, sector banca' } }, extrano.keys);
  await casa.store.putMail(LOCAL_M, colado, { from_verified: true });
  await espera(800);
  assert.equal((await respuestasA(extrano, intro.id, { timeoutMs: 0 })).length, 0);
  assert.equal((await respuestasA(extrano, colado.id, { timeoutMs: 0 })).length, 0);
  assert.equal(llamadas.length, 0, 'no se midió nada');
  assert.equal(await pendienteEnRosetta(colado.id), true, 'queda para quien lea el buzón');
});

test('cupo por remitente y día: el que se pasa recibe el motivo y no se mide', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  const dia = new Date().toISOString().slice(0, 10);
  await casa.store.kvPut(NS_CUPO, `${colega.address}:${dia}`, CUPO.porRemitenteDia);
  const p = await colega.send({ to: MEDIDOR, body: 'mide santander.cl, sector banca' });
  const [r] = await respuestasA(colega, p.id);
  assert.equal(r.content.body, TEXTOS.es.limite(CUPO.porRemitenteDia));
  assert.equal(llamadas.length, 0);
  await casa.store.kvDelete(NS_CUPO, `${colega.address}:${dia}`);
});

test('dos relojes a la vez: una medición y una respuesta', { timeout: 60_000 }, async () => {
  casa.medidor.enabled = false;
  const p = await nicholas.send({ to: MEDIDOR, body: 'mide itau.cl, sector banca' });
  for (let i = 0; i < 50 && !(await pendienteEnRosetta(p.id)); i++) await espera(50);
  llamadas.length = 0;
  casa.medidor.enabled = true;
  await Promise.all([atenderMedidor(casa), atenderMedidor(casa), atenderMedidor(casa, { programado: false })]);
  await espera(400);
  assert.equal(llamadas.filter((l) => l.body.dominio === 'itau.cl').length, 1, 'una sola medición');
  assert.equal((await respuestasA(nicholas, p.id, { timeoutMs: 0 })).length, 1, 'una sola respuesta');
});

test('segundo acto: inicia la verificación por el MCP de Rosetta y devuelve el TXT; después la comprueba', { timeout: 60_000 }, async () => {
  llamadas.length = 0;
  const token = 'a'.repeat(64);
  guion.push((url, body) => responder(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, token, dominio: body.params.arguments.dominio, txt: { nombre: '_qready.santander.cl', tipo: 'TXT', valor: `qready-verificacion=${token}` }, caduca_utc: '2026-11-27T12:00:00.000Z' }) }] } }));
  const p1 = await nicholas.send({ to: MEDIDOR, body: 'Ahora inicia la verificación de santander.cl' });
  const [r1] = await respuestasA(nicholas, p1.id);
  assert.equal(r1.content.body, TEXTOS.es.verificar_inicio({ dominio: 'santander.cl', sector: 'banca', nombre: '_qready.santander.cl', tipo: 'TXT', valor: `qready-verificacion=${token}`, caduca: '2026-11-27 12:00' }),
    'el sector se toma de la medición anterior del mismo remitente');
  const mcp = () => llamadas.filter((l) => l.url.endsWith('/mcp'));
  assert.equal(mcp()[0].url, 'https://rosetta.example/mcp');
  assert.deepEqual(mcp()[0].body.params, { name: 'iniciar_verificacion', arguments: { dominio: 'santander.cl', sector: 'banca', publico: false, idioma: 'es' } });
  guion.push(() => responder(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, estado: 'ausente', verificado: false }) }] } }));
  const p2 = await nicholas.send({ to: MEDIDOR, body: 'comprueba la verificación de santander.cl' });
  const [r2] = await respuestasA(nicholas, p2.id);
  assert.equal(r2.content.body, TEXTOS.es.verificar_ausente('santander.cl'));
  assert.deepEqual(mcp()[1].body.params, { name: 'verificar_dominio', arguments: { token, idioma: 'es' } });
  const p3 = await colega.send({ to: MEDIDOR, body: 'comprueba la verificación de santander.cl' });
  const [r3] = await respuestasA(colega, p3.id);
  assert.equal(r3.content.body, TEXTOS.es.verificar_sin_token('santander.cl'), 'el token es de quien la inició');
  guion.push(() => responder(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Demasiados pedidos seguidos. Espere un minuto.' }) }] } }));
  const p4 = await nicholas.send({ to: MEDIDOR, body: 'inicia la verificación de bci.cl, sector banca' });
  const [r4] = await respuestasA(nicholas, p4.id);
  assert.equal(r4.content.body, TEXTOS.es.verificar_fallo('bci.cl', 'Demasiados pedidos seguidos. Espere un minuto.'));
});

test('el límite es de código: sin API de Anthropic, sin Libro salvo la notaría, y la red sólo por la lista cerrada', { timeout: 60_000 }, () => {
  const fuente = fs.readFileSync(path.join(raiz, 'src/correo/medidor.js'), 'utf8');
  const codigo = fuente.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const imports = [...codigo.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../nucleo/crypto.js', './politica.js', './resolver.js'], 'nada que hable con la API ni con el Libro por dentro');
  assert.equal(/anthropic/i.test(codigo), false);
  // Del agente sólo usa: open, send y notarize (la única op del Libro, por sobre firmado).
  const delAgente = new Set([...codigo.matchAll(/\ba\.(\w+)\(/g)].map((m) => m[1]));
  assert.deepEqual([...delAgente].sort(), ['notarize', 'open', 'send']);
  // Toda llamada de red sale de `f(`, que es est.medidor.fetchImpl || est.fetch, y la URL sale de est.medidor.urls.
  assert.equal((codigo.match(/\bfetch\(/g) || []).length, 0, 'ningún fetch suelto');
  assert.equal((codigo.match(/= await f\(url,/g) || []).length, 2);
  assert.equal((codigo.match(/for \(const (url|base) of est\.medidor\.urls\)/g) || []).length, 2);
});
