// La marca NYX5 para los scripts que generan imágenes (build-og.mjs, build-iconos.mjs).
//
// La fuente de verdad son los SVG de web/marca/: el wordmark está en curvas (sin fuente, para que
// la CSP no tenga que dejar entrar una) y aquí se rasteriza a PNG sin dependencias. Por qué a mano:
// el proyecto tiene cero dependencias y esa regla no se rompe por una imagen.
//
// El rasterizador entiende sólo lo que escribe opentype.js (M, L, Q, C, Z absolutos), que es como
// se generaron los SVG. Rellena con la regla nonzero de TrueType y antialias por cobertura: SS
// sub-líneas por fila de píxeles y cobertura horizontal exacta por tramo.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FONDO = [0x12, 0x12, 0x18], TINTA = [0xe8, 0xe8, 0xec];

function leer(nombre) {
  const svg = fs.readFileSync(path.join(root, 'web/marca', nombre), 'utf8');
  const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  return { svg: svg.trim(), d: /\sd="([^"]+)"/.exec(svg)[1], w, h };
}
export const WORDMARK = leer('nyx5-wordmark.svg');
export const COMPACTA = leer('nyx5-n5.svg');

// Path → polígonos ya transformados (x * s + tx, y * s + ty), con las curvas aplanadas.
function poligonos(d, s, tx, ty) {
  const t = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  const otras = t.filter((x) => /[A-Za-z]/.test(x) && !/[MLQCZ]/.test(x));
  if (otras.length) throw new Error(`comando de path que no sé dibujar: ${otras[0]}`);
  const polys = []; let p = null, x = 0, y = 0, i = 0;
  const n = () => Number(t[i++]);
  const pt = (a, b) => p.push([a * s + tx, b * s + ty]);
  while (i < t.length) {
    const c = t[i++];
    if (c === 'M') { p = []; polys.push(p); x = n(); y = n(); pt(x, y); }
    else if (c === 'L') { x = n(); y = n(); pt(x, y); }
    else if (c === 'Q') {
      const [cx, cy, ex, ey] = [n(), n(), n(), n()];
      for (let k = 1; k <= 8; k++) { const u = k / 8, v = 1 - u; pt(v * v * x + 2 * v * u * cx + u * u * ex, v * v * y + 2 * v * u * cy + u * u * ey); }
      x = ex; y = ey;
    } else if (c === 'C') {
      const [ax, ay, bx, by, ex, ey] = [n(), n(), n(), n(), n(), n()];
      for (let k = 1; k <= 12; k++) { const u = k / 12, v = 1 - u; pt(v ** 3 * x + 3 * v * v * u * ax + 3 * v * u * u * bx + u ** 3 * ex, v ** 3 * y + 3 * v * v * u * ay + 3 * v * u * u * by + u ** 3 * ey); }
      x = ex; y = ey;
    }
  }
  return polys;
}

// Pinta un path sobre un lienzo RGB (Buffer W*H*3) mezclando `color` según la cobertura.
export function dibujar(px, W, H, d, { s, tx, ty, color, SS = 4 }) {
  const cov = new Float32Array(W * H);
  const lados = [];
  for (const p of poligonos(d, s, tx, ty)) for (let k = 0; k < p.length; k++) {
    const [x0, y0] = p[k], [x1, y1] = p[(k + 1) % p.length];
    if (y0 !== y1) lados.push([x0, y0, x1, y1]);
  }
  const tramo = (fila, a, b, peso) => {
    a = Math.max(0, a); b = Math.min(W, b); if (b <= a) return;
    const ia = Math.floor(a), ib = Math.floor(b);
    if (ia === ib) { cov[fila + ia] += (b - a) * peso; return; }
    cov[fila + ia] += (ia + 1 - a) * peso;
    for (let q = ia + 1; q < ib; q++) cov[fila + q] += peso;
    if (ib < W) cov[fila + ib] += (b - ib) * peso;
  };
  for (let py = 0; py < H; py++) for (let sub = 0; sub < SS; sub++) {
    const y = py + (sub + 0.5) / SS, cortes = [];
    for (const [x0, y0, x1, y1] of lados) {
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) cortes.push([x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), y1 > y0 ? 1 : -1]);
    }
    cortes.sort((a, b) => a[0] - b[0]);
    let giro = 0;
    for (let k = 0; k < cortes.length - 1; k++) { giro += cortes[k][1]; if (giro) tramo(py * W, cortes[k][0], cortes[k + 1][0], 1 / SS); }
  }
  for (let q = 0; q < W * H; q++) {
    const c = Math.min(1, cov[q]); if (!c) continue;
    for (let ch = 0; ch < 3; ch++) px[q * 3 + ch] = Math.round(px[q * 3 + ch] * (1 - c) + color[ch] * c);
  }
}

export function lienzo(W, H, color = FONDO) {
  const px = Buffer.alloc(W * H * 3);
  for (let q = 0; q < W * H; q++) px.set(color, q * 3);
  return px;
}

// El wordmark centrado, ocupando `ancho` píxeles: la misma proporción que web/marca/nyx5-logo.svg.
export function wordmarkCentrado(px, W, H, ancho) {
  const s = ancho / WORDMARK.w;
  dibujar(px, W, H, WORDMARK.d, { s, tx: (W - ancho) / 2, ty: (H - WORDMARK.h * s) / 2, color: TINTA });
}

// ---- PNG: cabecera, IHDR, IDAT (filtro 0 por fila) e IEND ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function trozo(tipo, datos) {
  const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(W, H, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;  // 8 bits, RGB
  const filas = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) px.copy(filas, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(filas, { level: 9 })), trozo('IEND', Buffer.alloc(0))]);
}
