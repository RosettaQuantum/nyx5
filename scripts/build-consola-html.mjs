// Genera src/plataformas/consola-html.js desde web/consola.html (el HTML no se edita a mano; §6).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'web/consola.html'), 'utf8');
fs.writeFileSync(path.join(root, 'src/plataformas/consola-html.js'),
  '// Generado desde web/consola.html — NO editar a mano; edita el .html y regenera (node scripts/build-consola-html.mjs).\n' +
  'export const CONSOLA_HTML = ' + JSON.stringify(html) + ';\n');
console.log('consola-html.js regenerado:', (html.length/1024).toFixed(1), 'KB');
