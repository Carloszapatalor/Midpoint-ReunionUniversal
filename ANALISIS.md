# Análisis técnico — oportunidades de mejora

Revisión integral del proyecto al 2026-04-19. Los hallazgos están agrupados por prioridad: **Bloqueantes / bugs reales**, **Seguridad**, **Performance**, **Arquitectura y código**, **Frontend y UX**, **Tooling y DevEx**, y **Mejoras opcionales**.

Cada ítem incluye archivo y línea donde aplica.

---

## 1. Bugs reales

### 1.1 Typo visible en el botón de salir
`public/app.js:195`

```js
document.getElementById("btn-signin").textContent = "Entrarxd";
```

Debería ser `"Entrar"`. El usuario ve "Entrarxd" tras cerrar sesión.

### 1.2 XSS almacenado en la lista de participantes
`public/app.js:344`

`renderParticipantList` interpola directamente `participant.nick` y `participant.timezone` en `innerHTML` sin escapar:

```js
return `<div class="participant-pill">${participant.nick} <span>${timezone} · ${slots} bloque(s)</span></div>`;
```

El backend solo valida que el nick sea un string no vacío (`main.ts:87`), así que un nick como `<img src=x onerror=alert(1)>` ejecuta JS en el navegador de todos los participantes de esa reunión. La función `escapeHtml` ya existe (`app.js:27`) y se usa correctamente en el tooltip UTC, pero no aquí.

**Fix**: envolver ambas interpolaciones con `escapeHtml(...)` y, además, validar el nick en backend (longitud, charset permitido).

### 1.3 Doble import de Hono
`main.ts:1-2` vs `deno.json:9`

```ts
// main.ts
import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
```

```jsonc
// deno.json
"imports": { "hono": "jsr:@hono/hono@^4.0.10" }
```

El proyecto declara Hono en el import map pero lo importa por URL sin pin de versión. Resultado: descarga una copia distinta de la declarada, el import map queda muerto, y no hay reproducibilidad. Unificar en `jsr:@hono/hono` usando `"hono"` y `"hono/mod.ts"`.

### 1.4 `deno.lock` ignorado pero `"lock": false`
`deno.json:2` + `.gitignore:6`

La combinación desactiva el lockfile. Sin lock, dos máquinas pueden resolver versiones transitivas diferentes para los mismos imports URL, reintroduciendo bugs al azar. Quitar `"lock": false`, dejar que Deno genere `deno.lock` y **versionarlo**.

### 1.5 Foreign keys declaradas pero no enforzadas
`torso.ts:150`

SQLite/libSQL requiere `PRAGMA foreign_keys = ON` por conexión para enforzar FKs. La HTTP API de Turso no mantiene sesión entre requests, así que cada sentencia arranca con FKs **desactivadas** por defecto. La clave foránea `meeting_uid` es puramente declarativa.

**Fix**: anteponer `PRAGMA foreign_keys = ON;` en cada request, o confiar exclusivamente en validaciones de aplicación (que de hecho ya se hacen en `saveMeetingParticipantTorso`).

### 1.6 `schemaPromise` envenenado ante fallo
`torso.ts:122-168`

Si el primer `ensureSchema()` falla (red intermitente al arrancar, token inválido), la promesa rechazada queda cacheada para siempre. Todos los requests siguientes fallan con el mismo error sin reintento posible hasta reiniciar el proceso.

**Fix**: resetear `schemaPromise = null` en el `.catch` para permitir reintento en el siguiente request.

### 1.7 `test-turso.ts` consulta una tabla inexistente
`test-turso.ts:32`

```ts
statements: [{ q: "SELECT * FROM users LIMIT 1" }]
```

La tabla `users` no existe en este esquema. El script muestra "error en la respuesta" aunque la conexión esté bien configurada. Cambiar a `SELECT 1` o a `SELECT * FROM meetings LIMIT 1` (después de haber corrido la app una vez).

### 1.8 Conversión UTC anclada a fecha fija y DST
`public/app.js:2-3, 237-248`

