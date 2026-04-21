# Agenda compartida de reuniones

App en Deno + Hono para coordinar horarios entre varias personas.

## Flujo actual

- Creas una reunion con titulo.
- El backend genera un UID unico que funciona como link compartible.
- Cada persona entra al link, usa su nick y guarda su disponibilidad en horario local.
- La vista UTC agrega a todos los participantes y resalta los mejores cruces horarios.

## Acerca de 

MidPoint esta inspirado en las herramientas clásicas de disponibilidad para ofrecer una experiencia moderna y rapida. A diferencia de las soluciones tradicionales, este proyecto ha sido construido desde cero con un enfoque en:

- Precisión Horaria: Gestión automática de zonas horarias (UTC) para equipos remotos.

- Privacidad y Seguridad: Desarrollado bajo estándares de hardening para proteger la integridad de tus datos.

- Rendimiento: Una interfaz ligera, rápida y sin anuncios, impulsada por tecnología Deno & Hono.

- Desarrollado principalmente para mi uso personal y abierto al público para su uso.
