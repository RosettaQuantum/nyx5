// node --test test/
// Ningún archivo fuente lleva un carácter invisible (ancho cero, bidi, BOM) ni un NUL literal: se
// escriben con escapes (barra, u, cuatro hexadecimales), porque el carácter literal se corrompe en
// silencio al editar y las herramientas lo pierden al reescribir (pasó el 13-sep-2026 dos veces, y el
// 14-sep otra vez: un NUL literal en test/perfil.test.js vivía en main sin que nadie lo viera).
//
// Por qué es una prueba y no un `grep` en la guía: en esta máquina `grep` es una función de shell
// que envuelve otro buscador y NO encontró ni el NUL ni los U+200B literales (dio 0 con los
// caracteres presentes). Un control que depende de qué `grep` haya en el PATH no es un control.
//
// Los caracteres se construyen con `String.fromCodePoint`, no se escriben: la herramienta que
// escribió este archivo convierte un escape tipeado en el carácter literal, y este archivo se barre
// a sí mismo.
//
// Qué NO cubre: los documentos fuera de docs/SPEC.md (bitácoras y planes pueden citar caracteres
// para describirlos), y los archivos binarios. El barrido es sobre lo que se ejecuta o se publica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cp = (n) => String.fromCodePoint(n);
// Rangos: ancho cero y marcas (200B–200F), bidi (202A–202E, 2066–2069), invisibles (2060–2064), BOM, NUL.
const CLASE = `[${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2069)}${cp(0xfeff)}${cp(0)}]`;
const INVISIBLE = new RegExp(CLASE);
const TODOS = new RegExp(CLASE, 'g');
const EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.md', '.sql', '.json', '.txt', '.css']);
const DIRS = ['src', 'test', 'scripts', 'web', 'bin', 'migrations', 'demo'];
const ARCHIVOS = ['docs/SPEC.md', 'docs/SPEC.en.md', 'README.md', 'README.es.md'];

