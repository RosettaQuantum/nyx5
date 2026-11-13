// node --test test/
// Las descripciones del conector MCP son lo único que el modelo lee para decidir si usa Nyx5.
// No son documentación: son la capacidad + la garantía + el momento de uso (brief D1).
// Este test es la guardia que impide que vuelvan a ser "documentación de API".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Las herramientas viven en UN módulo que sirven los dos puentes (stdio y remoto por HTTP).
const src = fs.readFileSync(new URL('../src/puentes/herramientas.js', import.meta.url), 'utf8');
// extrae { name, description } de cada herramienta
const tools = [...src.matchAll(/\{ name: '([a-z0-9_]+)', description: '((?:[^'\\]|\\.)*)'/g)]
  .map((m) => ({ name: m[1], description: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') }));

// una garantía del sistema que un modelo no obtiene de otra forma
// Las descriptions las lee un MODELO y ahora van en inglés, como todo lo público. Lo que el
// guard protege no cambia: cada una debe declarar una garantía del sistema (por qué creerle) y
// decir cuándo conviene usarla, no describir el mecanismo.
const GARANTIA = /signed|signature|mailbox|entry|ledger|receipt|held|hold|verif|certif|encrypt|decrypt|irreversible|hash|deny|proof|bond/i;
// palabra que ancla el MOMENTO de uso o la capacidad (no el mecanismo)
const CAPACIDAD = /use it|when you|find|delegate|offer|accept|check it|check|move|even if|do not know|before |take |leave yourself/i;

test('D1 · hay 31 herramientas y ninguna description quedó como la vieja documentación de API', () => {
  assert.equal(tools.length, 31, `se esperaban 31 herramientas, hay ${tools.length}`);
  // ninguna debe empezar describiendo el mecanismo ("Envía un sobre...", "Operación genérica...")
  for (const t of tools) {
    assert.ok(!/^(Envía un sobre|Operación genérica del Libro|Lee los sobres pendientes)/.test(t.description),
      `${t.name} sigue describiendo el mecanismo, no la capacidad`);
  }
});

test('D1 · cada description declara una garantía del sistema', () => {
  for (const t of tools) {
    assert.ok(GARANTIA.test(t.description), `${t.name} no menciona ninguna garantía (firma/buzón/asiento/recibo/retención/verificación/hash)`);
  }
});

test('D1 · cada description nombra el momento de uso o la capacidad, no solo el mecanismo', () => {
  for (const t of tools) {
    assert.ok(CAPACIDAD.test(t.description), `${t.name} no nombra cuándo usarla ni qué desbloquea`);
  }
});

test('D1 · las descripciones son cortas (presupuesto de atención); libro es la única router', () => {
  for (const t of tools) {
    const tope = t.name === 'nyx5_libro' ? 650 : 340; // libro lleva la lista de ops
    assert.ok(t.description.length <= tope, `${t.name}: ${t.description.length} chars supera ${tope}`);
  }
});

test('D1 · instructions describe el sistema en pocas frases con capacidad y garantía, sin listar herramientas', () => {
  const m = src.match(/INSTRUCCIONES = `([^`]*)`/);
  assert.ok(m, 'falta instructions');
  const inst = m[1];
  assert.ok(GARANTIA.test(inst), 'instructions no menciona una garantía');
  assert.ok(CAPACIDAD.test(inst), 'instructions no dice cuándo conviene usarlo');
  assert.ok(!/nyx5_send|nyx5_inbox|tools\/list/.test(inst), 'instructions no debe listar herramientas (eso lo hace tools/list)');
  // Todo lo que lee un modelo va en inglés, igual que el resto de lo público.
  assert.ok(!/[áéíóúñ¿¡]/.test(inst), 'instructions quedó en español');
  for (const t of tools) assert.ok(!/[áéíóúñ¿¡]/.test(t.description), `${t.name} quedó en español`);
  assert.ok(inst.length <= 700, `instructions demasiado largo: ${inst.length}`);
});

// La spec pública en dos idiomas, con el inglés como canónico (decisión de Nicholas, 8-sep-2026).
// El guard existe porque el fallo sería invisible: /es sirviendo inglés se ve igual de bien.
test('la spec y la portada se sirven SOLO en inglés, y no queda rastro del español', async () => {
  const { SPEC_HTML, LLMS_TXT } = await import('../src/plataformas/spec-html.js');
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  for (const [nombre, h] of [['spec', SPEC_HTML], ['portada', HOME_HTML]]) {
    assert.match(h, /<html lang="en">/, `${nombre} debe declararse en inglés`);
    assert.ok(!/hreflang="es"|\/es-home|>Español</.test(h), `${nombre} sigue enlazando a una versión española que ya no existe`);
    assert.ok(!/chasqui/i.test(h), `${nombre} menciona el nombre viejo`);
  }
  assert.match(SPEC_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/spec">/);
  assert.match(HOME_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/">/);
  assert.match(SPEC_HTML, /Mail and Libro for agents/);
  assert.match(SPEC_HTML, /reputation is a query on the ledger/);
  // El JSON-LD tiene que declarar el idioma real, o los rastreadores indexan mal.
  assert.match(SPEC_HTML, /"inLanguage":"en"/);
  assert.ok(!/Especificación \(español\)/.test(LLMS_TXT));
});

test('la portada apunta a que un agente se una', async () => {
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  assert.match(HOME_HTML, /Give your agent an address/);
  const fs = await import('node:fs');
  const cli = fs.readFileSync(new URL('../bin/nyx5.js', import.meta.url), 'utf8');
  const h = HOME_HTML;
  // Cada comando que la portada muestra tiene que existir de verdad. Se comprueba el OBJETO, no la
  // palabra: se leen TODOS los verbos que aparecen (el hero, la terminal de ejemplo, el CTA) y el
  // CLI tiene que implementar cada uno. La propuesta v2 traía `reply` y `open`, que el CLI no tiene.
  const verbos = new Set([...h.matchAll(/npx (?:-y )?@nyx5\/nyx5 ([a-z]+)/g)].map((m) => m[1]));
  assert.ok(verbos.has('join'), 'la portada no muestra el comando para unirse');
  for (const v of verbos) assert.match(cli, new RegExp(`case '${v}':`), `la portada muestra \`${v}\` y el CLI no lo implementa`);
  assert.ok(!/chasqui/i.test(h), 'quedó una mención al nombre viejo');
  // La portada dejó de ser una sola línea (12-nov-2026): lleva la demo de dos agentes y el
  // diccionario ES del botón de idioma, y con eso pesa ~77 KB. 90 KB es ese peso con margen para
  // copy, no para otra sección: si se pasa, algo se está acumulando y conviene mirarlo.
  assert.ok(h.length < 90_000, `la portada pesa ${h.length} bytes: está creciendo`);
  assert.equal((h.match(/<h1/g) || []).length, 1, 'una sola h1');
  assert.match(h, /Give your agent an address tonight\./, 'el CTA final');
  assert.ok(!/\{\{[A-Z]+\}\}/.test(h), 'quedó un hueco sin llenar en la portada');
  // Los números que la portada afirma salen del código, no de la copy.
  const { TOOLS } = await import('../src/puentes/herramientas.js');
  assert.match(h, new RegExp(`${TOOLS.length} MCP tools`), 'el número de herramientas no coincide con el código');
  const bps = /^NYX5_FEE_BPS\s*=\s*"(\d+)"/m.exec(fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'))[1];
  assert.match(h, new RegExp(`house fee: ${Number(bps) / 100}%`), 'la comisión publicada no coincide con NYX5_FEE_BPS');
  assert.match(cli, /case 'join':/, 'el CLI implementa lo que la portada promete');
  assert.match(h, /href="\/spec"/);
});

// La CSP de la casa es `default-src 'none'` con estilo y script sólo inline: una fuente, un script
// o una hoja de estilo de fuera no cargaría y la página se vería rota sin error visible. La
// propuesta v2 traía Geist desde Google Fonts. Y los enlaces propios van relativos, para que la
// misma portada sirva en b.nyx5.com sin mandar al visitante a producción.
test('la portada no carga nada de fuera y enlaza la casa en relativo', async () => {
  const { HOME_HTML: h } = await import('../src/plataformas/home-html.js');
  assert.ok(!/<script[^>]+\ssrc=/i.test(h), 'un <script src> externo');
  assert.ok(!/<link[^>]+rel="(?:stylesheet|preconnect|preload|modulepreload|dns-prefetch)"/i.test(h), 'una hoja, fuente o preconexión externa');
  assert.ok(!/@import|url\(\s*['"]?(?:https?:)?\/\//i.test(h), 'CSS que pide algo de fuera');
  assert.ok(!/\ssrc="(?:https?:)?\/\//i.test(h), 'un src absoluto');
  assert.ok(!/fonts\.(?:googleapis|gstatic)\.com/.test(h), 'Google Fonts');
  assert.ok(!/<a [^>]*href="https:\/\/nyx5\.com/.test(h), 'un enlace absoluto a la casa: debe ser relativo');
});

// Nació de dos roturas idénticas: "the parent's grantee" y "An agent's reputation" dentro de
// comillas simples tiraron el archivo completo. En inglés los apóstrofos aparecen solos.
test('ningún archivo fuente tiene un apóstrofo dentro de comillas simples', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dirs = ['src/correo', 'src/libro', 'src/nucleo', 'src/puentes', 'src/plataformas', 'bin'];
  const malos = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(raiz, d)).filter((x) => x.endsWith('.js') && !x.includes('html'))) {
      const rel = `${d}/${f}`;
      const src = fs.readFileSync(path.join(raiz, rel), 'utf8');
      // Una comilla simple abierta, texto sin comillas, un apóstrofo entre letras, más texto.
      for (const m of src.matchAll(/'[^'\n\\]*[a-zA-Z]'[a-z]/g)) malos.push(`${rel}: …${m[0]}…`);
    }
  }
  assert.deepEqual(malos, [], `apóstrofo dentro de comillas simples:\n  ${malos.join('\n  ')}`);
});

// El resumen EN CLARO llega hasta el puente MCP (29-oct-2026): sin esto, sólo quien usa `Agent.send`
// desde código podría ponerlo, y los que escriben de verdad —el Claude del celular de Nicholas, las
// rutinas— van por aquí. La descripción dice CON TODAS SUS LETRAS que esa línea no va cifrada:
// es lo único que impide que un agente ponga ahí lo que el sobre protege.
test('nyx5_send acepta un resumen en claro, lo dice en su descripción y lo devuelve', async () => {
  const { TOOLS } = await import('../src/puentes/herramientas.js');
  const send = TOOLS.find((h) => h.name === 'nyx5_send');
  const prop = send.inputSchema.properties.summary;
  assert.ok(prop, 'nyx5_send tiene que ofrecer summary');
  assert.match(prop.description, /IN THE CLEAR/, 'la descripción tiene que advertir que no va cifrado');
  assert.match(prop.description, /140/, 'y decir el tope');
  assert.match(prop.description, /never what the envelope protects/, 'y decir qué NO poner ahí');
});

// Lo que el esquema declara obligatorio se COMPRUEBA, no se confía (4-nov-2026). El caso no es
// inventado: es la llamada que hice de verdad contra el paquete publicado, con `text` en vez de
// `body`. El sobre salió, la respuesta dijo `id` y `encrypted: true`, y a nicholas@nyx5.com le
// llegó un sobre sin cuerpo. Un éxito reportado sobre nada es el modo de fallo de esta casa.
test('GRITO · la llamada REAL que mandó un sobre vacío ahora se rechaza, y no sale nada', async () => {
  const { llamar } = await import('../src/puentes/herramientas.js');
  const espia = { enviados: 0, send() { this.enviados++; return { id: 'NO-DEBERIA-SALIR' }; } };
  const r = await llamar(espia, 'nyx5_send', { to: 'nicholas@nyx5.com', text: 'lo que quise mandar', summary: 'prueba' });
  assert.equal(r.isError, true, 'un envío sin cuerpo no es un éxito');
  assert.match(r.content[0].text, /missing required `body`/, 'tiene que decir QUÉ falta: el que erró el nombre no puede adivinarlo');
  assert.match(r.content[0].text, /You passed: to, text, summary/, 'y qué sí recibió, que es lo que delata el nombre equivocado');
  assert.match(r.content[0].text, /Nothing was sent/, 'y que no salió nada, o el agente lo da por entregado');
  assert.equal(espia.enviados, 0, 'se rechaza ANTES de actuar, no después');
  // Un `null` explícito es la otra forma de llegar sin cuerpo, y no la tapa un `undefined`.
  const r2 = await llamar(espia, 'nyx5_send', { to: 'nicholas@nyx5.com', body: null });
  assert.equal(r2.isError, true, 'body: null es una ausencia, no un contenido');
  assert.equal(espia.enviados, 0);
});

test('ninguna de las 31 herramientas actúa sin lo que su propio esquema exige', async () => {
  const { TOOLS, llamar } = await import('../src/puentes/herramientas.js');
  // Un agente que grita si alguien lo toca: la prueba es que no se le llama a NADA.
  const intocable = new Proxy({}, { get: (_, k) => { if (k === 'then') return undefined; return () => { throw new Error(`se llamó a agent.${String(k)} sin los campos obligatorios`); }; } });
  const conObligatorios = TOOLS.filter((t) => (t.inputSchema?.required || []).length);
  assert.ok(conObligatorios.length >= 22, `se esperaban al menos 22 herramientas con obligatorios, hay ${conObligatorios.length}`);
  for (const t of conObligatorios) {
    for (const k of t.inputSchema.required) {
      // todos los obligatorios menos UNO: falta exactamente el que estamos probando
      const args = {};
      for (const otro of t.inputSchema.required) if (otro !== k) args[otro] = 'x';
      const r = await llamar(intocable, t.name, args);
      assert.equal(r.isError, true, `${t.name} actuó sin \`${k}\`, que su esquema declara obligatorio`);
      assert.match(r.content[0].text, new RegExp(`missing required \`${k}\``), `${t.name}: el rechazo no nombra \`${k}\``);
    }
  }
});

test('SILENCIO · con los campos completos no se estorba: la herramienta actúa', async () => {
  const { llamar } = await import('../src/puentes/herramientas.js');
  const espia = { vistos: null, send(a) { this.vistos = a; return { id: 'ok-1', encrypted: true, envelope: {} }; } };
  const r = await llamar(espia, 'nyx5_send', { to: 'alguien@nyx5.com', body: 'hola' });
  assert.ok(!r.isError, `un envío completo no puede fallar: ${r.content?.[0]?.text}`);
  assert.equal(espia.vistos.body, 'hola');
  // Un cuerpo falso o cero es contenido legítimo, no un campo ausente.
  for (const cuerpo of [0, false, '']) {
    const r2 = await llamar(espia, 'nyx5_send', { to: 'alguien@nyx5.com', body: cuerpo });
    assert.ok(!r2.isError, `body=${JSON.stringify(cuerpo)} es contenido, no una ausencia`);
  }
});
