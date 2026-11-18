-- 0011 · Los encargos pasan al vocabulario A2A (fase 1 de la orden, completada).
--
-- El encargo nació el 17-nov con cinco estados míos y la orden que Nicholas aprobó pide los OCHO
-- de A2A. El spec acordado manda sobre mi vocabulario, así que esto traduce lo que ya está escrito.
-- La traducción, que es la misma que aplica `src/libro/encargos.js`:
--
--     open       -> submitted
--     taken      -> working
--     delivered  -> input-required     (una entrega que espera revisión depende de una persona)
--     done       -> completed
--     cancelled  -> canceled           (una sola ele, como A2A)
--
-- CUIDADO, Y ES LA RAZÓN DE QUE ESTO SEA UNA MIGRACIÓN Y NO UN `replace()` SOBRE EL DOC:
-- `delivered` es a la vez un ESTADO y el nombre del CAMPO que guarda la entrega
-- (`doc.delivered = { at, by, note, evidence_sha256, url }`). Un reemplazo de texto sobre el
-- documento entero renombraría también el campo y la entrega quedaría invisible. Por eso se usa
-- `json_set` sobre `$.state`, que sólo puede tocar el estado.
--
-- Los estados del HISTORIAL (`$.log[n].state`) se traducen también, uno por uno hasta el séptimo
-- paso: dejar el log con un vocabulario que ya no existe convierte el historial en algo que el
-- tablero no sabe leer. No se altera ningún hecho — ni el `at`, ni el `by`, ni el `paso` — sólo la
-- etiqueta del estado, y la tabla de arriba deja escrito de dónde viene cada nombre.
--
-- En una base nueva esto no encuentra ninguna fila, y eso está bien: la migración es idempotente
-- por construcción, porque después de correr ya no queda ningún estado viejo que calce.

UPDATE nyx5_encargos SET doc = json_set(doc, '$.state',
  CASE json_extract(doc, '$.state')
    WHEN 'open'      THEN 'submitted'
    WHEN 'taken'     THEN 'working'
    WHEN 'delivered' THEN 'input-required'
    WHEN 'done'      THEN 'completed'
    WHEN 'cancelled' THEN 'canceled'
    ELSE json_extract(doc, '$.state')
  END)
WHERE json_extract(doc, '$.state') IN ('open', 'taken', 'delivered', 'done', 'cancelled');

-- El historial, paso por paso. Siete es el tope de PASOS más el `crear`, y un encargo con más
-- vueltas que eso conserva las etiquetas viejas en las entradas de más: queda dicho aquí en vez de
-- pretender que el bucle existe. SQLite no tiene uno.
UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[0].state',
  CASE json_extract(doc, '$.log[0].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[0].state') END)
WHERE json_extract(doc, '$.log[0].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[1].state',
  CASE json_extract(doc, '$.log[1].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[1].state') END)
WHERE json_extract(doc, '$.log[1].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[2].state',
  CASE json_extract(doc, '$.log[2].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[2].state') END)
WHERE json_extract(doc, '$.log[2].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[3].state',
  CASE json_extract(doc, '$.log[3].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[3].state') END)
WHERE json_extract(doc, '$.log[3].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[4].state',
  CASE json_extract(doc, '$.log[4].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[4].state') END)
WHERE json_extract(doc, '$.log[4].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[5].state',
  CASE json_extract(doc, '$.log[5].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[5].state') END)
WHERE json_extract(doc, '$.log[5].state') IS NOT NULL;

UPDATE nyx5_encargos SET doc = json_set(doc, '$.log[6].state',
  CASE json_extract(doc, '$.log[6].state') WHEN 'open' THEN 'submitted' WHEN 'taken' THEN 'working'
  WHEN 'delivered' THEN 'input-required' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled'
  ELSE json_extract(doc, '$.log[6].state') END)
WHERE json_extract(doc, '$.log[6].state') IS NOT NULL;

-- Los tres campos que la orden pedía y que los encargos de antes no tienen. Se ponen en null
-- explícito en vez de dejarlos ausentes: una lectura que distingue «no declarado» de «no existe el
-- campo» es una lectura con dos caminos, y uno de los dos nunca se prueba.
UPDATE nyx5_encargos SET doc = json_set(doc, '$.project', NULL) WHERE json_extract(doc, '$.project') IS NULL AND json_type(doc, '$.project') IS NULL;
UPDATE nyx5_encargos SET doc = json_set(doc, '$.reason', NULL)  WHERE json_type(doc, '$.reason')  IS NULL;
UPDATE nyx5_encargos SET doc = json_set(doc, '$.due', NULL)     WHERE json_type(doc, '$.due')     IS NULL;
