// Nyx5/1 — el MEDIDOR: una dirección viva que atiende pedidos de medición post-cuántica sin un
// modelo de lenguaje en el medio (24-nov-2026, para la demo del 27-nov).
//
// Decisión de Nicholas del 24-nov: «tu agente le encarga la medición de santander.cl a rosetta@ por
// Nyx5, recibe la ficha en un mensaje firmado y el resultado queda notariado en el libro, con un
// recibo que ninguna parte puede negar». Corre desde el reloj de la casa (y desde el tick que sigue
// a cada entrega), sin el Mac y sin la API de Anthropic: es determinista. Lee el dominio y el
// sector, llama al instrumento de Rosetta (POST /v1/medicion, el mismo de su MCP), arma la
// respuesta, sella el acta en la notaría de la casa con un sobre firmado a libro@ y contesta.
//
// Límites, y son DE CÓDIGO:
//   - No importa nada que hable con la API de Anthropic. Su única red es `est.medidor.urls` (el
//     instrumento de Rosetta, lista cerrada fijada por la casa): el dominio pedido NUNCA se vuelve
//     una URL, así que no hay SSRF que pedir.
//   - Contesta sólo a sobres FIRMADOS de quien está en la lista del buzón (o su dueño). Un `intro`
//     o un aval de un desconocido (§9) se deja como estaba.
//   - Cupos por día UTC: por remitente y por casa, contados al TOMAR el pedido.
//   - NO cierra (ack) lo que no atiende: la dirección puede tener además una sesión de Claude que
//     lee su buzón (memoria «una dirección, dos mentes»). Sólo confirma los pedidos que contestó y
//     los recibos de la notaría que él mismo causó.
//   - Nada del cliente se publica: la ficha va cifrada al que pidió; a la notaría va sólo el hash
//     del acta (con su nombre genérico), y el acta lleva fecha al milisegundo y el hash de la
//     respuesta cruda, así que el hash no se puede adivinar desde el nombre de un dominio.
//   - Los textos que lee una persona viven en UN lugar: `TEXTOS`.
import { parseAddress } from './resolver.js';
import { sha256hex, canonical } from '../nucleo/crypto.js';
import { limpio } from './politica.js';

export const NS = 'medidor';           // nyx5_kv: `_config`, `p:<sobre>` (estado del pedido), `visto:<sobre>`, `op:<sobre-op>`
export const NS_CUPO = 'medidor-cupo'; // `<from>:<día>`, `casa:<día>`, `ayuda:<from>:<día>`
export const NS_TURNO = 'medidor-turno';
export const VIA = 'medidor';          // custody.via de la tarjeta: la casa firma y descifra en su nombre
export const CUPO = Object.freeze({ porRemitenteDia: 20, porCasaDia: 100, ayudaPorRemitenteDia: 3 });
// acuseMs: si la medición no volvió en este tiempo, se avisa «midiendo…». El tick que sigue a una
// petición tiene 30 s de vida en el edge (waitUntil): `kickMs` deja margen para sellar y contestar.
export const TIEMPOS = Object.freeze({ acuseMs: 6_000, kickMs: 18_000, cronMs: 100_000, turnoKickMs: 35_000, turnoCronMs: 180_000, intentos: 3 });
export const URLS_POR_DEFECTO = Object.freeze([
  'https://rosettaquantum.com/v1/medicion',
  // El borde de rosettaquantum.com tiene Bot Fight Mode (20-nov): a un cliente de nube le puede
  // responder un desafío. La misma app por workers.dev no pasa por esa zona.
  'https://rosetta-quantum.nicholasiakl.workers.dev/v1/medicion',
]);
export const SECTORES = Object.freeze(['banca', 'educacion', 'energia', 'fintech', 'gobierno', 'mineria', 'prevision', 'retail', 'salud_clinica', 'salud_isapre', 'seguros', 'telecom']);
const SINONIMOS = {
  banco: 'banca', bancos: 'banca', bancario: 'banca', bancaria: 'banca', bank: 'banca', banks: 'banca', banking: 'banca',
  educacion: 'educacion', education: 'educacion', universidad: 'educacion', universidades: 'educacion',
  energy: 'energia', electrica: 'energia', mining: 'mineria', minera: 'mineria', mineras: 'mineria',
  pensiones: 'prevision', afp: 'prevision', pension: 'prevision', pensions: 'prevision',
  government: 'gobierno', estado: null, telecomunicaciones: 'telecom', telco: 'telecom', telecommunications: 'telecom',
  seguro: 'seguros', aseguradora: 'seguros', insurance: 'seguros', isapre: 'salud_isapre', isapres: 'salud_isapre',
  clinica: 'salud_clinica', clinicas: 'salud_clinica', hospital: 'salud_clinica', hospitales: 'salud_clinica', comercio: 'retail',
};
const SISTEMA = new Set(['postmaster', 'libro', 'verifica', 'tareas', 'encargos', 'ideas']);
const DIA_MS = 24 * 3600 * 1000;
const VISTO_MS = 40 * DIA_MS;
const MAX_TEXTO = 4000;           // lo que se lee de un pedido para interpretarlo
const MAX_RESPUESTA = 2_000_000;  // bytes de la respuesta del instrumento
const MAX_FICHA = 20_000;         // caracteres de la ficha que viajan en el mensaje
export const MARCA_ACTA = 'nyx5-medicion/1';
// La ficha pública de la dirección del medidor (decisión de Nicholas del 24-nov: «su tarjeta pública
// dice que la custodia la tiene la casa y que es el medidor de Rosetta»). La custodia la declara además
// el campo `custody` de la tarjeta, firmado por la casa.
export const PERFIL = Object.freeze({
  display_name: 'Medidor de Rosetta',
  summary: 'Mide la exposición post-cuántica de un dominio con el instrumento de Rosetta y sella el resultado en la notaría de la casa. Su llave nació en la bóveda de la casa y sólo existe ahí.',
  languages: ['es', 'en'],
  tags: ['rosetta', 'pqc', 'medicion'],
});

