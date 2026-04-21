import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import type { Context } from "https://deno.land/x/hono/mod.ts";
import {
  deleteMeetingByOwnerTorso,
  createPasswordRecoveryTokenTorso,
  createMeetingTorso,
  createUserTorso,
  getActivePasswordRecoveryTokenTorso,
  getMeetingParticipantByNickWithAccessTorso,
  getMeetingParticipantByNickTorso,
  getMeetingParticipantByUidWithAccessTorso,
  getMeetingParticipantByUidTorso,
  getMeetingTorso,
  getUserBySessionTokenTorso,
  getUserByUsernameTorso,
  listMeetingsByOwnerTorso,
  markPasswordRecoveryTokenUsedTorso,
  saveMeetingParticipantTorso,
  setUserSessionTokenTorso,
  updateUserPasswordHashTorso,
} from "./torso.ts";

const app = new Hono();
type RequestContext = { req: { header: (name: string) => string | undefined } };

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generateRecoveryToken() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function handleForgotPassword(c: Context): Promise<Response> {
  try {
    const { username } = await c.req.json() as { username?: string };
    const cleanUsername = String(username || "").trim();

    // Always return 200 to avoid leaking if a username exists.
    const genericResponse = {
      ok: true,
      message: "Si el usuario existe, se genero un codigo temporal de recuperacion.",
    };

    if (!cleanUsername) {
      return c.json(genericResponse);
    }

    const user = await getUserByUsernameTorso(cleanUsername);
    if (!user) {
      return c.json(genericResponse);
    }

    const rawToken = generateRecoveryToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

    await createPasswordRecoveryTokenTorso({
      uid: crypto.randomUUID(),
      userUid: user.uid,
      tokenHash,
      expiresAtUTC: expiresAt.toISOString(),
      createdAtUTC: now.toISOString(),
    });

    // Dev helper: allows testing reset flow without email provider.
    const exposeToken = (Deno.env.get("DENO_ENV") || "development") !== "production";
    if (exposeToken) {
      return c.json({
        ...genericResponse,
        resetToken: rawToken,
        expiresAtUTC: expiresAt.toISOString(),
      });
    }

    return c.json(genericResponse);
  } catch (error) {
    console.error("Error iniciando recuperacion de contrasena:", error);
    return c.json({ error: "Error al iniciar recuperacion de contrasena" }, 500);
  }
}

async function handleResetPassword(c: Context): Promise<Response> {
  try {
    const { username, token, newPassword } = await c.req.json() as {
      username?: string;
      token?: string;
      newPassword?: string;
    };
    const cleanUsername = String(username || "").trim();
    const cleanToken = String(token || "").trim();
    const cleanPassword = String(newPassword || "");

    if (!cleanUsername || !cleanToken || !cleanPassword) {
      return c.json({ error: "username, token y newPassword son requeridos" }, 400);
    }

    if (cleanPassword.length < 6) {
      return c.json({ error: "La contrasena debe tener al menos 6 caracteres" }, 400);
    }

    const user = await getUserByUsernameTorso(cleanUsername);
    if (!user) {
      return c.json({ error: "Token invalido o expirado" }, 400);
    }

    const tokenHash = await sha256Hex(cleanToken);
    const nowUTC = new Date().toISOString();
    const recoveryToken = await getActivePasswordRecoveryTokenTorso(tokenHash, nowUTC);

    if (!recoveryToken || recoveryToken.userUid !== user.uid) {
      return c.json({ error: "Token invalido o expirado" }, 400);
    }

    const passwordHash = await sha256Hex(cleanPassword);
    await updateUserPasswordHashTorso(user.uid, passwordHash, nowUTC);
    await markPasswordRecoveryTokenUsedTorso(recoveryToken.tokenHash, nowUTC);

    return c.json({ ok: true, message: "Contrasena actualizada. Inicia sesion con la nueva clave." });
  } catch (error) {
    console.error("Error restableciendo contrasena:", error);
    return c.json({ error: "Error al restablecer contrasena" }, 500);
  }
}

function getAuthToken(c: RequestContext) {
  const header = c.req.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return "";
  return token.trim();
}

function getParticipantToken(c: RequestContext) {
  return String(c.req.header("x-participant-token") || "").trim();
}

function sanitizeUser(user: { uid: string; username: string }) {
  return { uid: user.uid, username: user.username };
}