function* archivos(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* archivos(p); } else if (EXT.has(path.extname(e.name))) yield p;
  }
}
const marcado = (l) => l.replace(TODOS, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
export const hallazgos = (texto) => texto.split('\n').map((l, i) => (INVISIBLE.test(l) ? `${i + 1}: ${marcado(l).slice(0, 120)}` : null)).filter(Boolean);

test('la fuente no lleva caracteres invisibles ni NUL literales (se escriben con escapes)', () => {
  // El detector se comprueba contra un caso que tiene que gritar y uno que tiene que callar, en
  // memoria: si esta parte falla, la lista de abajo no vale nada.
  assert.equal(hallazgos(`a${cp(0x200b)}b\nc`).length, 1, 'el detector no ve un ancho cero');
  assert.equal(hallazgos(`x${cp(0)}y`).length, 1, 'el detector no ve un NUL');
  assert.equal(hallazgos(`a${cp(0x202e)}b`).length, 1, 'el detector no ve una marca bidi');
  const barra = cp(0x5c);
  assert.equal(hallazgos(`con escape: '${barra}u200b' y '${barra}u0000'`).length, 0, 'un escape escrito con barra NO es un invisible');
  const lista = [];
  for (const d of DIRS) { const p = path.join(raiz, d); if (fs.existsSync(p)) lista.push(...archivos(p)); }
  for (const f of ARCHIVOS) { const p = path.join(raiz, f); if (fs.existsSync(p)) lista.push(p); }
  assert.ok(lista.length > 50, `se esperaban los archivos del repo, se vieron ${lista.length}`);
  const sucios = [];
  for (const f of lista) { const h = hallazgos(fs.readFileSync(f, 'utf8')); if (h.length) sucios.push(`${path.relative(raiz, f)} ${h.join(' | ')}`); }
  assert.deepEqual(sucios, [], `archivos con invisibles o NUL literales (${sucios.length} de ${lista.length} revisados):\n${sucios.join('\n')}`);
});

// ---------------------------------------------------------------------------------------------
// Y los EJEMPLOS tienen que poder correr. Defecto medido el 29-oct-2026: `examples/hola-mundo.mjs`
// registraba `ana@casa.local`, y los nombres de 1 a 3 caracteres quedaron reservados el 9-sep
// (`min_name_length: 4`). El hola mundo del repositorio público —lo primero que corre quien llega—
// llevaba CINCUENTA DÍAS fallando, y el CI rojo todo ese tiempo sin que nadie lo mirara.
//
// Por qué un barrido de la fuente y no «correr los demos»: el CI ya los corre y eso no bastó,
// porque `npm test` daba verde en local y nadie abría el CI. Esto falla donde se mira.
// Es PRECISO, no amplio: sólo mira el largo y la forma del nombre, que es lo que la casa rechaza
// siempre y para todos. Las direcciones de SISTEMA se saltan: `libro@`, `verifica@`, `tareas@` y
// `postmaster@` son destinos legítimos en un ejemplo, y nadie las registra.
test('ningún ejemplo ni demo usa una dirección que la casa no deja registrar', async () => {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const SISTEMA = new Set(['libro', 'verifica', 'tareas', 'postmaster', 'casa', 'historial', 'indice']);
  const MIN = 4;   // el `min_name_length` por omisión de la casa
  const malas = [];
  for (const dir of ['examples', 'demo']) {
    const d = path.join(raiz, dir);
    if (!fs.existsSync(d)) continue;
    for (const p of archivos(d)) {
      const src = fs.readFileSync(p, 'utf8');
      // Direcciones literales dentro de comillas: 'nombre@host'
      for (const m of src.matchAll(/['"`]([a-zA-Z0-9][a-zA-Z0-9._-]*)@([a-zA-Z0-9.-]+)['"`]/g)) {
        const local = m[1].toLowerCase();
        const raizNombre = local.split('.')[0];
        if (SISTEMA.has(raizNombre) || local.startsWith('g.')) continue;
        const rel = `${path.relative(raiz, p)}: ${m[1]}@${m[2]}`;
        if (local.length < MIN) malas.push(`${rel} (${local.length} caracteres, el mínimo es ${MIN})`);
        else if (!Estafeta.validLocal(local)) malas.push(`${rel} (forma inválida)`);
        else if (Estafeta.RESERVED.has(raizNombre)) malas.push(`${rel} (nombre reservado)`);
      }
    }
  }
  assert.deepEqual(malas, [], `direcciones que la casa rechazaría:\n  ${malas.join('\n  ')}`);
});

// Nace de un defecto REAL del 17-nov-2026, y de los peores: silencioso y hacia afuera. Una suite
// nueva llamó a `join({ estafeta, local, dir })` creyendo que así apuntaba a su casa de prueba.
// `join` no tiene ninguno de esos tres parámetros —son `{ house, name, hosts }`— y **`house` vale
// `nyx5.com` por defecto**, así que la prueba se unió a la CASA DE PRODUCCIÓN y registró ahí un
// agente por corrida. Diez quedaron, invisibles en el directorio y sin un peso, pero en producción.
// No se arregla acordándose: se arregla con un chequeo que falla cerrado.
test('ninguna prueba se une a una casa que no sea de prueba', () => {
  const dir = new URL('.', import.meta.url);
  const malas = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js'))) {
    // Este archivo se excluye porque CITA el patrón: su propio texto lo hace coincidir consigo
    // mismo. Es la misma razón por la que el barrido de caracteres invisibles de arriba construye
    // los caracteres en vez de escribirlos.
    if (f === 'fuente-limpia.test.js') continue;
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    // Las constantes del archivo, para poder resolver `house: LEJOS` y no cantar un falso positivo.
    const consts = new Map([...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([^'"`]+)['"`]/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/\bjoin\(\s*\{([^{}]*)\}/g)) {
      const args = m[1];
      const linea = src.slice(0, m.index).split('\n').length;
      const clave = /house\s*:\s*([^,}\n]+)/.exec(args);
      // (a) sin `house` siquiera: se uniría a la casa por defecto, que es producción.
      if (!clave) { malas.push(`${f}:${linea} join() sin house: se uniría a nyx5.com, que es producción`); continue; }
      const crudo = clave[1].trim();
      const lit = /^['"`]([^'"`]+)['"`]$/.exec(crudo);
      // (b) un dominio escrito a mano que no es de prueba. Una variable se resuelve si el archivo
      // la define como literal; si no se puede resolver, NO se acusa: un falso positivo retiene
      // trabajo bueno, que es peor que dejar pasar un caso.
      const valor = lit ? lit[1] : consts.get(crudo);
      if (valor && !valor.endsWith('.test')) malas.push(`${f}:${linea} join({ house: '${valor}' }) no es una casa de prueba`);
    }
  }
  assert.deepEqual(malas, [], `pruebas que se unirían a una casa real:\n${malas.join('\n')}`);
});