// ---------------------------------------------------------------- textos (los lee una persona)
const tabla = (filas) => filas.join('\n');
export const TEXTOS = Object.freeze({
  es: {
    acuse: (d, s) => `Recibido. Estoy midiendo ${d} (sector ${s}) con el instrumento de Rosetta, desde afuera y sin instalar nada. La ficha llega en este mismo hilo, sellada en la notaría de la casa.`,
    reintento: (motivo, n, max) => `El instrumento de Rosetta no respondió (${motivo}). Reintento en menos de un minuto (intento ${n} de ${max}).`,
    fallo: (d, motivo) => `No pude medir ${d}: ${motivo}. No quedó nada sellado. Puedes volver a pedirlo en unos minutos.`,
    falta_sector: (d) => `Para medir ${d} me falta el sector (con él calculo el QEX y la nota). Sectores: ${SECTORES.join(', ')}. Ejemplo: «mide ${d}, sector banca».`,
    dominio_invalido: (x) => `«${x}» no es un dominio público que pueda medir. Escríbelo así: ejemplo.cl.`,
    limite: (n) => `Llegaste al tope de ${n} mediciones por día para tu dirección. Vuelve a pedirlo mañana (UTC).`,
    limite_casa: () => 'La casa llegó a su tope diario de mediciones. Vuelve a pedirlo mañana (UTC).',
    ayuda: (yo) => tabla([
      `Soy ${yo}, el medidor automático de Rosetta. Sé hacer dos cosas:`,
      '1. Medir la exposición post-cuántica de un dominio, desde afuera: «mide ejemplo.cl, sector banca». Te devuelvo la ficha (nota Q-Ready, QEX y versión) en un mensaje firmado, y dejo el resultado sellado en la notaría de la casa.',
      '2. Iniciar la verificación Q-Ready de un dominio y darte el registro TXT que su dueño publica: «inicia la verificación de ejemplo.cl, sector banca». Después: «comprueba la verificación de ejemplo.cl».',
      `Sectores: ${SECTORES.join(', ')}.`,
    ]),
    verificar_inicio: ({ dominio, sector, nombre, tipo, valor, caduca }) => tabla([
      `Inicié la verificación Q-Ready de ${dominio} (sector ${sector}). Para probar que el dominio es suyo, quien administra su DNS publica este registro:`,
      `nombre: ${nombre}`,
      `tipo: ${tipo}`,
      `valor: ${valor}`,
      `El pedido caduca el ${caduca} UTC si el registro no aparece. Cuando esté publicado, pídeme «comprueba la verificación de ${dominio}». La nota no se publica salvo que el dueño lo elija.`,
    ]),
    verificar_hecho: (d) => `Comprobé ${d}: el registro TXT está publicado y el dominio quedó verificado. Desde hoy Rosetta lo mide cada día.`,
    verificar_ausente: (d) => `Comprobé ${d}: el registro TXT todavía no aparece en su DNS (puede tardar unos minutos en propagarse). Vuelve a pedírmelo en un rato.`,
    verificar_sin_token: (d) => `No tengo una verificación iniciada por ti para ${d}. Pídeme primero «inicia la verificación de ${d}, sector banca» (con su sector).`,
    verificar_fallo: (d, motivo) => `No pude completar la verificación de ${d}: ${motivo}.`,
    resultado: ({ dominio, sector, letra, versionNota, qex, versionQex, fichaUrl }) => tabla([
      `Medición de ${dominio} · sector ${sector}`,
      `Nota Q-Ready: ${letra} (${versionNota}) · QEX ${qex}/100 (${versionQex})`,
      ...(fichaUrl ? [`Ficha en la web: ${fichaUrl}`] : []),
    ]),
    notaria: ({ sha, url, sello }) => tabla([
      '## Notaría',
      `Esta medición quedó sellada en el libro de la casa. sha256 del acta: ${sha}`,
      sello ? `Sello ${sello.id} · ${sello.at} · firmado por ${sello.house}. Verificación pública: ${url}` : `El sello está en curso; se verifica en ${url}`,
      'El acta es el JSON de abajo: su sha256 en forma canónica (claves ordenadas, sin espacios) es el hash sellado. El sello va firmado con la llave de la casa y se verifica con su tarjeta.',
    ]),
    sin_sello: 'sello en curso',
  },
  en: {
    acuse: (d, s) => `Received. I am measuring ${d} (sector ${s}) with Rosetta's instrument, from the outside and without installing anything. The sheet arrives in this same thread, sealed in the house notary.`,
    reintento: (motivo, n, max) => `Rosetta's instrument did not answer (${motivo}). Retrying in under a minute (attempt ${n} of ${max}).`,
    fallo: (d, motivo) => `I could not measure ${d}: ${motivo}. Nothing was sealed. You can ask again in a few minutes.`,
    falta_sector: (d) => `To measure ${d} I need the sector (it sets the QEX and the grade). Sectors: ${SECTORES.join(', ')}. Example: "measure ${d}, sector banca".`,
    dominio_invalido: (x) => `"${x}" is not a public domain I can measure. Write it like this: example.com.`,
    limite: (n) => `You reached the limit of ${n} measurements per day for your address. Ask again tomorrow (UTC).`,
    limite_casa: () => 'The house reached its daily limit of measurements. Ask again tomorrow (UTC).',
    ayuda: (yo) => tabla([
      `I am ${yo}, Rosetta's automatic measurer. I do two things:`,
      '1. Measure the post-quantum exposure of a domain, from the outside: "measure example.com, sector banca". You get the sheet (Q-Ready grade, QEX and version) in a signed message, and the result is sealed in the house notary.',
      '2. Start the Q-Ready verification of a domain and give you the TXT record its owner publishes: "start the verification of example.com, sector banca". Then: "check the verification of example.com".',
      `Sectors: ${SECTORES.join(', ')}.`,
    ]),
    verificar_inicio: ({ dominio, sector, nombre, tipo, valor, caduca }) => tabla([
      `I started the Q-Ready verification of ${dominio} (sector ${sector}). To prove the domain is theirs, whoever runs its DNS publishes this record:`,
      `name: ${nombre}`,
      `type: ${tipo}`,
      `value: ${valor}`,
      `The request expires on ${caduca} UTC if the record does not appear. Once it is published, ask me "check the verification of ${dominio}". The grade is not published unless the owner chooses to.`,
    ]),
    verificar_hecho: (d) => `I checked ${d}: the TXT record is published and the domain is now verified. From today Rosetta measures it daily.`,
    verificar_ausente: (d) => `I checked ${d}: the TXT record does not appear in its DNS yet (it can take a few minutes to propagate). Ask me again in a while.`,
    verificar_sin_token: (d) => `I have no verification started by you for ${d}. First ask me "start the verification of ${d}, sector banca" (with its sector).`,
    verificar_fallo: (d, motivo) => `I could not complete the verification of ${d}: ${motivo}.`,
    resultado: ({ dominio, sector, letra, versionNota, qex, versionQex, fichaUrl }) => tabla([
      `Measurement of ${dominio} · sector ${sector}`,
      `Q-Ready grade: ${letra} (${versionNota}) · QEX ${qex}/100 (${versionQex})`,
      ...(fichaUrl ? [`Sheet on the web: ${fichaUrl}`] : []),
    ]),
    notaria: ({ sha, url, sello }) => tabla([
      '## Notary',
      `This measurement was sealed in the house ledger. sha256 of the record: ${sha}`,
      sello ? `Seal ${sello.id} · ${sello.at} · signed by ${sello.house}. Public check: ${url}` : `The seal is in progress; check it at ${url}`,
      'The record is the JSON below: its sha256 in canonical form (sorted keys, no whitespace) is the sealed hash. The seal is signed with the house key and checks against its card.',
    ]),
    sin_sello: 'seal in progress',
  },
});

