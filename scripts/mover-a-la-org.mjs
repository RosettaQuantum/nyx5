#!/usr/bin/env node
// Reapunta TODO lo que nombra el repo viejo después de transferirlo a la organización.
//
// Nace de un traspaso real (12-nov-2026): GitHub no deja dar rol admin a un colaborador en un
// repo de cuenta personal, así que para que John tenga acceso total el repo se mueve a la org.
//
// Corre DESPUÉS de la transferencia, nunca antes, y lo comprueba él mismo: npm exige que
// `repository.url` del package.json coincida EXACTAMENTE con el repo de GitHub, así que
// reapuntarlo antes de tiempo rompería la siguiente publicación en vez de arreglarla.
//
//   node scripts/mover-a-la-org.mjs --dry      ver qué cambiaría, sin tocar nada
//   node scripts/mover-a-la-org.mjs            hacerlo
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VIEJO = 'RosettaQuantum/nyx5';
const NUEVO = 'RosettaQuantum/nyx5';
const seco = process.argv.includes('--dry');
const raiz = path.join(import.meta.dirname, '..');

const salir = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// 1. El repo nuevo tiene que EXISTIR. Sin esto el script reapuntaría a la nada y el fallo
//    aparecería recién en la próxima publicación, que es el peor momento para enterarse.
// Se pregunta con `gh` (autenticado) y no con fetch a secas: sin credenciales, un repo PRIVADO
// contesta 404 igual que uno inexistente, así que el script diría «todavía no se transfirió»
// cuando en realidad ya está. Lo descubrió el ensayo contra un repo privado de la org, que es
// justo para lo que sirve ensayar un script de una sola oportunidad.
let repo;
try { repo = JSON.parse(execFileSync('gh', ['api', `repos/${NUEVO}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
catch { salir(`https://github.com/${NUEVO} no existe o no lo ves con tu sesión de gh. Primero se transfiere el repo; este script va después.`); }
console.log(`ok · ${NUEVO} existe (id ${repo.id}, creado ${repo.created_at.slice(0, 10)})`);

// 2. Y tiene que ser EL MISMO repo, no uno nuevo con el mismo nombre: el id de GitHub es
//    inmutable y sobrevive a la transferencia. Un repo distinto con el mismo nombre significa
//    que alguien lo recreó, y reapuntar ahí sería apuntar al lugar equivocado con buena cara.
let idLocal = null;
try { idLocal = JSON.parse(execFileSync('gh', ['api', `repos/${VIEJO}`], { encoding: 'utf8' })).id; } catch { /* ya no existe: se transfirió */ }
if (idLocal && idLocal !== repo.id) salir(`${VIEJO} sigue existiendo y es OTRO repo (id ${idLocal} vs ${repo.id}): la transferencia no ocurrió.`);

// 3. Reescribir. Dos exclusiones, y las dos las encontró un ENSAYO sobre una copia, no una
//    revisión del código: los dos fallos eran silenciosos y se habrían visto semanas después.
//
//    (a) El NOMBRE del servidor en el registro MCP, `io.github.Nicoiakl/nyx5`, NO se toca. Cuelga
//        de la cuenta de GitHub de Nicholas, no del repo, y Nicholas decidió el 4-nov conservarlo.
//        Reescribirlo publicaría una entrada NUEVA y dejaría huérfana la que la gente conoce.
//        Lo mismo vale para `mcpName` en package.json, que el registro exige idéntico.
//    (b) `test/fixtures/` es EVIDENCIA: la entrada real que bajó curl del registro. Un fixture no
//        se actualiza, se conserva, o la prueba deja de comparar contra lo que de verdad pasó.
const PROTEGIDO = /^io\.github\./;              // el prefijo del nombre del servidor
const EXCLUIDOS = (rel) => rel.startsWith('test/fixtures/');
const reemplazar = (texto) => texto.replaceAll(`io.github.${VIEJO}`, `\u0000NOMBRE\u0000`)
  .replaceAll(VIEJO, NUEVO)
  .replaceAll(`\u0000NOMBRE\u0000`, `io.github.${VIEJO}`);

const archivos = execFileSync('git', ['grep', '-l', VIEJO], { cwd: raiz, encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter((rel) => {
  if (EXCLUIDOS(rel)) { console.log(`  omitido   ${rel}  (evidencia: un fixture no se actualiza)`); return false; }
  return true;
});
let total = 0;
for (const rel of archivos) {
  const abs = path.join(raiz, rel);
  const antes = fs.readFileSync(abs, 'utf8');
  const despues = reemplazar(antes);
  const n = antes.split(VIEJO).length - 1 - (antes.split(`io.github.${VIEJO}`).length - 1);
  total += n;
  console.log(`  ${seco ? 'cambiaría' : 'cambiado'}  ${rel}  (${n})`);
  if (!seco) fs.writeFileSync(abs, despues);
}
console.log(`${seco ? 'se cambiarían' : 'cambiadas'} ${total} menciones en ${archivos.length} archivos`);

if (seco) process.exit(0);

// 4. Lo que npm exige literalmente: que `repository.url` coincida con el repo. Se comprueba
//    aparte porque es la única mención cuyo error no se ve hasta que falla una publicación.
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const url = String(pkg.repository?.url || '');
if (!url.includes(NUEVO)) salir(`package.json repository.url quedó en "${url}": npm exige que coincida con ${NUEVO}`);
console.log(`ok · package.json repository.url -> ${url}`);

// El nombre del servidor y `mcpName` tienen que seguir siendo los de antes, y tienen que
// coincidir entre sí: el registro rechaza la publicación si difieren.
const srv = JSON.parse(fs.readFileSync(path.join(raiz, 'server.json'), 'utf8'));
if (!PROTEGIDO.test(srv.name) || srv.name !== `io.github.${VIEJO}`) salir(`server.json name quedó en "${srv.name}": tenía que seguir siendo io.github.${VIEJO}`);
if (pkg.mcpName !== srv.name) salir(`package.json mcpName ("${pkg.mcpName}") no coincide con server.json name ("${srv.name}")`);
console.log(`ok · nombre del servidor intacto -> ${srv.name}`);

// 5. El remoto local, o el próximo push seguiría yendo por el redirect de GitHub sin avisar.
try {
  execFileSync('git', ['remote', 'set-url', 'origin', `https://github.com/${NUEVO}.git`], { cwd: raiz });
  console.log(`ok · remoto origin -> https://github.com/${NUEVO}.git`);
} catch (e) { console.error(`aviso: no se pudo reapuntar el remoto (${e.message}); hazlo a mano`); }

console.log('\nFalta, y en este orden:');
console.log('  1. npm test && git commit && git push');
console.log('  2. una versión de parche, para que el publicador nuevo de npm quede ligado (caduca en 2 días)');
console.log('  3. node scripts/publicar-registro.mjs  (la entrada del registro apunta al repo)');
console.log('  4. borrar el publicador viejo en npmjs.com y el secreto NPM_TOKEN');
