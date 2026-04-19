import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import { saveUserTorso, getUserTorso, getUserTorsoByNick } from "./torso.ts";

const app = new Hono();

// Guardar usuario
app.post("/api/save", async (c) => {
  const { uid, nick, schedule } = await c.req.json();

  if (!uid || !nick) {
    return c.json({ error: "uid y nick requeridos" }, 400);
  }

  const now = new Date();

  const data = {
    uid,
    nick,
    schedule,
    updatedAtLocal: now.toString(),
    updatedAtUTC: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };

  try {
    await saveUserTorso(uid, data);
    return c.json({ ok: true, data });
  } catch (error) {
    console.error("❌ Error guardando:", error);
    const errorMsg = error instanceof Error ? error.message : "Error al guardar";
    
    // Si es error de nick duplicado, devolver 409 Conflict
    if (errorMsg.includes("ya está en uso") || errorMsg.includes("UNIQUE constraint failed: users.nick")) {
      return c.json({ error: errorMsg }, 409);
    }
    
    return c.json({ error: "Error al guardar" }, 500);
  }
});

// Obtener usuario por UID
app.get("/api/user/:uid", async (c) => {
  const uid = c.req.param("uid");

  const res = await getUserTorso(uid);

  if (res.status !== 200 || !res.json) {
    return c.json({ exists: false });
  }

  const data = await res.json();

  return c.json({
    exists: true,
    data,
  });
});

// Buscar usuario por nick (para Sign In)
app.get("/api/nick/:nick", async (c) => {
  const nick = c.req.param("nick");

  const res = await getUserTorsoByNick(nick);

  if (res.status !== 200 || !res.json) {
    console.log(`❌ Nick no encontrado: ${nick}`);
    return c.json({ exists: false });
  }

  const data = await res.json();
  console.log(`✅ Nick encontrado: ${nick}, schedule:`, data.schedule);

  return c.json({ exists: true, data });
});

// Servir frontend (solo GET, y despues de rutas /api)
app.get("*", serveStatic({ root: "./public" }));

export default app;

// Para desarrollo local
if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") || "8000");
  try {
    Deno.serve({ port }, app.fetch);
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(`❌ Puerto ${port} en uso. Cierra el proceso anterior o usa otro puerto con PORT=${port + 1}`);
    } else {
      console.error("❌ Error iniciando servidor:", error);
    }
    Deno.exit(1);
  }
}