// ---------------------------------------------------------------- interpretar un pedido
const plano = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VERBO_MEDIR = /\b(mide|midan|midas|medir|medirlo|medila|mideme|midelo|midela|medicion|mediciones|measure|measurement|scan)\b/;
const VERBO_VERIFICAR = /\b(verifica|verificar|verificacion|verificalo|verify|verification)\b/;
const VERBO_COMPROBAR = /\b(comprueba|comprobar|compruebala|chequea|check)\b/;
const INGLES = /\b(measure|measurement|scan|verify|verification|please|sector of|the)\b/;
// Un dominio dentro de un texto. No toma el dominio de una dirección (`rosetta@nyx5.com`): el
// carácter anterior no puede ser `@` ni parte de un nombre.
// Los bordes miran CUALQUIER letra (\p{L}), no sólo ASCII: con \w, «münchen.de» daba «nchen.de», o
// sea otro dominio medido en silencio. Un nombre con letras fuera de ASCII se pide en punycode.
const CANDIDATO = /(?<![@\p{L}\p{N}_.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59}))(?![\p{L}\p{N}_@-])/gu;
const NO_PUBLICOS = /\.(local|localhost|internal|test|example|invalid|onion|lan|home|corp|arpa)$/;

// ¿Es `x` un nombre de dominio público con forma válida? Devuelve el dominio normalizado o null.
// Normaliza: minúsculas, sin `www.`, sin punto final. NO resuelve DNS ni lo usa como URL.
export function dominioValido(x) {
  let d = plano(x).trim().replace(/\.$/, '');
  if (d.startsWith('www.')) d = d.slice(4);
  if (!d || d.length > 253 || !d.includes('.')) return null;
  const labels = d.split('.');
  if (labels.length < 2) return null;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
  if (NO_PUBLICOS.test(`.${d}`) || d === 'localhost') return null;
  return d;
}

