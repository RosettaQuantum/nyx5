// Genera la portada de nyx5.com desde web/home.html, igual que build-app-html.mjs con /app: el
// HTML se edita en web/home.html y esto lo inlinea. No se edita a mano el resultado.
//
// La portada nace de la propuesta web v2 (12-nov-2026) con la marca NYX5 en lugar del sello.
// Todo lo público en inglés (decisión de Nicholas, 8-sep-2026); el diccionario ES del final es
// sólo el botón de idioma, y la página se sirve con lang="en".
//
// Dos números de la página no se escriben a mano porque envejecen solos: cuántas herramientas MCP
// hay (se cuentan en src/puentes/herramientas.js) y la comisión de la casa (NYX5_FEE_BPS de
// wrangler.toml). Si cualquiera de los dos no se puede leer, el build falla en vez de publicar un
// número inventado.
//   node scripts/build-home.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TOOLS } = await import(pathToFileURL(path.join(root, 'src/puentes/herramientas.js')).href);
const bps = /^NYX5_FEE_BPS\s*=\s*"(\d+)"/m.exec(fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8'))?.[1];
if (!TOOLS?.length || bps == null) throw new Error('no pude leer las herramientas o NYX5_FEE_BPS: la portada no se publica con un número inventado');

const html = fs.readFileSync(path.join(root, 'web/home.html'), 'utf8')
  .replaceAll('{{TOOLS}}', String(TOOLS.length))
  .replaceAll('{{FEE}}', String(Number(bps) / 100));
if (/\{\{[A-Z]+\}\}/.test(html)) throw new Error('quedó un hueco sin llenar en web/home.html');

const outDir = path.join(root, 'docs/site');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'home.html'), html);
fs.writeFileSync(path.join(root, 'src/plataformas/home-html.js'),
  `// GENERADO por scripts/build-home.mjs desde web/home.html — no editar a mano.\nexport const HOME_HTML = ${JSON.stringify(html)};\n`);
console.log(`portada generada: ${(html.length / 1024).toFixed(1)} KB (${TOOLS.length} herramientas, comisión ${Number(bps) / 100}%)`);
