import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import {
  createMeetingTorso,
  createUserTorso,
  getMeetingParticipantByNickTorso,
  getMeetingParticipantByUidTorso,
  getMeetingTorso,
  getUserBySessionTokenTorso,
  getUserByUsernameTorso,
  listMeetingsByOwnerTorso,
  saveMeetingParticipantTorso,
  setUserSessionTokenTorso,
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

function getAuthToken(c: RequestContext) {
  const header = c.req.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return "";
  return token.trim();
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