export function sectorDe(texto) {
  const t = plano(texto);
  for (const s of SECTORES) if (new RegExp(`\\b${s}\\b`).test(t)) return s;
  for (const [w, s] of Object.entries(SINONIMOS)) if (s && new RegExp(`\\b${w}\\b`).test(t)) return s;
  return null;
}

// Lee un pedido. `contenido` es el `content` abierto del sobre (body texto u objeto).
// Devuelve { accion: 'medir'|'verificar'|'comprobar'|'ayuda'|null, dominio, sector, idioma, crudo }.
export function interpretar(contenido, { tipo = 'message' } = {}) {
  const b = contenido?.body;
  // Un cuerpo JSON con `dominio` (o `domain`) es un pedido explícito, sin adivinar nada.
  if (b && typeof b === 'object' && !Array.isArray(b) && (b.dominio != null || b.domain != null)) {
    const crudo = String(b.dominio ?? b.domain).slice(0, 300);
    const idioma = b.idioma === 'en' || b.language === 'en' ? 'en' : 'es';
    const a = plano(b.accion ?? b.action ?? '');
    const accion = /^(verificar|verify)$/.test(a) ? 'verificar' : /^(comprobar|check)$/.test(a) ? 'comprobar' : 'medir';
    return { accion, dominio: dominioValido(crudo), crudo, sector: b.sector != null ? sectorDe(String(b.sector)) : null, idioma };
  }
  const texto = (typeof b === 'string' ? b : b == null ? '' : JSON.stringify(b)).slice(0, MAX_TEXTO);
  // El acta de una respuesta nuestra devuelta tal cual (un agente que cita o reenvía) no es un pedido.
  if (texto.includes(MARCA_ACTA)) return { accion: null };
  const t = plano(texto);
  const idioma = INGLES.test(t) && !/\b(mide|medir|por favor|inicia|comprueba)\b/.test(t) ? 'en' : 'es';
  const mide = VERBO_MEDIR.test(t);
  const verifica = VERBO_VERIFICAR.test(t);
  // Del texto en minúsculas TAL CUAL: quitar tildes antes convertiría «sántander.cl» en otro dominio.
  const candidatos = [...texto.toLowerCase().matchAll(CANDIDATO)].map((x) => x[1]);
  const crudo = candidatos[0] || null;
  const sector = sectorDe(t);
  if (crudo) {
    const accion = verifica && !mide ? (VERBO_COMPROBAR.test(t) ? 'comprobar' : 'verificar') : (mide || sector) ? 'medir' : null;
    return { accion, dominio: dominioValido(crudo), crudo, sector, idioma };
  }
  if (mide || verifica || tipo === 'task') return { accion: 'ayuda', idioma };
  return { accion: null };
}

