# Agenda compartida de reuniones

App en Deno + Hono para coordinar horarios entre varias personas.

## Flujo actual

- Creas una reunion con titulo.
- El backend genera un UID unico que funciona como link compartible.
- Cada persona entra al link, usa su nick y guarda su disponibilidad en horario local.
- La vista UTC agrega a todos los participantes y resalta los mejores cruces horarios.

## Desarrollo

1. Configura `.env` con `TURSO_URL` y `TURSO_AUTH_TOKEN`.
2. Ejecuta `deno task dev`.
3. Abre `http://localhost:8000`.

La app crea automaticamente las tablas `meetings` y `meeting_participants` en Turso si no existen.