`REFERENCE_MONDAY` = 2025-01-06 (UTC). `toUtcSlot` construye un `Date` local en esa fecha y extrae UTC. Para usuarios en zonas sin DST (México, Argentina) el mapeo es correcto y estable. Para zonas que observan DST (CDMX ya no, pero New York, London, Sydney sí), el mapeo se hace con el offset de **enero** (invierno norte). Si ese usuario quiere disponibilidad en julio, su mapeo estará desfasado una hora.

El proyecto trata los slots como "semana genérica recurrente", no fechas concretas, por lo que la decisión es semántica: los usuarios en zonas DST deben actualizar su horario dos veces al año. Vale la pena dejarlo documentado en la UI (hecho parcialmente en `DOCUMENTATION.md §10`) o, mejor, calcular la conversión tomando la semana **actual** del usuario como ancla.

---

## 2. Seguridad

### 2.1 Sin rate limiting en creación de reuniones
`main.ts:13-28`

`POST /api/meetings` no tiene límite. Un atacante puede spamear reuniones y llenar la DB de Turso (consume filas y reads). Añadir middleware simple por IP (`jsr:@hono/hono/rate-limiter` o implementación in-memory) con límite, p.ej., 5/minuto.

### 2.2 Sin límites de tamaño en payloads
`main.ts:82-109`

- `title`: sin longitud máxima.
- `nick`: sin longitud ni charset.
- `localSchedule` / `utcSchedule`: sin cota en número de elementos.
- `timezone`: sin validación contra la lista IANA.

Un cliente puede enviar `localSchedule` con millones de strings y la DB los guarda como JSON. Añadir `.slice(0, N)` y validaciones de longitud en strings. Para `timezone`, usar `Intl.supportedValuesOf("timeZone")` o whitelist.

### 2.3 Sin validación del formato de slot
`main.ts:94-96`

El backend acepta cualquier array de strings. Un cliente malicioso (o uno bugueado) puede mandar `localSchedule: ["<script>", "a-b-c-d"]` y se almacena tal cual, luego se devuelve a otros clientes y puede combinarse con otros vectores.

**Fix**: validar con regex `^[0-6]-(?:[0-9]|1[0-9]|2[0-3])$` y descartar ítems no válidos.

### 2.4 `test-turso.ts` loggea parcialmente el token
`test-turso.ts:18`

```ts
console.log("✅ TURSO_AUTH_TOKEN:", TURSO_AUTH_TOKEN.substring(0, 20) + "...");
```

20 chars de un token JWT incluyen el header base64, que revela el algoritmo y la issuer. Riesgo bajo, pero innecesario: no loggear nada del token, solo `configurado ✓` si existe.

### 2.5 Modelo de autorización basado en "el que tenga el link"
Arquitectura general

Cualquiera con el UID de la reunión puede leer datos y registrarse con el nick que quiera (si no está tomado). Suficiente para el caso de uso casual, pero documentarlo explícitamente y no reutilizar el proyecto para información sensible.

Ideas para robustecer más adelante:
- Código secreto opcional al crear la reunión que se incluye en la URL (`?meeting=UID&k=SECRET`).
- Token firmado por participante en vez de UID en localStorage.

---

## 3. Performance

### 3.1 `saveMeetingParticipantTorso` hace 4 round trips cuando basta 1
`torso.ts:320-411`

Flujo actual por cada guardado:
1. `ensureSchema()` — normalmente cacheado en proceso, pero aun así hay await.
2. `getMeetingRow(meetingUid)` — verifica existencia de la reunión.
3. `executeStatements([nickConflict])` — checa si el nick está tomado.
4. `executeStatements([upsert])` — hace el INSERT/UPDATE.

El índice `idx_meeting_participants_meeting_nick` **ya enforce** la unicidad de nick. El upsert puede:
- Apoyarse en un `WHERE EXISTS (SELECT 1 FROM meetings WHERE uid = ?)` para asegurar la reunión.
- Dejar que la UNIQUE violation dispare error y ahí interpretar que el nick ya existe (parseando `SQLITE_CONSTRAINT_UNIQUE` o buscando substring del mensaje).

Alternativa más limpia: ejecutar las 3 últimas sentencias en un solo batch request y procesar el resultado. Menos latencia (1 RTT vs 3) y costo Turso menor.

### 3.2 `getMeetingTorso` hace 2 requests secuenciales
`torso.ts:231-270`