// ---------------------------------------------------------------- el instrumento
// Llama a Rosetta. Nunca lanza: devuelve { ok, json, texto } o { ok: false, permanente|transitorio, motivo }.
export async function pedirMedicion(est, { dominio, sector, idioma, agente, timeoutMs }) {
  const f = est.medidor.fetchImpl || est.fetch;
  const motivos = [];
  const limite = Date.now() + timeoutMs;
  for (const url of est.medidor.urls) {
    const resta = limite - Date.now();
    if (resta < 1000) { motivos.push('se acabó el tiempo'); break; }
    let r;
    try {
      r = await f(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(resta),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'nyx5-medidor/1 (+https://nyx5.com)' },
        body: JSON.stringify({ dominio, sector, idioma, agente }) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      motivos.push(timeout ? 'no terminó a tiempo' : 'error de red');
      if (timeout) return { ok: false, transitorio: true, timeout: true, motivo: motivos.join('; ') };
      continue;
    }
    let texto = '';
    try { texto = await r.text(); } catch { motivos.push('respuesta cortada'); continue; }
    if (texto.length > MAX_RESPUESTA) { motivos.push('respuesta demasiado grande'); continue; }
    // Un desafío del borde (Bot Fight Mode) no es una respuesta de la API: se prueba la siguiente URL.
    if (r.status === 403 || r.status === 503) { motivos.push(r.headers?.get?.('cf-mitigated') ? 'el borde pidió un desafío' : `respondió ${r.status}`); continue; }
    let json = null; try { json = JSON.parse(texto); } catch { json = null; }
    if (!json || typeof json !== 'object') { motivos.push(`respuesta no JSON (${r.status})`); continue; }
    if (r.status === 429) return { ok: false, transitorio: true, motivo: 'Rosetta limita las mediciones por minuto' };
    if (r.status === 400) return { ok: false, permanente: true, motivo: limpiar(json.error) || 'Rosetta rechazó el pedido' };
    if (r.status === 200 && json.ok === true) {
      const letra = json.nota?.letra, qex = json.qex?.valor, md = json.presentacion?.markdown;
      if (typeof letra !== 'string' || typeof qex !== 'number' || typeof md !== 'string') {
        return { ok: false, permanente: true, motivo: 'Rosetta midió pero no devolvió nota ni QEX' };
      }
      return { ok: true, json, texto };
    }
    if (r.status === 200) return { ok: false, permanente: true, motivo: limpiar(json.error) || 'Rosetta no pudo medir' };
    motivos.push(`respondió ${r.status}`);
  }
  return { ok: false, transitorio: true, motivo: motivos.join('; ') || 'sin respuesta' };
}
// Llama a una herramienta del MCP de Rosetta (JSON-RPC, tools/call) en la MISMA lista cerrada de
// orígenes que la medición (`…/v1/medicion` → `…/mcp`). Para la verificación (iniciar_verificacion y
// verificar_dominio): la lógica y sus topes viven en Rosetta y no se duplican aquí. Nunca lanza.
export async function llamarMcp(est, herramienta, args, { timeoutMs = 20_000 } = {}) {
  const f = est.medidor.fetchImpl || est.fetch;
  const motivos = [];
  const limite = Date.now() + timeoutMs;
  for (const base of est.medidor.urls) {
    const url = base.replace(/\/v1\/medicion\/?$/, '/mcp');
    if (url === base) continue;
    const resta = limite - Date.now();
    if (resta < 1000) { motivos.push('se acabó el tiempo'); break; }
    let r, texto = '';
    try {
      r = await f(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(resta),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'nyx5-medidor/1 (+https://nyx5.com)' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: herramienta, arguments: args } }) });
      texto = await r.text();
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      motivos.push(timeout ? 'no terminó a tiempo' : 'error de red');
      if (timeout) break;
      continue;
    }
    if (r.status === 403 || r.status === 503) { motivos.push(r.headers?.get?.('cf-mitigated') ? 'el borde pidió un desafío' : `respondió ${r.status}`); continue; }
    let rpc = null; try { rpc = JSON.parse(texto.length > MAX_RESPUESTA ? '' : texto); } catch { rpc = null; }
    if (!rpc || typeof rpc !== 'object') { motivos.push(`respuesta no JSON (${r.status})`); continue; }
    if (rpc.error) return { ok: false, motivo: limpiar(rpc.error.message) || 'Rosetta no reconoce la herramienta' };
    let cuerpo = null; try { cuerpo = JSON.parse(rpc.result?.content?.[0]?.text ?? ''); } catch { cuerpo = null; }
    if (!cuerpo || typeof cuerpo !== 'object') return { ok: false, motivo: 'Rosetta respondió algo que no se puede leer' };
    if (cuerpo.ok === false) return { ok: false, motivo: limpiar(cuerpo.error) || 'Rosetta rechazó el pedido', cuerpo };
    return { ok: true, cuerpo };
  }
  return { ok: false, motivo: motivos.join('; ') || 'sin respuesta' };
}

// Texto de afuera (Rosetta) que entra a un mensaje: sin controles ni invisibles, acotado. `limpio`
// es la misma limpieza de la casa (quita ancho cero y bidi); escrita con escapes, nunca con literales.
const limpiar = (s) => (typeof s === 'string' ? limpio(s, 300) || '' : '');

// El acta que se sella: lo que se midió, cuándo, a pedido de quién, y el hash de lo que se recibió.
// Su sha256 canónico es lo que va a la notaría.
export function armarActa({ yo, e, recibido, dominio, sector, json, texto }) {
  const fichaUrl = json.ficha_url || json.presentacion?.ficha?.url_dominio || json.siguiente_paso?.informe_dominio || null;
  return {
    acta: MARCA_ACTA,
    medidor: yo,
    pedido: { sobre: e.id, de: e.from, recibido },
    instrumento: limpiar(json.instrumento) || null,
    dominio, sector,
    medido_utc: limpiar(json.medido_utc) || null,
    nota: { letra: limpiar(json.nota.letra), version: limpiar(json.nota.version) || null },
    qex: { valor: json.qex.valor, version: limpiar(json.qex.version) || null },
    ficha_url: typeof fichaUrl === 'string' && /^https:\/\//.test(fichaUrl) ? fichaUrl.slice(0, 500) : null,
    ficha_markdown_sha256: sha256hex(json.presentacion.markdown.slice(0, MAX_FICHA)),
    respuesta_sha256: sha256hex(texto),
  };
}

// ---------------------------------------------------------------- el tick
// Lo que el medidor manda sale YA, no en el próximo minuto del reloj: la entrega de la cola es la
// misma que hace el tick (reclamo exclusivo, así que dos relojes no entregan dos veces). Medido en
// workerd el 24-nov: sin esto la ficha esperaba al cron siguiente aunque la medición tardara 3 s.
async function entregarCola(est) {
  try { for (const job of await est.store.claimDueJobs(Date.now(), 20)) await est._deliver(job); }
  catch (err) { est.log(`medidor: la cola no se pudo entregar ahora (${err.message}); la entrega el reloj`); }
}
async function enviar(est, a, opciones) {
  const r = await a.send(opciones);
  await entregarCola(est);
  return r;
}
const diaDe = (ms) => new Date(ms).toISOString().slice(0, 10);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const minus = (x) => String(x || '').toLowerCase();

