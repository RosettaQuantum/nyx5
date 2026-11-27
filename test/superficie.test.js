// node --test test/
// La superficie pública del sitio: lo que ve un navegador, un rastreador y quien comparte un
// enlace. Nació de una auditoría externa que encontró cinco cosas rotas a la vez — HEAD daba 404
// (rompe las vistas previas de enlaces y los monitores de uptime), no había una sola cabecera de
// seguridad, ni caché, ni favicon, ni sitemap. Ninguna de ellas rompe una prueba de dominio: solo
// se ven desde fuera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = fs.readFileSync(path.join(raiz, 'src/plataformas/worker.js'), 'utf8');
const estafeta = fs.readFileSync(path.join(raiz, 'src/correo/estafeta.js'), 'utf8');

test('HEAD se atiende como GET y vuelve sin cuerpo', () => {
  assert.match(worker, /const esHead = request\.method === 'HEAD'/);
  assert.match(worker, /method: esHead \? 'GET' : request\.method/, 'HEAD debe entrar por la misma ruta que GET');
  assert.match(worker, /esHead \? null : cuerpo/, 'una respuesta a HEAD no lleva cuerpo');
});

test('toda respuesta lleva las cabeceras de seguridad, no solo algunas', () => {
  for (const h of ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy']) {
    assert.match(worker, new RegExp(`'${h}'`), `falta la cabecera ${h}`);
  }
  // Se aplican en la única puerta de salida: repartidas por ruta, alguna se queda fuera y no se nota.
  assert.match(worker, /\.\.\.SEGURIDAD,/);
  assert.match(worker, /nosniff/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test('lo autenticado no se cachea nunca, y lo público sí', () => {
  const m = worker.match(/function cacheDe\([\s\S]*?\n\}/);
  assert.ok(m, 'falta la política de caché');
  const fn = m[0];
  assert.match(fn, /return 'no-store'/, 'lo que no es GET/HEAD no se cachea');
  assert.match(fn, /\/\.well-known\/nyx5\.json/, 'la tarjeta del dominio es estable y se cachea');
  // Un buzón o el Libro compartidos entre dos agentes sería una fuga: deben caer al no-store final.
  for (const ruta of ['/mailbox/x', '/libro/cuenta/a@b', '/outbox/x']) {
    assert.ok(!new RegExp(`'${ruta}'`).test(fn), `${ruta} no puede aparecer como cacheable`);
  }
});

test('el sitio responde lo que un navegador y un rastreador piden siempre', () => {
  assert.match(estafeta, /path === '\/favicon\.ico'/, 'sin favicon el navegador se lleva un 404 en cada visita');
  assert.match(estafeta, /path === '\/robots\.txt'/);
  assert.match(estafeta, /path === '\/sitemap\.xml'/);
  // robots debe apuntar al sitemap y cerrar lo que exige firma.
  assert.match(estafeta, /Sitemap: https:\/\/\$\{this\.domain\}\/sitemap\.xml/);
  for (const priv of ['/mailbox/', '/libro/', '/outbox/']) assert.match(estafeta, new RegExp(`Disallow: ${priv}`));
});

test('la tarjeta del dominio se firma una vez, no en cada arranque', () => {
  // El defecto: cada instancia del Worker firmaba la suya, así que el mismo contenido salía con
  // otro `issued` y otra firma según a qué instancia cayeras. Ahora se compara el contenido.
  assert.match(estafeta, /const guardada = rec\.card/);
  assert.match(estafeta, /canonical\(previo\) === canonical\(cuerpo\)/, 'debe comparar el contenido sin issued ni firma');
  assert.match(estafeta, /await this\.store\.putDomain\(\{ \.\.\.rec, card \}\)/, 'la tarjeta firmada se persiste');
  assert.match(estafeta, /no se pudo guardar la tarjeta del dominio/, 'si no se puede guardar, se sirve igual');
});

test('el endpoint de trabajo habla inglés, y lo español que queda es solo compatibilidad', () => {
  const i = estafeta.indexOf("path === '/tareas'");
  // El bloque llega hasta la ruta siguiente, no hasta un número fijo de caracteres. Antes cortaba
  // a los 1400 y bastó agregarle un comentario al handler para que los campos en inglés quedaran
  // fuera de la ventana: la prueba fallaba sin que nada de lo que vigila hubiera cambiado.
  const sig = estafeta.indexOf("\n      if (rx.method ===", i);
  const bloque = estafeta.slice(i, sig > i ? sig : i + 1400);
  // Los campos que un cliente NUEVO lee van en inglés.
  for (const en of ['desk,', 'arbiter,', 'per_agent_per_day:', 'how:', 'tasks: publicadas']) {
    assert.ok(bloque.includes(en), `falta el campo ${en}`);
  }
  // Los nombres viejos pueden quedarse, pero SOLO declarados como obsoletos: si alguien añade
  // un campo en español sin marcarlo, esto lo caza.
  const espanoles = ['mostrador', 'arbitro', 'tareas:'];
  for (const es of espanoles) {
    if (!bloque.includes(es)) continue;
    assert.match(bloque, /_deprecated: \['mostrador', 'arbitro', 'tareas'\]/, `"${es}" sigue ahí sin declararse obsoleto`);
  }
  // Y el texto explicativo, que es lo que de verdad lee un agente, va en inglés.
  assert.ok(!/cotiza la tarea|el mostrador|el árbitro/.test(bloque), 'la explicación quedó en español');
});

// La spec se renderiza desde markdown con un conversor propio. Dos defectos que una auditoría
// externa encontró y ninguna prueba veía: una celda de tabla partida por un `\|` escapado, y una
// lista numerada que se reiniciaba en 1 porque un bloque de código la cortaba en dos. En un
// documento con pasos ordenados, una numeración que vuelve a empezar dice algo falso.
test('el conversor respeta los pipes escapados y no parte las listas numeradas', async () => {
  const { SPEC_HTML } = await import('../src/plataformas/spec-html.js');
  // La celda con alternancia queda entera, sin backticks a la vista ni celdas de más.
  const fila = SPEC_HTML.match(/<tr><td>escrow<\/td>.*?<\/tr>/s);
  assert.ok(fila, 'falta la fila escrow de la tabla de contratos');
  assert.equal((fila[0].match(/<td>/g) || []).length, 3, 'la celda con `\\|` se partió en dos');
  assert.match(fila[0], /held → delivered → released \| refunded/);
  assert.ok(!/`/.test(fila[0]), 'quedaron backticks literales en la tabla');
  // La lista de descubrimiento es UNA sola, con sus tres pasos.
  const i = SPEC_HTML.indexOf('discovery-and-trust-anchor');
  const seccion = SPEC_HTML.slice(i, SPEC_HTML.indexOf('<h2', i + 10));
  assert.equal((seccion.match(/<ol/g) || []).length, 1, 'la lista numerada se partió en varias');
  assert.equal((seccion.match(/<li>/g) || []).length, 3);
});

test('ninguna referencia cruzada de la spec apunta a una sección que no existe', () => {
  const md = fs.readFileSync(path.join(raiz, 'docs/SPEC.md'), 'utf8');
  const existen = new Set([...md.matchAll(/^## (\d+)[.b]/gm)].map((m) => Number(m[1])));
  assert.ok(existen.size > 20, `se esperaban las secciones de la spec, se vieron ${existen.size}`);
  const rotas = [];
  for (const m of md.matchAll(/sections? (\d+)(?: to (\d+))?/g)) {
    for (const n of [m[1], m[2]]) if (n && !existen.has(Number(n))) rotas.push(`"${m[0]}" apunta a §${n}, que no existe`);
  }
  assert.deepEqual(rotas, [], rotas.join('\n  '));
});

// Un enlace compartido sin imagen se ve pelado y convierte peor. La imagen se genera y se sirve
// desde la casa, no desde un CDN: si dependiera de un tercero, el día que ese tercero falle el
// enlace se comparte roto y nadie se entera.
test('la vista previa al compartir está completa y la imagen la sirve la casa', async () => {
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  const { SPEC_HTML } = await import('../src/plataformas/spec-html.js');
  for (const [nombre, h] of [['portada', HOME_HTML], ['spec', SPEC_HTML]]) {
    for (const etiqueta of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'twitter:image']) {
      assert.ok(h.includes(etiqueta), `${nombre} no declara ${etiqueta}`);
    }
    assert.match(h, /content="https:\/\/nyx5\.com\/og\.png"/, `${nombre} debe servir la imagen desde la casa`);
    assert.match(h, /twitter:card" content="summary_large_image"/);
  }
  // Y la casa la sirve de verdad, como PNG del tamaño que declara.
  const { OG_PNG_B64 } = await import('../src/plataformas/og-png.js');
  const png = Buffer.from(OG_PNG_B64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'no es un PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.match(estafeta, /path === '\/og\.png'/, 'la casa debe servir la imagen');
});

// La portada muestra cuántos agentes hay y cuánto trabajo está abierto, leído del libro en el
// momento. Convierte mejor que una promesa, pero solo si es verdad: un número inventado se
// vería igual y sería mentira. Y si no se puede leer, la línea desaparece en vez de tumbar
// la portada por un adorno.
test('la prueba de vida de la portada sale del libro y no rompe si falla', async () => {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const os = await import('node:os');
  const P2 = 4164;
  const casa = new Estafeta({
    domain: 'v2.test', port: P2, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-vivo-')),
    adminToken: 't', hosts: { 'v2.test': { url: `http://127.0.0.1:${P2}` } }, workerIntervalMs: 5000,
    policy: { registration: 'open' }, log: () => {},
  });
  await casa.start();
  try {
    // La portada cachea el conteo 60 s (lee una tarjeta por agente y es la página más visitada),
    // así que aquí se vacía la caché a mano antes de cada lectura: sin esto la prueba mediría la
    // caché y no la regla, y pasaría igual con la regla rota.
    const leer = async () => { casa._listados = { t: 0, n: 0 }; return (await casa.handleRequest({ method: 'GET', path: '/', query: new URLSearchParams(), headers: {}, body: null })).body; };
    // `handleRequest` devuelve el cuerpo ya como objeto en las rutas JSON, no como texto.
    const cuantosPublica = async () => (await casa.handleRequest({ method: 'GET', path: '/agents', query: new URLSearchParams(), headers: {}, body: null })).body.total;
    // LA PROPIEDAD, y es la única que hace que el número valga algo: la portada dice EXACTAMENTE
    // lo que el lector puede contar él mismo en el directorio público. Se comprueba en cada paso,
    // no una vez: un número público que nadie puede verificar no es prueba de vida, es una
    // afirmación — y aquí una afirmación cuesta algo.
    const concuerdan = async (nota) => {
      const n = await cuantosPublica();
      assert.match(await leer(), new RegExp(`<b>${n}</b> agent${n === 1 ? '\\b' : 's'} in this house`), nota);
      return n;
    };
    await concuerdan('al arrancar');
    assert.ok(!/<!--VIVO-->/.test(await leer()), 'el hueco debe quedar sustituido siempre');
    const { join } = await import('../src/correo/unirse.js');
    // EL DEFECTO, tal como estaba vivo en producción: figurar en el directorio es opt-in, pero la
    // portada contaba REGISTROS. Por eso la casa anunciaba 135 agentes mientras su propio
    // directorio publicaba 14, y el número subía solo +1 cada día con el canario de CI — era, en
    // su mayor parte, un contador de nuestros propios despliegues. Antes del arreglo esta alta
    // movía el número; ahora no lo mueve, porque este agente no pidió aparecer.
    const antes = await cuantosPublica();
    await join({ house: 'v2.test', hosts: { 'v2.test': { url: `http://127.0.0.1:${P2}` } }, name: 'callado' });
    assert.equal(await cuantosPublica(), antes, 'quien no pide figurar no entra al directorio');
    await concuerdan('quien no pidió figurar no se anuncia en la portada');
    // Y con uno que SÍ lo pidió: sube de a uno, y concuerda en singular o plural — un contador
    // que dice "1 agents" delata que es de adorno.
    await join({ house: 'v2.test', hosts: { 'v2.test': { url: `http://127.0.0.1:${P2}` } }, name: 'visible', listed: true });
    assert.equal(await cuantosPublica(), antes + 1, 'quien lo pide sí entra');
    await concuerdan('y la portada lo refleja');
    // Si el almacén falla, la portada se sirve igual y sin la línea.
    const original = casa.store.listAgents.bind(casa.store);
    casa.store.listAgents = async () => { throw new Error('almacén caído'); };
    const rota = await leer();
    assert.match(rota, /Give your agent an address/, 'la portada se sirve aunque el libro no responda');
    assert.ok(!/agent in this house/.test(rota), 'sin datos, no se inventa la línea');
    casa.store.listAgents = original;
  } finally { await casa.stop(); }
});

// www existe como registro y redirige al apex con 301. Dos orígenes sirviendo el mismo contenido
// parten el caché y confunden a los rastreadores; y sin el registro, quien teclea o pega
// "www.nyx5.com" llegaba a NXDOMAIN.
test('www redirige al apex y no sirve contenido propio', () => {
  assert.match(worker, /url\.hostname\.startsWith\('www\.'\)/);
  assert.match(worker, /status: 301/, 'la redirección debe ser permanente, no temporal');
  assert.match(worker, /destino\.hostname = url\.hostname\.slice\(4\)/);
  assert.match(worker, /destino\.protocol = 'https:'/, 'la redirección va siempre a https');
  // Y la ruta tiene que estar declarada, o el hostname no llega nunca al Worker.
  const wrangler = fs.readFileSync(path.join(raiz, 'wrangler.toml'), 'utf8');
  assert.match(wrangler, /pattern = "www\.nyx5\.com"/);
});

// La app web es la única superficie que un HUMANO usa con las manos, y se quedó en español
// cuando todo lo demás pasó a inglés: se sirve desde el mismo dominio y nadie la miraba porque
// no la toca ninguna prueba de dominio.
test('la app web está en inglés y hace lo que promete', async () => {
  const { APP_HTML } = await import('../src/plataformas/app-html.js');
  assert.match(APP_HTML, /<html lang="en">/);
  // Se busca en TODO el documento, no solo entre etiquetas: la primera versión de este guard
  // miraba el texto visible y dejó pasar tres cadenas que viven en atributos y dentro del guion,
  // que es exactamente donde están los mensajes que ve el usuario cuando algo falla.
  const conEspanol = [...APP_HTML.matchAll(/[^<>"'\n]*[áéíóúñ¿¡][^<>"'\n]*/g)].map((m) => m[0].trim()).filter(Boolean);
  assert.deepEqual(conEspanol, [], `la app muestra texto en español:\n  ${conEspanol.join('\n  ')}`);
  // Y sigue siendo la app: crea una dirección y manda un mensaje firmado.
  assert.match(APP_HTML, /Create my address/);
  assert.match(APP_HTML, /Your agent address/);
  assert.match(APP_HTML, /nyx5:\s*'1'/, 'debe hablar la versión del protocolo');
  assert.match(APP_HTML, /'Nyx5 '/, 'debe autenticarse con el esquema del protocolo');
  // Los ejemplos también son texto que se lee: "tunombre" y el nombre de una persona concreta
  // pasaban el filtro de tildes y quedaban a la vista de cualquiera que abriera la app.
  for (const rastro of ['tunombre', 'pauli', 'Escribe', 'dirección']) {
    assert.ok(!APP_HTML.includes(rastro), `la app conserva "${rastro}"`);
  }
  assert.match(APP_HTML, /yourname/, 'el ejemplo del campo debe ser genérico y en inglés');
});

// La consola nació en español a propósito (18-nov-2026): es la pantalla que mira Nicholas desde
// el celular. Él decidió ese mismo día pasarla a inglés, por la misma razón que la app: se sirve
// del dominio público y cualquiera con una sesión la abre. Este guardia es el de la app, con una
// diferencia que importa: la mitad de las frases de esta pantalla viven DENTRO del guion (las
// cifras, el aviso de sesión vencida, el pie), así que un barrido del texto visible no vería casi
// nada. Se busca en todo el documento.
test('la consola está en inglés y sigue siendo el tablero', async () => {
  const { CONSOLA_HTML } = await import('../src/plataformas/consola-html.js');
  assert.match(CONSOLA_HTML, /<html lang="en">/);
  // Los NOMBRES DE CAMPO que manda la casa (`d.abiertos`, `d.te_necesitan`, `f.atascado`) están en
  // español y seguirán estándolo: son el contrato de `/consola/datos`, y un nombre de campo no lo
  // lee ninguna persona. Se quitan antes de mirar, o este guardia obligaría a renombrar la API
  // para arreglar un texto — que es confundir el objeto con el número. Lo descubrió él mismo en su
  // primera corrida, fallando por `d.abiertos`.
  const visible = CONSOLA_HTML.replace(/\.[A-Za-z_$][\w$]*/g, '');
  const conEspanol = [...visible.matchAll(/[^<>"'`\n]*[áéíóúñ¿¡][^<>"'`\n]*/g)].map((m) => m[0].trim()).filter(Boolean);
  assert.deepEqual(conEspanol, [], `la consola muestra texto en español:\n  ${conEspanol.join('\n  ')}`);
  // Las tildes no alcanzan: "Cargando", "abiertos" y "atascados" pasan ese filtro enteras, y son
  // justo las que quedarían si alguien traduce a medias. Cada una de estas estuvo de verdad en la
  // versión que se desplegó, así que la lista se escribe contra el defecto real, no contra un
  // ejemplo inventado.
  for (const rastro of ['Tablero', 'Cargando', 'abiertos', 'atascados', 'pedido por', 'Actualizado', 'se refresca', 'La casa contest', 'sin due']) {
    assert.ok(!visible.includes(rastro), `la consola conserva "${rastro}"`);
  }
  // Y sigue siendo el tablero: las cuatro cifras y la pantalla de sesión, que es lo único que ve
  // quien llega sin token.
  for (const frase of ['>Board<', "'open'", "'need you'", "'signalled'", "'stuck'", 'Your key never leaves your computer', 'nyx5 consola']) {
    assert.ok(CONSOLA_HTML.includes(frase), `la consola perdió "${frase}"`);
  }
});

// El .html se edita y el .js se genera (§6: el HTML no pasa por el contexto de nadie). Nada
// obligaba a regenerarlo: editar el .html y olvidar el script deja la pantalla vieja desplegada
// con el repositorio diciendo que está nueva, que es el modo de fallo de §1 en su forma más
// barata de evitar.
test('el HTML generado es el que está en web/, no una copia vieja', async () => {
  const { CONSOLA_HTML } = await import('../src/plataformas/consola-html.js');
  const fuente = fs.readFileSync(path.join(raiz, 'web/consola.html'), 'utf8');
  assert.equal(CONSOLA_HTML, fuente, 'web/consola.html cambió sin regenerar: node scripts/build-consola-html.mjs');
  const { APP_HTML } = await import('../src/plataformas/app-html.js');
  assert.equal(APP_HTML, fs.readFileSync(path.join(raiz, 'web/app.html'), 'utf8'), 'web/app.html cambió sin regenerar: node scripts/build-app-html.mjs');
});

// Renombrar un campo de una respuesta pública rompe a TODO cliente ya instalado, en silencio:
// el agente ve "no hay tareas" y se va, y ninguna prueba se entera porque el servidor y el
// cliente del repositorio cambiaron a la vez. Pasó de verdad al traducir /tareas al inglés.
test('el endpoint de trabajo sigue sirviendo los nombres viejos junto a los nuevos', async () => {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const os = await import('node:os');
  const P2 = 4165;
  const cat = [{ id: 'x', concept: 'algo', price: 10, verify: { type: 'http_status', url: 'https://x.invalid/' } }];
  const casa = new Estafeta({
    domain: 'c.test', port: P2, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-compat-')),
    adminToken: 't', hosts: { 'c.test': { url: `http://127.0.0.1:${P2}` } }, workerIntervalMs: 9999,
    policy: { registration: 'open' }, tareas: { catalogo: cat }, log: () => {},
  });
  await casa.start();
  try {
    const r = await casa.handleRequest({ method: 'GET', path: '/tareas', query: new URLSearchParams(), headers: {}, body: null });
    const j = r.body;
    // Un cliente viejo (0.4.1 y anteriores) lee estos tres.
    assert.equal(j.mostrador, 'tareas@c.test');
    assert.equal(j.arbitro, 'verifica@c.test');
    assert.equal(j.tareas.length, 1);
    // Uno nuevo lee estos, y ambos apuntan a lo mismo.
    assert.equal(j.desk, j.mostrador);
    assert.equal(j.arbiter, j.arbitro);
    assert.deepEqual(j.tasks, j.tareas);
    // Y la respuesta dice cuáles son los que van a desaparecer, para que se puedan retirar.
    assert.deepEqual(j._deprecated, ['mostrador', 'arbitro', 'tareas']);
  } finally { await casa.stop(); }
});

// El catálogo de trabajo llevaba meses público, en el sitemap, y sólo hablaba JSON: era lo único
// de esta casa que le sirve a un extraño el primer día y no había forma de mirarlo ni compartirlo.
// Ahora la misma URL tiene cara humana. El riesgo de un cambio así es romper, en silencio, a todo
// cliente ya instalado — por eso las dos mitades se prueban juntas: que el JSON no se mueva, y que
// el HTML sólo aparezca cuando alguien lo pide EXPLÍCITAMENTE.
test('/tareas: el agente sigue viendo el mismo JSON y la persona ve el catálogo', async () => {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const os = await import('node:os');
  const P2 = 4183;
  const cat = [{ id: 'x', concept: 'algo medible', price: 10, verify: { type: 'http_status', url: 'https://x.invalid/' } }];
  const casa = new Estafeta({
    domain: 'h.test', port: P2, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-tareas-html-')),
    adminToken: 't', hosts: { 'h.test': { url: `http://127.0.0.1:${P2}` } }, workerIntervalMs: 9999,
    policy: { registration: 'open' }, tareas: { catalogo: cat }, log: () => {},
  });
  await casa.start();
  try {
    const pedir = (accept) => casa.handleRequest({ method: 'GET', path: '/tareas', query: new URLSearchParams(), headers: accept ? { accept } : {}, body: null });
    // SILENCIO. El cliente de Nyx5 no manda `accept` (src/correo/agente.js no la pone), y un
    // cliente que pide json tampoco quiere una página. Las dos siguen recibiendo el objeto.
    for (const a of [null, 'application/json', '*/*']) {
      const r = await pedir(a);
      assert.equal(typeof r.body, 'object', `accept=${a} debe seguir recibiendo JSON`);
      assert.equal(r.body.tasks.length, 1);
      assert.equal(r.body.desk, 'tareas@h.test');
    }
    // GRITO. Un navegador sí la pide, y recibe la página.
    const html = await pedir('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    assert.match(html.contentType, /text\/html/);
    assert.match(html.body, /<!doctype html>/i);
    assert.match(html.body, /1 paid task open at h\.test/, 'el titular cuenta lo que hay, en singular');
    assert.match(html.body, /algo medible/, 'cada tarea publicada aparece');
    assert.match(html.body, /tareas@h\.test/);
    // Y lo que más duele si falla: el comando que la página imprime tiene que EXISTIR. Publicar
    // uno que ninguna superficie sabe ejecutar es el defecto que esta casa ya pagó cinco veces.
    assert.match(html.body, /npx @nyx5\/nyx5 tomar --id x/);
    const cli = fs.readFileSync(path.join(raiz, 'bin/nyx5.js'), 'utf8');
    assert.match(cli, /case 'tomar':/, 'la página promete un comando que el CLI debe tener');
    assert.match(cli, /--id/, 'y con la bandera que la página imprime');
  } finally { await casa.stop(); }
});

// Nació de un defecto medido en producción el 10-sep-2026: la CSP decía `default-src 'none'` sin
// `connect-src`, así que el navegador bloqueaba TODO fetch de /app. La página cargaba perfecta y
// el primer botón fallaba en silencio: nadie podía crear una dirección ni mandar un mensaje, y
// ninguna prueba lo vio porque ninguna leía la CSP junto con lo que la app hace.
test('si la app pide cosas a la casa, la CSP la deja conectarse a la casa', async () => {
  const { APP_HTML } = await import('../src/plataformas/app-html.js');
  const csp = /'content-security-policy':\s*"([^"]+)"/.exec(worker)?.[1];
  assert.ok(csp, 'no encuentro la CSP en el adaptador del edge');
  const directiva = (nombre) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${nombre} `));
  if (/\bfetch\(/.test(APP_HTML)) {
    const conectar = directiva('connect-src') || directiva('default-src');
    assert.ok(conectar && /'self'/.test(conectar), `la app hace fetch y la CSP no lo permite: ${conectar || '(sin connect-src ni default-src)'}`);
  }
  if (/rel="manifest"/.test(APP_HTML)) {
    const m = directiva('manifest-src') || directiva('default-src');
    assert.ok(m && /'self'/.test(m), `la app declara un manifiesto y la CSP no lo deja cargar: ${m}`);
  }
});

// Revisión del 14-sep-2026: una viñeta que seguía en la línea de abajo (indentada, como envuelve el
// editor a 100 columnas) cerraba el <ul> y la continuación salía como <p> suelto, con el `código`
// partido por la mitad: 34 casos en el sitio (§13, §22, §23b, §23c, §23d). El conversor la junta
// como ya hacía con las listas numeradas. Grito: el caso real; silencio: un párrafo tras una lista
// sigue siendo párrafo, y dos viñetas siguen siendo dos.
test('el conversor no parte una viñeta que sigue en la línea de abajo', async () => {
  const { toHtml } = await import('../scripts/build-spec-site.mjs');
  const roto = toHtml(['- **The request** carries `{ kind,', '  currency }` in the clear.', '- Second item.', '', 'A paragraph after the list.'].join('\n'));
  assert.equal((roto.match(/<ul>/g) || []).length, 1, `la lista se partió: ${roto}`);
  assert.equal((roto.match(/<li>/g) || []).length, 2);
  assert.match(roto, /<code>\{ kind, currency \}<\/code> in the clear\.<\/li>/, `el código partido no cerró: ${roto}`);
  assert.ok(!/<\/ul>\s*<p>\s{2}/.test(roto), 'la continuación salió como párrafo');
  assert.match(roto, /<\/ul>\n<p>A paragraph after the list\.<\/p>$/, 'el párrafo de después sigue siendo párrafo');
  // Un bloque de código dentro del ítem no cierra la lista, como en las numeradas.
  const conCodigo = toHtml(['- item', '  ```', '  x', '  ```', '- otro'].join('\n'));
  assert.equal((conCodigo.match(/<ul>/g) || []).length, 1);
  assert.match(conCodigo, /<li>item<pre><code>x<\/code><\/pre><\/li><li>otro<\/li>/);
  // Y en el sitio real no queda ninguna continuación suelta (así se veía el defecto: <p> con dos espacios).
  const { SPEC_HTML } = await import('../src/plataformas/spec-html.js');
  assert.equal((SPEC_HTML.match(/<p>\s{2}/g) || []).length, 0, 'quedan viñetas partidas en el sitio de la spec');
});
