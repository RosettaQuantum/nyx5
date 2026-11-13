// Genera la imagen que se ve cuando alguien comparte un enlace de nyx5.com (og:image), como PNG
// y sin dependencias. Escribe src/plataformas/og-png.js con los bytes en base64.
//
//   node scripts/build-og.mjs
//
// Por qué PNG y no el SVG de la marca: los servicios que renderizan una vista previa (WhatsApp,
// Slack, LinkedIn, X) no aceptan SVG de forma fiable, así que un og:image en SVG equivale a no
// tener ninguno. El wordmark sale de web/marca/ y se rasteriza en scripts/marca.mjs.
//
// Sólo la marca sobre el fondo: el texto de la vista previa ya lo ponen og:title y og:description,
// y repetirlo en la imagen lo deja escrito dos veces con dos tipografías.

import fs from 'node:fs';
import path from 'node:path';
import { root, lienzo, wordmarkCentrado, png } from './marca.mjs';

const W = 1200, H = 630;
const px = lienzo(W, H);
wordmarkCentrado(px, W, H, 560);
const bytes = png(W, H, px);

fs.writeFileSync(path.join(root, 'docs/site/og.png'), bytes);
fs.writeFileSync(path.join(root, 'src/plataformas/og-png.js'),
  `// GENERADO por scripts/build-og.mjs — no editar a mano.\nexport const OG_PNG_B64 = ${JSON.stringify(bytes.toString('base64'))};\n`);
console.log(`og:image generada: ${W}x${H}, ${(bytes.length / 1024).toFixed(1)} KB`);