El comentario en el código dice que se separan por el formato inconsistente del batch. Dos mejoras posibles:

- **Paralelizar** con `Promise.all([meeting, participants])` → 1 RTT en vez de 2.
- **Consolidar en 1 SELECT con LEFT JOIN** que traiga meeting + participants en filas repetidas, y deduplicar meeting en el mapeo.

La segunda reduce reads facturados a Turso a la mitad.

### 3.3 Post-save innecesario
`public/app.js:690`

```js
applyUserData(payload.participant);
await loadMeeting(currentMeeting.uid, { restoreSession: false });
```

`saveUser` aplica el participante retornado y **además** recarga la reunión completa. El `loadMeeting` agrega una HTTP request + un re-pintado completo por cada guardado. Alternativa: hacer el merge en memoria sustituyendo el participante en `currentMeeting.participants[]` y llamar `updateUI()`.

Lo mismo aplica a `signIn` (`app.js:651-652`): aplicar el participante y mergearlo localmente sin recargar.

### 3.4 Polling sin backoff ni `If-Modified-Since`
`public/app.js:720-737`

Intervalo fijo de 15s aunque el usuario tenga la pestaña al frente sin cambios. Tres mejoras incrementales:
- Backoff exponencial en error (1×, 2×, 4× hasta un tope).
- Enviar `If-Modified-Since` o un hash del último `updatedAt` y que el backend responda `304` cuando no haya cambios.
- Considerar **SSE** (`text/event-stream`) cuando haya >2 participantes activos: el servidor emite una notificación al guardar y los clientes invalidan su vista. Hono soporta streaming nativamente.

### 3.5 `buildUtcAggregate` se recalcula en cada click local
`public/app.js:302-323, 388-420`

Cada toggle de celda llama `updateUI()` → `buildUtcAggregate()` → recorre todos los participantes. Para reuniones grandes, el costo sube O(participantes × slots). Optimización: mantener el aggregate precomputado desde los datos del servidor y, al cambiar la selección local, sumar/restar solo el delta del usuario actual. Innecesario para <50 participantes; útil si la app crece.

### 3.6 Tailwind CDN en producción
`public/index.html:7`

`<script src="https://cdn.tailwindcss.com">` hace JIT en el cliente. Impacto: ~60KB de JS extra + trabajo del motor de reglas en cada render. Si el proyecto se estabiliza, precompilar Tailwind una vez y servir el CSS resultante. Alternativa Deno-nativa: `npm:@tailwindcss/cli` en un script de build.

### 3.7 Schema init bloquea el primer request de cada arranque
`torso.ts:122`

Cold start → el primer usuario espera los 4 DDL. Poco crítico pero se puede lanzar `ensureSchema()` al arrancar el servidor (`main.ts` justo antes de `Deno.serve`) para que el primer request ya tenga el schema listo.

---

## 4. Arquitectura y código

### 4.1 API HTTP de Turso legacy
`torso.ts:91-120`

El endpoint `POST /` con `{ statements: [...] }` es el contrato v1 de Turso, deprecado. La API moderna es Hrana sobre HTTP (`/v2/pipeline`) o websockets. Migrar trae:
- Mejor documentación y soporte.
- Usar el cliente oficial `npm:@libsql/client/web` (funciona en Deno) que abstrae el transporte, types y errores.
- Eliminar `unwrapTursoPayload`, `getTursoError`, `getFirstResult`, `rowsToObjects` — todo el código de parsing ad-hoc.

Ejemplo con el cliente oficial:

```ts
import { createClient } from "npm:@libsql/client/web";
const db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
const rs = await db.execute({ sql: "SELECT * FROM meetings WHERE uid = ?", args: [uid] });
```

Reduce `torso.ts` a la mitad y habilita transacciones atómicas.

### 4.2 Error handling por substring
`main.ts:106`

```ts
const status = message.includes("ya esta en uso") ? 409 : message.includes("no existe") ? 404 : 500;
```

Frágil: cualquier cambio en el wording del error rompe los status codes. Reemplazar por clases de error tipadas:

```ts
class ConflictError extends Error { status = 409 }
class NotFoundError extends Error { status = 404 }
```

Y un middleware central de Hono:

```ts
app.onError((err, c) => {
  const status = (err as any).status ?? 500;
  return c.json({ error: err.message }, status);
});
```

Elimina los cinco `try/catch` repetidos en `main.ts`.

### 4.3 Sin middleware de logging
`main.ts`

Actualmente solo hay `console.error`. Añadir `app.use(logger())` de Hono expone método, path, status y latencia. Útil para depurar en local y esencial al desplegar.

### 4.4 Coexisten `Deno.serve` y `export default app`
`main.ts:113, 115-129`

El warning que aparece al arrancar proviene de esta dualidad. Decidir:
- **Si es solo dev local**: eliminar `export default app` y quedarse con `Deno.serve`.
- **Si se va a desplegar en Deno Deploy**: eliminar el bloque `Deno.serve` y usar `deno serve`, que es el modo soportado por Deploy.

### 4.5 `main.ts` como archivo único para todas las rutas
5 endpoints caben en un archivo, pero si crece, separar en `routes/meetings.ts` y `routes/participants.ts` con subrouters de Hono (`app.route("/api/meetings", meetingsRouter)`).

### 4.6 Mezcla de `onclick="..."` inline y `addEventListener`
`public/index.html:28, 49, 60, 63` vs `public/app.js:450-453`

Los botones usan `onclick="createMeeting()"` con globales en `window`, mientras que las celdas del grid usan `addEventListener`. Unificar a un solo modelo (preferir addEventListener) mejora la legibilidad y permite eliminar las globals.

### 4.7 `ensureSchema` emite 4 DDL que podrían ser 1 batch
`torso.ts:129-166`

Ya está batcheado (array de 4 statements en un solo POST). OK. Pero por el quirk de la respuesta, verificar que `getTursoError` detecta errores en cualquiera de las 4, no solo en el primero. El código actual sí recorre `results[]`, bien.

### 4.8 Sin graceful shutdown
`main.ts:119`

`Deno.serve` no maneja SIGTERM para drenar conexiones. En deployment con orquestador (Kubernetes, Cloud Run) podría cortar requests en vuelo. `addEventListener("SIGTERM", ...)` y `server.shutdown()` lo resuelven si se persigue robustez.

---

## 5. Frontend y UX

### 5.1 Sin selección por arrastre (drag-to-select)
`public/app.js:461-475`

Marcar 30 horas requiere 30 clics. Añadir `mousedown + mouseenter` para seleccionar rangos completos es un cambio de ~20 líneas y multiplica la usabilidad.

### 5.2 Sin indicador de "cambios sin guardar"
El usuario puede hacer clic, salir sin guardar y perderlo todo. Un contador pequeño `"N bloques sin guardar"` junto al botón "Guardar horario" y un estado visual del botón (p.ej., pulso naranja) cubre el gap.

### 5.3 `Enter` no envía formularios
`public/index.html`

- `#meeting-title` + botón crear: `Enter` no crea la reunión.
- `#nick` + botón entrar: `Enter` no hace login.

Agregar `<form>` con `onsubmit` o listeners `keydown.Enter` es trivial.

### 5.4 Sin control para cambiar nick, borrar horario o salir limpio
La única forma de "salir" es el botón signin (cuyo estado cambia a "Salir"). No hay opción para borrar todos los bloques de un solo tap ni para cambiar nick sin perder el UID.

### 5.5 Accesibilidad
- El grid es una matriz de `<button>` sueltos, sin `role="grid"` ni `aria-label` que diga "Lunes 14:00, disponible/no disponible".
- La información de disponibilidad en la vista UTC se codifica **solo en color** (intensidad verde). Usuarios con discromatopsia no distinguirán niveles. El número dentro de cada celda ayuda parcialmente.
- Sin focus visible diferenciado más allá del default del navegador.

### 5.6 Tooltip UTC se renderiza en `body` pero no se posiciona en teclado
`public/app.js:36-123`

Solo responde a mouse. Usuarios con teclado/lector no ven los nicks. `focusin`/`focusout` en las celdas + tooltip posicionado sobre el elemento resolvería.

### 5.7 Mobile
Hay media query a 900px (`styles.css:368`) que colapsa el grid. A 400px con 7 columnas de ancho mínimo, las celdas quedan ~40px cada una, difíciles de tapear. Considerar vista vertical (lista de días con horas colapsables) en móviles.