async function requireAuth(c: RequestContext) {
  const token = getAuthToken(c);
  if (!token) {
    return null;
  }

  const user = await getUserBySessionTokenTorso(token);
  if (!user) {
    return null;
  }

  return user;
}

app.post("/api/auth/register", async (c) => {
  try {
    const { username, password } = await c.req.json();
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (cleanUsername.length < 3) {
      return c.json({ error: "El usuario debe tener al menos 3 caracteres" }, 400);
    }

    if (cleanPassword.length < 6) {
      return c.json({ error: "La contrasena debe tener al menos 6 caracteres" }, 400);
    }

    const existing = await getUserByUsernameTorso(cleanUsername);
    if (existing) {
      return c.json({ error: "Ese usuario ya esta en uso" }, 409);
    }

    const now = new Date().toISOString();
    const passwordHash = await sha256Hex(cleanPassword);
    const user = await createUserTorso({
      uid: crypto.randomUUID(),
      username: cleanUsername,
      passwordHash,
      createdAtUTC: now,
      updatedAtUTC: now,
    });

    const sessionToken = crypto.randomUUID();
    const sessionUser = await setUserSessionTokenTorso(user.uid, sessionToken, new Date().toISOString());
    if (!sessionUser) {
      throw new Error("No se pudo iniciar la sesion del usuario creado");
    }

    return c.json({ ok: true, user: sanitizeUser(sessionUser), sessionToken }, 201);
  } catch (error) {
    console.error("Error registrando usuario:", error);
    const message = error instanceof Error ? error.message : "Error al registrar usuario";
    const status = message.includes("ya esta en uso") ? 409 : 500;
    return c.json({ error: message }, status);
  }
});

app.post("/api/auth/login", async (c) => {
  try {
    const { username, password } = await c.req.json();
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanUsername || !cleanPassword) {
      return c.json({ error: "Usuario y contrasena son requeridos" }, 400);
    }

    const user = await getUserByUsernameTorso(cleanUsername);
    if (!user) {
      return c.json({ error: "Credenciales invalidas" }, 401);
    }

    const passwordHash = await sha256Hex(cleanPassword);
    if (user.passwordHash !== passwordHash) {
      return c.json({ error: "Credenciales invalidas" }, 401);
    }

    const sessionToken = crypto.randomUUID();
    const sessionUser = await setUserSessionTokenTorso(user.uid, sessionToken, new Date().toISOString());
    if (!sessionUser) {
      throw new Error("No se pudo crear la sesion");
    }

    return c.json({ ok: true, user: sanitizeUser(sessionUser), sessionToken });
  } catch (error) {
    console.error("Error en login:", error);
    return c.json({ error: "Error al iniciar sesion" }, 500);
  }
});