// Un tick: atiende los pedidos pendientes del buzón del medidor. `programado` es el reloj (cron):
// tiene tiempo para una medición lenta; el tick de una petición (kick) mide con `kickMs` y, si no
// alcanza, deja el pedido al reloj. Devuelve cuántos pedidos cerró con respuesta.
export async function atenderMedidor(est, { programado = true, nowMs = Date.now(), maxPorTick = 3, maxMiradosPorTick = 200 } = {}) {
  if (!est.medidor?.enabled || !est.store.kvIncrement) return 0;
  const cfg = await est.store.kvGet(NS, '_config');
  if (!cfg?.enabled || !cfg.local) return 0;
  const local = cfg.local;
  const rec = await est.store.getAgent(local);
  if (!rec || rec.revoked || rec.custody?.via !== VIA) return 0;
  const yo = `${local}@${est.domain}`;
  const porLista = rec.inbox?.policy === 'allowlist';
  const lista = new Set([...(rec.inbox?.allowlist || []), cfg.owner].filter(Boolean).map(minus));
  const asistentes = new Set(((await est.store.kvGet('asistente', '_indice')) || []).map((l) => `${l}@${est.domain}`));
  let agente;
  const agenteDe = async () => agente || (agente = await est.agenteDeBoveda(local));
  let cerrados = 0, tomados = 0, mirados = 0;
  // El tick de una petición corre tras CADA envío de la casa: mira sólo lo llegado en los últimos
  // diez minutos (el buzón de una dirección con otra mente puede tener decenas de sobres pendientes
  // que no son del medidor). El reloj mira todo.
  const correo = !programado && est.store.listMailSince
    ? await est.store.listMailSince(local, new Date(nowMs - 10 * 60_000).toISOString())
    : await est.store.listMail(local);
  for (const m of correo) {
    if (tomados >= maxPorTick || mirados >= maxMiradosPorTick) break;
    mirados++;
    const e = m.envelope || {};
    if (!e.id) continue;
    if (await est.store.kvGet(NS, `visto:${e.id}`)) continue;
    const visto = () => est.store.kvPut(NS, `visto:${e.id}`, { at: new Date(nowMs).toISOString() }, nowMs + VISTO_MS);
    let de; try { de = parseAddress(e.from); } catch { await visto(); continue; }
    // El recibo de la notaría que causó un sello nuestro: se confirma (si no, cada medición dejaría
    // un sobre pendiente para siempre). Cualquier otro sobre de sistema se deja para quien lea.
    if (de.domain === est.domain && de.local === 'libro' && e.type === 'receipt') {
      if (e.in_reply_to && await est.store.kvGet(NS, `op:${e.in_reply_to}`)) await est.store.ackMail(local, e.id);
      await visto(); continue;
    }
    const deSistema = de.domain === est.domain && SISTEMA.has(de.local);
    const ajeno = !e.signature || m.from_verified === false || e.from === yo || deSistema
      || (porLista && !lista.has(minus(e.from)) && !lista.has(de.domain))
      || !['message', 'task'].includes(e.type);
    const estado = await est.store.kvGet(NS, `p:${e.id}`);
    if (!estado && ajeno) { await visto(); continue; }
    try {
      const a = await agenteDe();
      if (!a) throw new Error('the vault does not hold the key of the measurer');
      if (estado) {
        // `tomado`: otro reloj lo está decidiendo (sector, cupo, verificación). Si quedó así más de
        // cinco minutos, ese reloj murió a medio camino: se suelta para que el siguiente lo retome.
        if (estado.estado === 'tomado') {
          if (nowMs - Date.parse(estado.tomado || estado.recibido) > 5 * 60_000) await est.store.kvDelete?.(NS, `p:${e.id}`);
          continue;
        }
        if (estado.estado !== 'midiendo') { await visto(); continue; }
        tomados++;
        if (await medir(est, { a, yo, e, estado, programado, nowMs })) cerrados++;
        continue;
      }
      let abierto;
      try { abierto = await a.open(e); } catch { await visto(); continue; }
      const p = interpretar(abierto.content, { tipo: e.type });
      const T = TEXTOS[p.idioma || 'es'];
      const hilo = { thread: e.thread || e.id, inReplyTo: e.id };
      if (!p.accion) { await visto(); continue; }
      if (p.accion === 'ayuda') {
        // Una sola vez por sobre, tres por remitente y día, y nunca a un asistente (dos
        // contestadores automáticos se contestarían para siempre). El sobre NO se cierra: es de quien
        // lea el buzón. La marca de visto se TOMA (atómica): dos relojes que abrieran el mismo sobre a
        // la vez mandaban dos ayudas (medido: 2 de 3 corridas en Node).
        if (!(await est.store.kvPutIfAbsent(NS, `visto:${e.id}`, { at: new Date(nowMs).toISOString() }, nowMs + VISTO_MS))) continue;
        if (asistentes.has(minus(e.from))) continue;
        const n = await est.store.kvIncrement(NS_CUPO, `ayuda:${minus(e.from)}:${diaDe(nowMs)}`, (Math.floor(nowMs / DIA_MS) + 2) * DIA_MS, nowMs);
        if (n <= CUPO.ayudaPorRemitenteDia) await enviar(est, a, { to: e.from, body: T.ayuda(yo), ...hilo });
        continue;
      }
      // Un pedido: se toma UNA vez (dos relojes no lo toman dos veces) y ahí se cobra el cupo.
      // Se toma como `tomado` y pasa a `midiendo` sólo cuando hay algo que medir: si naciera
      // `midiendo`, otro reloj podía medir un pedido sin sector mientras éste contestaba que faltaba
      // (medido en Node: 2 de 6 corridas llamaron al instrumento con sector null).
      const nuevo = { estado: 'tomado', tomado: new Date(nowMs).toISOString(), accion: p.accion, dominio: p.dominio, crudo: p.crudo, sector: p.sector, idioma: p.idioma || 'es',
        from: e.from, thread: e.thread || e.id, recibido: new Date(nowMs).toISOString(), intentos: 0, acuse: false, avisado: false };
      if (!(await est.store.kvPutIfAbsent(NS, `p:${e.id}`, nuevo))) continue;
      tomados++;
      const cerrar = async (texto) => {
        await enviar(est, a, { to: e.from, body: texto, ...hilo });
        await est.store.kvPut(NS, `p:${e.id}`, { ...nuevo, estado: 'cerrado', cerrado: new Date().toISOString() });
        await est.store.ackMail(local, e.id);
        cerrados++;
      };
      if (!p.dominio) { await cerrar(T.dominio_invalido(limpiar(p.crudo).slice(0, 80))); continue; }
      const vence = (Math.floor(nowMs / DIA_MS) + 2) * DIA_MS;
      if (await est.store.kvIncrement(NS_CUPO, `${minus(e.from)}:${diaDe(nowMs)}`, vence, nowMs) > CUPO.porRemitenteDia) { await cerrar(T.limite(CUPO.porRemitenteDia)); continue; }
      if (await est.store.kvIncrement(NS_CUPO, `casa:${diaDe(nowMs)}`, vence, nowMs) > CUPO.porCasaDia) { await cerrar(T.limite_casa()); continue; }
      // El sector que falta se toma de la última medición que pidió el mismo remitente para ese dominio.
      const sector = p.sector || (await est.store.kvGet(NS, `ultimo:${minus(e.from)}:${p.dominio}`))?.sector || null;
      if (p.accion === 'comprobar') { await cerrar(await comprobarVerificacion(est, { e, dominio: p.dominio, T, idioma: nuevo.idioma })); continue; }
      if (!sector) { await cerrar(T.falta_sector(p.dominio)); continue; }
      if (p.accion === 'verificar') { await cerrar(await iniciarVerificacion(est, { e, dominio: p.dominio, sector, T, idioma: nuevo.idioma })); continue; }
      nuevo.sector = sector;
      nuevo.estado = 'midiendo';
      await est.store.kvPut(NS, `p:${e.id}`, nuevo);
      if (await medir(est, { a, yo, e, estado: nuevo, programado, nowMs })) cerrados++;
    } catch (err) {
      est.log(`medidor: sobre ${e.id}: ${err.message}`);
    }
  }
  return cerrados;
}

