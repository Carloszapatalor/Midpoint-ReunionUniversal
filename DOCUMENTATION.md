# Documentación técnica — Agenda compartida de reuniones

Aplicación web para coordinar horarios entre varias personas en distintas zonas horarias. Cada reunión tiene un link compartible; cada participante marca su disponibilidad en su horario local y la aplicación cruza los horarios en UTC para identificar los mejores puntos de coincidencia.

---

## 1. Stack

| Capa | Tecnología |
|---|---|
| Runtime | Deno |
| Framework HTTP | Hono (`jsr:@hono/hono@^4.0.10`) |
| Base de datos | Turso (libSQL) vía HTTP API |
| Frontend | HTML + Tailwind CDN + JavaScript vanilla |
| Persistencia de sesión | `localStorage` del navegador |

No hay bundler, transpilador ni dependencias de build. Los archivos del directorio `public/` se sirven tal cual.

---

## 2. Estructura del proyecto

```
ReunionUniversal/
├── main.ts              Servidor Hono y endpoints HTTP
├── torso.ts             Capa de acceso a Turso (fetch directo)
├── test-turso.ts        Script de diagnóstico de conexión
├── deno.json            Tasks e import map
├── .env                 TURSO_URL y TURSO_AUTH_TOKEN (no versionado)
├── .env.example         Plantilla de variables
└── public/
    ├── index.html       Marcado de la SPA
    ├── styles.css       Estilos propios (complementan Tailwind CDN)
    └── app.js           Lógica del cliente
```

---

## 3. Requisitos y configuración

### 3.1 Prerrequisitos

- Deno ≥ 1.40 (`brew install deno`).
- Una base de datos en Turso con su auth token.

### 3.2 Variables de entorno

Copiar `.env.example` → `.env` y completar:

```
TURSO_URL=https://<nombre-db>-<org>.turso.io
TURSO_AUTH_TOKEN=<token>
```

**Importante**: `TURSO_URL` debe usar esquema `https://`, no `libsql://`. El código hace `fetch` directo contra esa URL y `fetch` de Deno no soporta el esquema `libsql`.

### 3.3 Tareas disponibles (`deno.json`)

| Tarea | Descripción |
|---|---|
| `deno task dev` | Levanta el servidor en modo `--watch`. |
| `deno task start` | Levanta el servidor sin watch. |
| `deno task test-turso` | Ejecuta `test-turso.ts` para validar la conexión a Turso. |

Puerto por defecto: `8000`. Override con `PORT=3000 deno task start`.

---

## 4. Arquitectura

### 4.1 Flujo de alto nivel

1. Un usuario crea una reunión (POST `/api/meetings`) y recibe un UID.
2. Comparte el link `http://host/?meeting=<uid>`.
3. Cada participante abre el link, escribe un nick y se registra (POST `/api/meetings/:uid/participants`). Se genera un UID de participante en el cliente y se persiste en `localStorage`.
4. El participante marca bloques de una hora en una rejilla semanal local. El cliente convierte cada bloque a su equivalente UTC y envía ambos arreglos al guardar.
5. La vista UTC agrega todos los horarios de todos los participantes y colorea las celdas según cuántas personas coinciden.
6. El cliente refresca la reunión cada 15 segundos para reflejar cambios de otros participantes.

### 4.2 Modelo de datos

Dos tablas en Turso, creadas automáticamente en el primer request (`ensureSchema` en `torso.ts:124`):

```sql
CREATE TABLE meetings (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE meeting_participants (
  uid TEXT PRIMARY KEY,
  meeting_uid TEXT NOT NULL,
  nick TEXT NOT NULL,
  local_schedule TEXT NOT NULL DEFAULT '[]',
  utc_schedule TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  FOREIGN KEY (meeting_uid) REFERENCES meetings(uid)
);

CREATE UNIQUE INDEX idx_meeting_participants_meeting_nick
  ON meeting_participants (meeting_uid, nick);
CREATE INDEX idx_meeting_participants_meeting_uid
  ON meeting_participants (meeting_uid);
```