app.get("/api/auth/me", async (c) => {
  try {
    const user = await requireAuth(c);
    if (!user) {
      return c.json({ authenticated: false }, 401);
    }

    return c.json({ authenticated: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error("Error obteniendo sesion:", error);
    return c.json({ error: "Error al obtener la sesion" }, 500);
  }
});

app.post("/api/auth/logout", async (c) => {
  try {
    const user = await requireAuth(c);
    if (!user) {
      return c.json({ ok: true });
    }

    await setUserSessionTokenTorso(user.uid, null, new Date().toISOString());
    return c.json({ ok: true });
  } catch (error) {
    console.error("Error cerrando sesion:", error);
    return c.json({ error: "Error al cerrar sesion" }, 500);
  }
});

app.post("/api/auth/forgot-password", async (c) => {
  return handleForgotPassword(c);
});

app.post("/api/auth/reset-password", async (c) => {
  return handleResetPassword(c);
});

app.post("/api/auth/token", async (c) => {
  return handleForgotPassword(c);
});

app.post("/api/auth/restablecer", async (c) => {
  return handleResetPassword(c);
});

app.get("/api/dashboard/meetings", async (c) => {
  try {
    const user = await requireAuth(c);
    if (!user) {
      return c.json({ error: "No autorizado" }, 401);
    }

    const meetings = await listMeetingsByOwnerTorso(user.uid);
    return c.json({ ok: true, meetings });
  } catch (error) {
    console.error("Error listando reuniones:", error);
    return c.json({ error: "Error al listar reuniones" }, 500);
  }
});

app.post("/api/meetings", async (c) => {
  try {
    const user = await requireAuth(c);
    if (!user) {
      return c.json({ error: "Debes iniciar sesion para crear reuniones" }, 401);
    }

    const { title } = await c.req.json();
    if (!String(title || "").trim()) {
      return c.json({ error: "El titulo es requerido" }, 400);
    }

    const meeting = await createMeetingTorso(String(title), user.uid);
    return c.json({ ok: true, meeting }, 201);
  } catch (error) {
    console.error("Error creando reunion:", error);
    const message = error instanceof Error ? error.message : "Error al crear la reunion";
    return c.json({ error: message }, 500);
  }
});

app.delete("/api/meetings/:meetingUid", async (c) => {
  try {
    const user = await requireAuth(c);
    if (!user) {
      return c.json({ error: "Debes iniciar sesion para eliminar reuniones" }, 401);
    }

    const meetingUid = String(c.req.param("meetingUid") || "").trim();
    if (!meetingUid) {
      return c.json({ error: "meetingUid es requerido" }, 400);
    }

    const result = await deleteMeetingByOwnerTorso(user.uid, meetingUid);
    if (!result.deleted) {
      return c.json({ error: "Reunion no encontrada o sin permisos" }, 404);
    }

    return c.json({ ok: true, deleted: true });
  } catch (error) {
    console.error("Error eliminando reunion:", error);
    const message = error instanceof Error ? error.message : "Error al eliminar la reunion";
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
    const result = await getMeetingParticipantByUidWithAccessTorso(
      c.req.param("meetingUid"),
      c.req.param("uid"),
      getParticipantToken(c),
    );

    if (!result.exists) {
      return c.json({ exists: false }, 404);
    }

    if (result.reserved || !result.participant) {
      return c.json({ exists: true, reserved: true, error: "Este participante ya esta reservado en otro dispositivo" }, 409);
    }

    return c.json({ exists: true, participant: result.participant, participantToken: result.participantToken });
  } catch (error) {
    console.error("Error obteniendo participante por uid:", error);
    return c.json({ error: "Error al obtener el participante" }, 500);
  }
});

app.get("/api/meetings/:meetingUid/participants/nick/:nick", async (c) => {
  try {
    const result = await getMeetingParticipantByNickWithAccessTorso(
      c.req.param("meetingUid"),
      c.req.param("nick"),
      getParticipantToken(c),
    );

    if (!result.exists) {
      return c.json({ exists: false }, 404);
    }

    if (result.reserved || !result.participant) {
      return c.json({ exists: true, reserved: true, error: "Ese nick ya fue reservado por la primera persona que entro con el" }, 409);
    }

    return c.json({ exists: true, participant: result.participant, participantToken: result.participantToken });
  } catch (error) {
    console.error("Error obteniendo participante por nick:", error);
    return c.json({ error: "Error al obtener el participante" }, 500);
  }
});

app.post("/api/meetings/:meetingUid/participants", async (c) => {
  try {
    const meetingUid = c.req.param("meetingUid");
    const { uid, nick, participantToken, localSchedule, utcSchedule, timezone } = await c.req.json();

    if (!uid || !nick) {
      return c.json({ error: "uid y nick son requeridos" }, 400);
    }

    const now = new Date();
    const participant = await saveMeetingParticipantTorso(meetingUid, {
      uid: String(uid),
      nick: String(nick),
      participantToken: String(participantToken || ""),
      localSchedule: Array.isArray(localSchedule) ? localSchedule : [],
      utcSchedule: Array.isArray(utcSchedule) ? utcSchedule : [],
      timezone: String(timezone || "UTC"),
      updatedAtLocal: now.toString(),
      updatedAtUTC: now.toISOString(),
    });

    return c.json({ ok: true, participant: participant.participant, participantToken: participant.participantToken });
  } catch (error) {
    console.error("Error guardando participante:", error);
    const message = error instanceof Error ? error.message : "Error al guardar el participante";
    const status = message.includes("ya esta en uso") || message.includes("sesion del participante") ? 409 : message.includes("no existe") ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

app.get("/recuperar/token", serveStatic({ path: "./public/recovery-token.html" }));
app.get("/recuperar/restablecer", serveStatic({ path: "./public/recovery-reset.html" }));

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
