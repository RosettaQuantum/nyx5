// Revisión adversarial del medidor (24-nov-2026): ReDoS y entradas hostiles en `interpretar`.
// Criterio: ninguna entrada de hasta 40.000 caracteres tarda más de 50 ms; ninguna devuelve un
// dominio que no pase `dominioValido`, ni el dominio de una dirección de correo.
import { interpretar, dominioValido } from '../../src/correo/medidor.js';
const casos = [
  ['a.'.repeat(20000), undefined], ['a-'.repeat(20000) + '!', undefined], ['a'.repeat(40000), undefined],
  ['mide ' + 'x'.repeat(62) + '.' + 'y-'.repeat(15000), undefined], ['mide ' + 'aa.'.repeat(13000) + '@', undefined],
  ['mide ' + '-'.repeat(39000) + 'a.cl, sector banca', undefined], ['escríbele a ' + 'a.'.repeat(1000) + 'b@nyx5.com', null],
  ['mide xn--' + 'a'.repeat(39000), undefined], ['mide 1.2.3.4, sector banca', null], ['mide foo.local sector banca', null],
  ['mide «santander.cl»: sector banca', 'santander.cl'], ['mide SANTANDER.CL. sector banca', 'santander.cl'],
];
let peor = 0, malos = 0;
for (const [txt, esperado] of casos) {
  const t0 = performance.now();
  const r = interpretar({ body: txt });
  const ms = performance.now() - t0;
  peor = Math.max(peor, ms);
  const d = r.dominio ?? null;
  const ok = (d === null || dominioValido(d) === d) && (esperado === undefined || d === esperado);
  if (!ok || ms > 50) { malos++; console.log('FALLA', JSON.stringify(txt.slice(0, 40)), d, ms.toFixed(1)); }
}
console.log(malos ? `FALLA: ${malos}` : 'ok', `peor ${peor.toFixed(1)} ms`);
process.exit(malos ? 1 : 0);
