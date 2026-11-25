// La tarjeta servida en PRODUCCIÓN dice exactamente la ficha aprobada (Nicholas, 25-nov-2026).
//   node scripts/revision-medidor/a2-tarjeta-produccion.mjs [https://nyx5.com] [medicion-rosetta]
// Sale con 1 si difiere, con 2 si no pudo leer la tarjeta (tres estados: ok / falla / indecisa).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha256hex } from '../../src/nucleo/crypto.js';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const casa = process.argv[2] || 'https://nyx5.com', local = process.argv[3] || 'medicion-rosetta';
const doc = JSON.parse(fs.readFileSync(path.join(raiz, 'docs/aprobados/medidor-perfil.json'), 'utf8'));
const sha = fs.readFileSync(path.join(raiz, 'docs/aprobados/medidor-perfil.sha256'), 'utf8').split(/\s+/)[0];
if (sha256hex(canonical(doc.perfil)) !== sha) { console.log('FALLA: el archivo aprobado no coincide con su sha256'); process.exit(1); }
let servida;
try { const r = await fetch(`${casa}/agents/${local}`, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); servida = await r.json(); }
catch (e) { console.log(`INDECISA: no se pudo leer la tarjeta (${e.message})`); process.exit(2); }
const { updated: _u, ...ficha } = (servida.card || servida).profile || {};
const igual = sha256hex(canonical(ficha)) === sha;
console.log(igual ? `ok: ${casa}/agents/${local} sirve la ficha aprobada (sha256 ${sha.slice(0, 12)}…)` : `FALLA: la ficha servida difiere de la aprobada\n${JSON.stringify(ficha, null, 2)}`);
process.exit(igual ? 0 : 1);
