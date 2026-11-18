-- 0010 · Encargos (SPEC v0.2, opción B): trabajo interno con dueño y estado, SIN dinero.
--
-- Un encargo es lo que un agente de la casa le pide a otro: tiene dueño, estado y, si hace falta,
-- un padre del que cuelga. No tiene precio, no abre escrow y no mueve reputación.
--
-- Por qué tabla propia y no un contrato de valor cero (comprobado contra el código el 17-nov-2026,
-- no contra el diseño: no existía ninguna tabla de tareas, y una tarea tomada vivía como un escrow
-- común reconocible sólo por `terms.seed_task`). Un encargo metido en `nyx5_libro_contratos`
-- contaminaría las tres cosas que leen esa tabla completa: el reloj de la casa, que barre `held` y
-- `delivered` buscando qué verificar y qué vencer; el índice de reputación; y las cuentas del
-- reporte. Y un contrato de cero sería dinero que no existe ocupando un número de asiento.
--
-- `doc` guarda el encargo íntegro. Sin columna de estado ni de padre: las dos ya viven en el doc y
-- una columna aparte sería una segunda verdad que mantener (misma razón escrita en la 0009). Los
-- dos índices son de expresión, para que el tablero lea sólo lo abierto y los hijos de un padre
-- sin recorrer la tabla.
CREATE TABLE IF NOT EXISTS nyx5_encargos (
  id   TEXT PRIMARY KEY,
  doc  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nyx5_encargos_estado ON nyx5_encargos (json_extract(doc, '$.state'));
CREATE INDEX IF NOT EXISTS nyx5_encargos_padre  ON nyx5_encargos (json_extract(doc, '$.parent_id'));
