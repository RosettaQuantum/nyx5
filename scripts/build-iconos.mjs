// Genera los íconos de la app para la pantalla de inicio (PNG, sin dependencias) y el favicon, y
// los escribe en src/plataformas/iconos.js.
//
//   node scripts/build-iconos.mjs
//
// Por qué importan: en iPhone, Safari BORRA lo que una página guarda (incluida la llave del agente)
// si pasan siete días sin abrirla. Una app agregada a la pantalla de inicio está exenta. Sin ícono,
// iOS pone una captura borrosa y la gente no la agrega. iOS pide /apple-touch-icon.png solo.
//
// Los íconos son el logo cuadrado (web/marca/nyx5-logo.svg): el wordmark NYX5 sobre #121218, con
// la misma proporción, y el margen alcanza para el recorte de esquinas de iOS. El favicon usa la
// versión compacta N5 (web/marca/nyx5-n5.svg), porque las cuatro letras no se leen a 16 px.
import fs from 'node:fs';
import path from 'node:path';
import { root, lienzo, wordmarkCentrado, png, COMPACTA } from './marca.mjs';

function icono(S) {
  const px = lienzo(S, S);
  wordmarkCentrado(px, S, S, Math.round(S * 0.62));
  return png(S, S, px);
}

const tamanos = [180, 192, 512];
const lineas = tamanos.map((s) => `  ${s}: '${icono(s).toString('base64')}',`);
fs.writeFileSync(path.join(root, 'src/plataformas/iconos.js'),
  '// Generado por scripts/build-iconos.mjs — NO editar a mano.\n' +
  `export const ICONOS = {\n${lineas.join('\n')}\n};\n` +
  `export const FAVICON_SVG = ${JSON.stringify(COMPACTA.svg)};\n`);
console.log('iconos.js:', tamanos.map((s) => `${s}px ${icono(s).length} B`).join(' · '), `· favicon ${COMPACTA.svg.length} B`);
