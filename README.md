# Agenda compartida de reuniones

App en Deno + Hono para coordinar horarios entre varias personas.

## Flujo actual

- Creas una reunion con titulo.
- El backend genera un UID unico que funciona como link compartible.
- Cada persona entra al link, usa su nick y guarda su disponibilidad en horario local.
- La vista UTC agrega a todos los participantes y resalta los mejores cruces horarios.

## Desarrollo

1. Configurar `.env` con `TURSO_URL` y `TURSO_AUTH_TOKEN`.
2. Ejecutar `deno task dev`.
3. Abrir `http://localhost:8000`.
