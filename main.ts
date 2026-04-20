import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import {
  createMeetingTorso,
  getMeetingParticipantByNickTorso,
  getMeetingParticipantByUidTorso,
  getMeetingTorso,
  saveMeetingParticipantTorso,
} from "./torso.ts";

const app = new Hono();

app.post("/api/meetings", async (c) => {
  try {
    const { title } = await c.req.json();

    if (!String(title || "").trim()) {
      return c.json({ error: "El titulo es requerido" }, 400);
    }

    const meeting = await createMeetingTorso(String(title));
    return c.json({ ok: true, meeting }, 201);
  } catch (error) {
    console.error("Error creando reunion:", error);
    const message = error instanceof Error ? error.message : "Error al crear la reunion";
    return c.json({ error: message }, 500);
  }
});

app.get("/api/meetings/:meetingUid", async (c) => {
  try {
    const meetingUid = c.req.param("meetingUid");
    const meeting = await getMeetingTorso(meetingUid);

    if (!meeting) {
      return c.json({ exists: false }, 404);
    }

    return c.json({ exists: true, meeting });
  } catch (error) {
    console.error("Error obteniendo reunion:", error);
    return c.json({ error: "Error al obtener la reunion" }, 500);
  }
});

app.get("/api/meetings/:meetingUid/participants/uid/:uid", async (c) => {
  try {
    const participant = await getMeetingParticipantByUidTorso(
      c.req.param("meetingUid"),
      c.req.param("uid"),
    );

    if (!participant) {
      return c.json({ exists: false }, 404);
    }

    return c.json({ exists: true, participant });
  } catch (error) {
    console.error("Error obteniendo participante por uid:", error);
    return c.json({ error: "Error al obtener el participante" }, 500);
  }
});

app.get("/api/meetings/:meetingUid/participants/nick/:nick", async (c) => {
  try {
    const participant = await getMeetingParticipantByNickTorso(
      c.req.param("meetingUid"),
      c.req.param("nick"),
    );

    if (!participant) {
      return c.json({ exists: false }, 404);
    }

    return c.json({ exists: true, participant });
  } catch (error) {
    console.error("Error obteniendo participante por nick:", error);
    return c.json({ error: "Error al obtener el participante" }, 500);
  }
});

app.post("/api/meetings/:meetingUid/participants", async (c) => {
  try {
    const meetingUid = c.req.param("meetingUid");
    const { uid, nick, localSchedule, utcSchedule, timezone } = await c.req.json();

    if (!uid || !nick) {
      return c.json({ error: "uid y nick son requeridos" }, 400);
    }

    const now = new Date();
    const participant = await saveMeetingParticipantTorso(meetingUid, {
      uid: String(uid),
      nick: String(nick),
      localSchedule: Array.isArray(localSchedule) ? localSchedule : [],
      utcSchedule: Array.isArray(utcSchedule) ? utcSchedule : [],
      timezone: String(timezone || "UTC"),
      updatedAtLocal: now.toString(),
      updatedAtUTC: now.toISOString(),
    });

    return c.json({ ok: true, participant });
  } catch (error) {
    console.error("Error guardando participante:", error);
    const message = error instanceof Error ? error.message : "Error al guardar el participante";
    const status = message.includes("ya esta en uso") ? 409 : message.includes("no existe") ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

app.get("*", serveStatic({ root: "./public" }));

export default app;

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") || "8000");

  try {
    Deno.serve({ port }, app.fetch);
    console.log(`Servidor corriendo en http://localhost:${port}`);
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(`Puerto ${port} en uso. Cierra el proceso anterior o usa PORT=${port + 1}`);
    } else {
      console.error("Error iniciando servidor:", error);
    }
    Deno.exit(1);
  }
}