// Segundo acto: iniciar la verificación por el MCP de Rosetta y devolver el TXT a publicar. El token
// queda guardado (72 h, lo que dura en Rosetta) por remitente y dominio, para «compruébala» después.
async function iniciarVerificacion(est, { e, dominio, sector, T, idioma }) {
  const r = await llamarMcp(est, 'iniciar_verificacion', { dominio, sector, publico: false, idioma });
  if (!r.ok) return T.verificar_fallo(dominio, r.motivo);
  const c = r.cuerpo, txt = c.txt || {};
  if (!/^[0-9a-f]{64}$/.test(String(c.token || '')) || typeof txt.valor !== 'string') return T.verificar_fallo(dominio, 'Rosetta no entregó el registro');
  await est.store.kvPut(NS, `token:${minus(e.from)}:${dominio}`, { token: c.token, at: new Date().toISOString() }, Date.now() + 72 * 3600_000);
  return T.verificar_inicio({ dominio, sector, nombre: limpiar(txt.nombre) || `_qready.${dominio}`, tipo: limpiar(txt.tipo) || 'TXT', valor: limpiar(txt.valor), caduca: limpiar(c.caduca_utc).slice(0, 16).replace('T', ' ') || '—' });
}
async function comprobarVerificacion(est, { e, dominio, T, idioma }) {
  const t = await est.store.kvGet(NS, `token:${minus(e.from)}:${dominio}`);
  if (!t?.token) return T.verificar_sin_token(dominio);
  const r = await llamarMcp(est, 'verificar_dominio', { token: t.token, idioma });
  if (!r.ok) return T.verificar_fallo(dominio, r.motivo);
  return r.cuerpo.verificado === true ? T.verificar_hecho(dominio) : T.verificar_ausente(dominio);
}