### 5.8 El link compartido es la URL completa del dispositivo
`public/app.js:129-134`

`getMeetingLink` usa `window.location.href` como base, así que si el usuario está en `http://192.168.1.5:8000/?meeting=X`, eso es lo que comparte. En local está bien; desplegado detrás de un proxy, validar que `location.origin` sea el esperado.

### 5.9 Sin i18n
Textos hardcodeados en español. Aceptable dado el público, pero mencionar para futura expansión.

---

## 6. Tooling y DevEx

### 6.1 Sin tareas de formato, lint y typecheck
`deno.json:3-7`

Añadir:
```jsonc
"tasks": {
  "fmt": "deno fmt",
  "lint": "deno lint",
  "check": "deno check main.ts torso.ts",
  "ci": "deno task fmt --check && deno task lint && deno task check"
}
```

### 6.2 Sin tests
Ni unit, ni integración, ni e2e. Áreas que se beneficiarían más:
- `toUtcSlot` / `toUtcScheduleFromLocal`: funciones puras, fáciles de testear con `Deno.test`.
- Endpoints HTTP con `app.fetch` (Hono expone fetch API, no hace falta levantar server real).
- `torso.ts`: testear con un stub de `fetch` que simule respuestas de Turso.

### 6.3 Sin CI
Añadir `.github/workflows/ci.yml` con `deno task ci` al push/PR evita regresiones.

### 6.4 Sin Dockerfile ni config de deploy
Si se piensa publicar, un `Dockerfile` de 10 líneas o un `deno.json` compatible con Deno Deploy cerrarían el ciclo.

### 6.5 `deno.lock` ignorado
Ver **1.4**.

### 6.6 `.env.example` no declara `PORT`
El código lee `PORT` (`main.ts:116`) pero `.env.example` no lo menciona. Añadir `# PORT=8000` como comentario.

---

## 7. Mejoras opcionales (nice to have)

### 7.1 Historial de cambios
Una tabla `meeting_participant_history` con el schedule anterior cada vez que se guarda permite "ver quién cambió qué". No crítico.

### 7.2 Exportar a iCal / Google Calendar
Endpoint `/api/meetings/:uid.ics` que genere un archivo iCalendar con los mejores slots.

### 7.3 Soporte de granularidad ajustable (30 min, 15 min)
Requiere refactor del formato de slot (`"día-hora-minuto"`), cambio en rejilla, cambio en conversión UTC. Grande pero muy solicitado por usuarios.

### 7.4 Capa de caché en memoria
Para reuniones populares, mantener `currentMeeting` en memoria del proceso con TTL corto (5s) para que el polling de 100 clientes no se traduzca a 100 queries Turso. Útil solo en escala.

### 7.5 Métricas
Contador de reuniones creadas / participantes activos / guardados por minuto. Exportable a OpenTelemetry o simplemente a `/metrics` en formato Prometheus. Relevante si se despliega.

### 7.6 Borrado de reuniones huérfanas
Reuniones sin participantes después de N días → candidatas a purga. Endpoint admin o cron job.

---

## Resumen ejecutivo — qué atacar primero

Si se tuviera que priorizar un solo sprint de mejoras:

1. **Fixear el XSS del nick** (1.2) y **validar inputs** (2.2, 2.3). Son los únicos problemas con potencial de daño real.
2. **Corregir typo "Entrarxd"** (1.1), **unificar imports de Hono** (1.3), **versionar `deno.lock`** (1.4).
3. **Migrar `torso.ts` al cliente oficial `@libsql/client/web`** (4.1). Elimina ~150 líneas y la deuda con el API legacy.
4. **Colapsar los 4 round trips de `saveMeetingParticipantTorso` a 1** (3.1).
5. **Middleware central de errores** (4.2) + **logger** (4.3). Quita boilerplate y mejora debugging.
6. **Drag-to-select en el grid** (5.1) y **Enter submits** (5.3). Mejoras de UX baratas y visibles.
7. **Setear `deno fmt` / `lint` / `check` + CI** (6.1, 6.3). Previene regresiones a futuro.

Todo lo demás es incremental y puede diferirse.
