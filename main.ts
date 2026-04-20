import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import {
  consumeRecoveryTokenTorso,
  createMeetingTorso,
  createRecoveryTokenTorso,
  getMeetingParticipantByNickTorso,
  getMeetingParticipantByUidTorso,
  getMeetingTorso,
  listMeetingsByParticipantUidsTorso,
  listMeetingsByRecoveryEmailTorso,
  saveMeetingParticipantTorso,
} from "./torso.ts";
import { sendRecoveryEmail } from "./mailer.ts";

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const app = new Hono();

app.post("/api/meetings", async (c) => {
  try {
    const { title, scheduledAtUTC } = await c.req.json();

    if (!String(title || "").trim()) {
      return c.json({ error: "El titulo es requerido" }, 400);
    }

    const meeting = await createMeetingTorso(
      String(title),
      scheduledAtUTC == null ? null : String(scheduledAtUTC),
    );
    return c.json({ ok: true, meeting }, 201);
  } catch (error) {
    console.error("Error creando reunion:", error);
    const message = error instanceof Error ? error.message : "Error al crear la reunion";
    const status = message.includes("invalida") ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

app.post("/api/meetings/mine", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawUids = Array.isArray(body?.participantUids) ? body.participantUids : [];
    const uids = rawUids.map((item: unknown) => String(item ?? "")).filter(Boolean);

    if (!uids.length) {
      return c.json({ meetings: [] });
    }

    const meetings = await listMeetingsByParticipantUidsTorso(uids);
    return c.json({ meetings });
  } catch (error) {
    console.error("Error listando mis reuniones:", error);
    return c.json({ error: "Error al listar las reuniones" }, 500);
  }
});

app.post("/api/recovery/request", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      return c.json({ error: "Email invalido" }, 400);
    }

    const matches = await listMeetingsByRecoveryEmailTorso(email);
    if (matches.length > 0) {
      const { token } = await createRecoveryTokenTorso(email);
      await sendRecoveryEmail(email, token);
    }

    return c.json({ ok: true });
  } catch (error) {
    console.error("Error solicitando recovery:", error);
    return c.json({ ok: true });
  }
});

app.get("/api/recovery/resolve/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const email = await consumeRecoveryTokenTorso(token);
    if (!email) {
      return c.json({ ok: false }, 404);
    }

    const meetings = await listMeetingsByRecoveryEmailTorso(email);
    return c.json({ ok: true, meetings });
  } catch (error) {
    console.error("Error resolviendo recovery:", error);
    return c.json({ error: "Error al resolver el token" }, 500);
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
    const { uid, nick, localSchedule, utcSchedule, timezone, recoveryEmail } = await c.req.json();

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
      recoveryEmail: recoveryEmail === undefined ? undefined : recoveryEmail,
    });

    return c.json({ ok: true, participant });
  } catch (error) {
    console.error("Error guardando participante:", error);
    const message = error instanceof Error ? error.message : "Error al guardar el participante";
    const status = message.includes("ya esta en uso")
      ? 409
      : message.includes("no existe")
        ? 404
        : message.includes("invalido")
          ? 400
          : 500;
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