// Mide un pedido tomado. Devuelve true si lo cerró (con la ficha o con el error en palabras).
async function medir(est, { a, yo, e, estado, programado, nowMs }) {
  const T = TEXTOS[estado.idioma] || TEXTOS.es;
  const hilo = { thread: estado.thread || e.id, inReplyTo: e.id };
  const local = parseAddress(yo).local;
  const tiempos = { ...TIEMPOS, ...(est.medidor.tiempos || {}) };
  // Un turno por pedido: dos relojes no miden dos veces a la vez. Vence solo: si el tick que lo
  // tomó muere (el edge corta un kick a los 30 s), el reloj siguiente lo retoma.
  if (!(await est.store.kvPutIfAbsent(NS_TURNO, e.id, { at: new Date().toISOString(), programado }, Date.now() + (programado ? tiempos.turnoCronMs : tiempos.turnoKickMs)))) return false;
  const guardar = (cambios) => est.store.kvPut(NS, `p:${e.id}`, (estado = { ...estado, ...cambios }));
  const inicio = Date.now();
  const pedido = pedirMedicion(est, { dominio: estado.dominio, sector: estado.sector, idioma: estado.idioma, agente: `${yo} (nyx5-medidor/1)`, timeoutMs: programado ? tiempos.cronMs : tiempos.kickMs });
  let r = null;
  if (!estado.acuse) {
    r = await Promise.race([pedido, espera(tiempos.acuseMs).then(() => null)]);
    if (!r) { await enviar(est, a, { to: e.from, body: T.acuse(estado.dominio, estado.sector), ...hilo }); await guardar({ acuse: true }); }
  }
  if (!r) r = await pedido;
  est.log(`medidor: sobre ${e.id}: instrumento ${r.ok ? 'ok' : `falla (${r.motivo})`} a los ${Date.now() - inicio} ms (${programado ? 'reloj' : 'petición'})`);
  const cerrar = async (texto, final) => {
    await enviar(est, a, { to: e.from, body: texto, ...hilo });
    await guardar({ estado: final, cerrado: new Date().toISOString() });
    await est.store.ackMail(local, e.id);
    await est.store.kvDelete?.(NS_TURNO, e.id);
    return true;
  };
  if (!r.ok) {
    if (r.permanente) return cerrar(T.fallo(estado.dominio, r.motivo), 'fallido');
    // Un kick que se quedó sin tiempo no cuenta como intento: la medición lenta es del reloj.
    const intentos = estado.intentos + (r.timeout && !programado ? 0 : 1);
    if (intentos >= tiempos.intentos) return cerrar(T.fallo(estado.dominio, r.motivo), 'fallido');
    if (!estado.avisado && !(r.timeout && !programado && estado.acuse)) {
      await enviar(est, a, { to: e.from, body: T.reintento(r.motivo, intentos + 1, tiempos.intentos), ...hilo });
      await guardar({ intentos, avisado: true });
    } else await guardar({ intentos });
    await est.store.kvDelete?.(NS_TURNO, e.id);
    return false;
  }
  // ----- la ficha, el acta y el sello -----
  const { json, texto } = r;
  const acta = armarActa({ yo, e, recibido: estado.recibido, dominio: estado.dominio, sector: estado.sector, json, texto });
  const sha = sha256hex(canonical(acta));
  let sello = null;
  try {
    // Por la puerta de todos (invariante 2): un sobre firmado por el medidor a libro@. Lo único que
    // ve la notaría es el hash y un nombre genérico; el dominio NO va ahí (sería público).
    const op = await a.notarize(est.domain, { sha256: sha, name: 'medicion', media: 'application/json' });
    if (op?.id) await est.store.kvPut(NS, `op:${op.id}`, { pedido: e.id }, Date.now() + 7 * DIA_MS);
    // Se entrega la cola ahora (el mismo trabajo del reloj) para leer el sello en este turno.
    for (let i = 0; i < 2 && !sello; i++) {
      await entregarCola(est);
      sello = (await est.store.notariaFind(sha, yo))?.sello || null;
    }
  } catch (err) { est.log(`medidor: no se pudo sellar: ${err.message}`); }
  const url = `${est.publicUrl}/notaria/${sha}`;
  const ficha = json.presentacion.markdown.slice(0, MAX_FICHA);
  const cuerpo = [
    T.resultado({ dominio: estado.dominio, sector: estado.sector, letra: acta.nota.letra, versionNota: acta.nota.version, qex: acta.qex.valor, versionQex: acta.qex.version, fichaUrl: acta.ficha_url }),
    '',
    ficha,
    '',
    T.notaria({ sha, url, sello }),
    '',
    '```json',
    JSON.stringify(acta, null, 2),
    '```',
    ...(sello ? ['', '```json', JSON.stringify(sello, null, 2), '```'] : []),
  ].join('\n');
  await cerrar(cuerpo, 'hecho');
  await guardar({ sha256: sha, sellado: !!sello });
  await est.store.kvPut(NS, `ultimo:${minus(estado.from)}:${estado.dominio}`, { sector: estado.sector }, Date.now() + 30 * DIA_MS);
  return true;
}