Notas:

- `local_schedule` y `utc_schedule` se almacenan como JSON serializado (TEXT), no como estructuras relacionales. Cada ítem es un string `"<día>-<hora>"` donde `día ∈ [0..6]` (0 = Lunes) y `hora ∈ [0..23]`.
- El UID de reunión y de participante son UUIDs generados con `crypto.randomUUID()` (el de reunión en el backend, el de participante en el cliente).
- La unicidad del nick es por reunión, no global.

### 4.3 Capa de acceso — `torso.ts`

No se usa una librería cliente de libSQL. En su lugar, `executeStatements()` hace `POST` directo a `TURSO_URL` con el payload `{ statements: [{ q, params? }] }` y un header `Authorization: Bearer <token>`.

Dos particularidades importantes:

**(a) Inicialización perezosa del esquema.** Todas las funciones públicas hacen `await ensureSchema()`, que corre los `CREATE TABLE IF NOT EXISTS` e índices exactamente una vez por proceso. El resultado se memoiza en la variable `schemaPromise`. No existen migraciones externas; la primera llamada tras levantar el servidor es la que crea todo.

**(b) Formato inconsistente de respuesta en batches.** Turso responde un batch multi-sentencia como `[{ results: [stmt1] }, { results: [stmt2] }]` en vez de un solo objeto combinado. Por eso `getMeetingTorso` emite dos requests separados (primero la reunión, luego los participantes) y cada función auxiliar asume una sola sentencia por llamada. `unwrapTursoPayload()` y `getFirstResult()` están diseñados para esa suposición.

Errores de negocio se propagan como `Error` con mensajes específicos que `main.ts` mapea a códigos HTTP:

| Substring en el mensaje | Código HTTP |
|---|---|
| `"ya esta en uso"` | 409 Conflict |
| `"no existe"` | 404 Not Found |
| Cualquier otro | 500 Internal Server Error |

Upsert: `saveMeetingParticipantTorso` valida primero que el nick no esté tomado por otro UID en la misma reunión, luego ejecuta `INSERT ... ON CONFLICT(uid) DO UPDATE SET ...` para soportar registro y edición con la misma operación.

### 4.4 Frontend — `public/app.js`

Sin framework. Estado global en tres variables a nivel de módulo:

- `currentMeeting` — objeto `{ uid, title, createdAtUTC, participants[] }`.
- `currentUser` — `{ uid, nick, meetingUid }` o `null`.
- `localSchedule` — arreglo de strings `"día-hora"` del usuario activo.

El UID de la reunión viaja en el query string `?meeting=<uid>`. La sesión por reunión se persiste en `localStorage` con dos claves:

- `agenda:meeting:<uid>:participantUid` — UID del participante actual.
- `agenda:meeting:<uid>:session` — `{ uid, nick }` serializado.

Esto permite que al volver al link, el navegador restaure automáticamente al usuario sin volver a teclear su nick.

#### Agregación UTC

La función `toUtcSlot(localDay, localHour)` convierte un bloque local a su equivalente UTC anclando el cálculo a un **lunes de referencia fijo**: `2025-01-06`. Construye un `Date` local en esa fecha base y extrae `getUTCDay()` / `getUTCHours()`. Esto da un mapeo determinista que no depende de la fecha actual pero sí de la zona horaria del navegador.

`buildUtcAggregate()` recorre todos los participantes, acumula `{ count, nicks[] }` por cada slot UTC y calcula el `maxCount`. Para que las ediciones sin guardar del usuario actual se reflejen en vivo en la rejilla UTC, el cliente sustituye su propio `localSchedule` sobre los datos traídos del servidor antes de agregar.

El renderizado en `updateUI()`:

