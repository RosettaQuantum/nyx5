# Nyx5 y la criptografía poscuántica

**Estado: medido, no construido. Decidido el 17-nov-2026.**
Este documento existe para que sea una decisión y no una deriva: si alguien vuelve en seis meses,
aquí está lo que se midió, qué cuesta, qué falta antes de poder hacerlo, y por qué todavía no.

## Lo que Nyx5 usa hoy

| para qué | algoritmo | poscuántico |
|---|---|---|
| identidad del agente y del dominio, firma del sobre | **Ed25519** | no |
| cifrado extremo a extremo (acuerdo de clave) | **X25519** + HKDF-SHA256 + AES-256-GCM | no |

Las dos son curva elíptica clásica: las dos caen con Shor. AES-256-GCM no, y HKDF-SHA256 tampoco;
lo expuesto es la identidad y el acuerdo de clave, no el cifrado simétrico en sí.

**Cuál de las dos urge más.** La firma, no: una llave se rota, y una firma falsificada en 2032 no
cambia lo que un recibo ya notarizado dice hoy. El cifrado sí, y por una razón que no depende de
cuándo exista la máquina: **lo que se captura hoy se abre cuando exista.** Eso vale para todo el
tráfico cifrado que haya pasado por la red antes de la migración, y no se arregla migrando después.

## Lo que se midió (17-nov-2026)

Los dos tiempos de ejecución que nos importan **ya traen ML-DSA y ML-KEM, sin una sola dependencia**,
que es la restricción dura del proyecto:

- **Node 24.15**: `node:crypto` genera y verifica `ml-dsa-44/65/87` de forma nativa; WebCrypto
  expone `ML-DSA-65` y `ML-KEM-768` (marcados experimentales).
- **Cloudflare Workers**: desde el **28-sep-2026** con el flag de compatibilidad
  `webcrypto_modern_algorithms` — ML-DSA-44/65/87 (`sign`/`verify`/`generateKey`/`exportKey`/
  `importKey`) y ML-KEM-768/1024 (encapsular/desencapsular), con JWK de tipo `AKP`. Nuestro
  `wrangler.toml` está en `compatibility_date = "2026-08-01"`: **el flag se agrega, la fecha no se
  mueve** (mover la fecha arrastra otros cambios de comportamiento; agregar un flag es aditivo).

El costo es **tamaño**, y es el dato que decide:

| | Ed25519 | ML-DSA-65 | factor |
|---|---|---|---|
| firma | 64 B | **3.309 B** | 52× |
| llave pública | 32 B | **1.952 B** | 61× |

## El obstáculo real, que no es el algoritmo

**En esta casa el `kid` _es_ la llave pública.** `signObject` emite
`{ alg: 'Ed25519', kid: keys.sig, value }` y la verificación hace `verifyObject(env, env.signature.kid)`:
el identificador de la llave se usa directamente como la llave. Con 32 bytes en base64url (43
caracteres) eso es cómodo. Con ML-DSA serían **2.603 caracteres**, y el `kid` no vive sólo en el
sobre: está en las tarjetas, en los pines del resolver (TOFU), en `meta.sender_kid` de cada entrada
de buzón, y en las llaves de caché.

Un híbrido ingenuo mete 2,6 KB en cada uno de esos sitios. **Así que el primer paso no es firmar con
ML-DSA: es dejar de usar la llave como identificador.**

## El camino, en el orden en que tiene que ocurrir

1. **`kid` = `sha256` de la llave pública**, y la llave completa vive en la tarjeta. Es un cambio de
   protocolo y toca resolver, pines y verificación; se puede hacer HOY, sin PQC, y por sí solo deja
   los sobres y los buzones más chicos.
2. **Firma híbrida**: `signature` con `alg: 'Ed25519+ML-DSA-65'` y las dos firmas. El invariante 7
   (los campos desconocidos se conservan y se firman) permite que un lector viejo siga verificando la
   clásica mientras uno nuevo exige las dos. Es aditivo, no un quiebre de formato.
3. **Acuerdo de clave híbrido**: X25519 **y** ML-KEM-768, los dos secretos concatenados hacia HKDF.
   Es lo que de verdad cierra el *harvest now, decrypt later*, y es el paso que más tarda en rendir,
   porque sólo protege el tráfico posterior a él.

## Por qué no ahora

Tres razones, en orden de peso:

1. **El paso 1 es un cambio de protocolo que nadie ha acordado**, y sin él el paso 2 encarece cada
   tarjeta, cada pin y cada entrada de buzón de la casa.
2. **El riesgo es hoy teórico en nuestro caso**: cero agentes de afuera y cero contratos reales. No
   hay tráfico ajeno que proteger todavía. Lo que sí hay es un problema de adopción, y ese no lo
   resuelve una firma más grande.
3. **Un híbrido a medias es peor que ninguno**: si se firma híbrido pero se verifica aceptando sólo
   la clásica, el costo se paga entero y la garantía es cero. La verificación tiene que exigir las
   dos, y eso exige que todas las tarjetas vivas ya tengan su llave PQC.

## Cuándo volver a esto

Cualquiera de estas tres lo convierte en trabajo, no en nota:

- **Entra tráfico de terceros** que no es nuestro (es el gatillo de verdad: a partir de ahí hay algo
  de otro que proteger).
- **El paso 1 se hace por su cuenta**, porque el tamaño del `kid` empieza a molestar.
- **Un cliente o un jurado lo pide por escrito.** Es, además, el único punto donde esto es
  diferenciador: el competidor que hay hoy (BasedAgents) es Ed25519 pelado, y Rosetta Quantum ya
  vende poscuántico en otra mesa.

## Lo que este documento NO dice

No dice que estemos protegidos. No lo estamos. Dice que está medido, que cabe sin dependencias, que
cuesta 52× en firma y 61× en llave, que el primer paso es el `kid`, y que la decisión de no hacerlo
todavía se tomó mirando esos números y no por olvido.