- Pinta celdas locales activas con `.cell-active`.
- Pinta celdas UTC con `.cell-utc` y modula la intensidad vía la CSS custom property `--availability-strength` (`count / total`).
- Marca con `.cell-best` los slots donde `count === maxCount` y con `.cell-all` donde todos coinciden.
- Tooltip flotante (`#utc-tooltip`) muestra los nicks disponibles al pasar el mouse.

#### Auto-refresh

`startAutoRefresh()` programa un `setInterval` de 15 segundos que repite `GET /api/meetings/:uid` mientras la pestaña esté visible (`document.hidden` lo pausa). El refresh no altera la sesión del usuario ni su `localSchedule` pendiente; solo refresca el listado de participantes y re-renderiza la vista UTC.

---

## 5. API HTTP

Base path: `/api/meetings`. Todos los endpoints producen y consumen JSON.

### 5.1 `POST /api/meetings`

Crea una reunión.

**Request**:
```json
{ "title": "Retro Q2" }
```

**Respuestas**:
- `201 Created` — `{ "ok": true, "meeting": { "uid", "title", "createdAtUTC" } }`
- `400 Bad Request` — `{ "error": "El titulo es requerido" }`
- `500 Internal Server Error` — `{ "error": "<mensaje>" }`

### 5.2 `GET /api/meetings/:meetingUid`

Devuelve la reunión y todos sus participantes.

**Respuestas**:
- `200 OK` — `{ "exists": true, "meeting": { "uid", "title", "createdAtUTC", "participants": [...] } }`
- `404 Not Found` — `{ "exists": false }`

Los participantes vienen ordenados por `updated_at_utc DESC, nick ASC`.

### 5.3 `GET /api/meetings/:meetingUid/participants/uid/:uid`

Busca un participante por su UID. Usado para restaurar la sesión desde `localStorage`.

**Respuestas**:
- `200 OK` — `{ "exists": true, "participant": { ... } }`
- `404 Not Found` — `{ "exists": false }`

### 5.4 `GET /api/meetings/:meetingUid/participants/nick/:nick`

Busca un participante por su nick dentro de la reunión. Usado al hacer login para reconocer si el nick ya existe.

**Respuestas**: mismas que 5.3.

### 5.5 `POST /api/meetings/:meetingUid/participants`

Crea o actualiza un participante. Upsert por `uid`.

**Request**:
```json
{
  "uid": "<uuid del participante>",
  "nick": "alexis",
  "localSchedule": ["0-9", "0-10", "3-14"],
  "utcSchedule": ["0-15", "0-16", "3-20"],
  "timezone": "America/Mexico_City"
}
```

**Respuestas**:
- `200 OK` — `{ "ok": true, "participant": { ... } }`
- `400 Bad Request` — `{ "error": "uid y nick son requeridos" }`
- `404 Not Found` — la reunión no existe.
- `409 Conflict` — el nick ya está en uso por otro participante en esta reunión.
- `500 Internal Server Error`

Forma del participante devuelto:

```json
{
  "uid": "...",
  "meetingUid": "...",
  "nick": "...",
  "localSchedule": ["0-9", "0-10"],
  "utcSchedule": ["0-15", "0-16"],
  "timezone": "America/Mexico_City",
  "updatedAtLocal": "Sun Apr 19 2026 14:30:00 GMT-0600 (CST)",
  "updatedAtUTC": "2026-04-19T20:30:00.000Z"
}
```

### 5.6 Archivos estáticos

Cualquier ruta que no empareje con los endpoints anteriores se sirve desde `./public` (`main.ts:111`). `GET /` devuelve `public/index.html`.

---

## 6. Identidad y sesiones

- No existe autenticación por contraseña, email u OAuth.
- La identidad del participante se basa en un UUID generado en el navegador, persistido en `localStorage`.
- El nick es el identificador humano y es único dentro de una reunión.
- Borrar el `localStorage` equivale a perder el acceso de edición a ese participante: si alguien entra con el mismo nick desde otro dispositivo, el servidor responde `409` por la restricción `UNIQUE(meeting_uid, nick)`.

Implicaciones de seguridad: cualquiera con el UID de la reunión puede ver y registrarse. No usar para información sensible.

---

## 7. Convenciones de horario

- Semana anclada a lunes. Índice de día: `0=Lun, 1=Mar, 2=Mie, 3=Jue, 4=Vie, 5=Sab, 6=Dom`.
- Horas: `0..23` (granularidad de 1 hora).
- Formato de slot: `"<día>-<hora>"`. Ejemplo: `"2-14"` = miércoles 14:00.
- `localSchedule` está en la zona horaria del navegador del participante.
- `utcSchedule` es la conversión a UTC, calculada en el cliente con `toUtcSlot()` usando el lunes 2025-01-06 como ancla.

---

## 8. Desarrollo local

```bash
# 1. Clonar y entrar al directorio
cd ReunionUniversal

# 2. Configurar variables
cp .env.example .env
# Editar .env con TURSO_URL (https://...) y TURSO_AUTH_TOKEN

# 3. Validar conexión (opcional)
deno task test-turso

# 4. Levantar servidor
deno task dev
# Abre http://localhost:8000
```

El modo `--watch` reinicia el proceso al cambiar archivos `.ts`, pero **no** recarga variables de `.env`. Tras editar `.env`, detener y volver a levantar.

---

## 9. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `TypeError: Url scheme 'libsql' not supported` | `.env` con `TURSO_URL=libsql://...` | Cambiar a `https://...`. |
| `dns error: failed to lookup address` | URL malformada (p.ej. `https://libsql//...`) | Revisar que no haya quedado residuo del esquema anterior. |
| `Variables de entorno de Turso no configuradas` | Falta `.env` o `TURSO_URL` / `TURSO_AUTH_TOKEN` vacíos | Validar con `deno task test-turso`. |
| `Puerto 8000 en uso` | Otra instancia ya corriendo | Matar el proceso o usar `PORT=8001 deno task start`. |
| `deno task couldn't find deno.json` | Ejecutando fuera de la raíz del proyecto | `cd` al directorio que contiene `deno.json`. |
| `warning: Detected export default { fetch }, did you mean to run "deno serve"?` | `main.ts` expone tanto `export default app` como `Deno.serve(...)` | Inofensivo. Opcional: migrar la task a `deno serve` y quitar el bloque `Deno.serve`. |
| Respuesta 409 al entrar con un nick existente | Otro participante (u otro dispositivo) ya tomó ese nick | Escoger otro nick o, si es el mismo usuario, restaurar la sesión desde el dispositivo original. |
| La vista UTC no se actualiza al marcar | Revisar que `currentUser` esté seteado y ver consola | El usuario debe haber entrado con su nick antes de poder editar. |

---

## 10. Limitaciones conocidas

- **Granularidad de 1 hora**. No hay bloques de 30 min.
- **Una semana abstracta**. La rejilla no representa una semana calendario específica; los slots son "lunes de cualquier semana", etc.
- **Sin histórico**. Cada guardado sobrescribe el anterior; no hay bitácora.
- **Sin autenticación real**. El UID del participante en `localStorage` es el único mecanismo de "pertenencia".
- **Conversión UTC fija a la fecha ancla**. Zonas con DST pueden desviarse del mapeo esperado si la fecha real cae en un momento con offset distinto al del 2025-01-06.
- **Polling de 15 s**. No hay websockets; puede haber desfase momentáneo entre participantes.

---

## 11. Control de versiones

Historia resumida (ver `git log` para detalle):

- `d543060` — primera integración con Turso.
- `1cad28b` — fix de persistencia en Turso.
- `d95596f` — soporte de reuniones compartidas y agregación UTC.
- `5bdf61e` — actualización de README.

Rama principal: `master`.
