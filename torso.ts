export const TURSO_URL = Deno.env.get("TURSO_URL") || "";
export const TURSO_AUTH_TOKEN = Deno.env.get("TURSO_AUTH_TOKEN") || "";

// Verificar configuración
if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error("❌ ERROR: Variables de entorno no configuradas");
  console.error("Por favor crea un archivo .env con:");
  console.error("TURSO_URL=libsql://tu-database.turso.io");
  console.error("TURSO_AUTH_TOKEN=tu-token");
}

// Guardar usuario (INSERT o UPDATE)
export async function saveUserTorso(uid: string, data: any) {
  console.log("📤 Intentando guardar en Turso:", { uid, nick: data.nick });
  
  try {
    const res = await fetch(TURSO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [
          {
            q: `
              INSERT INTO users (uid, nick, schedule, updatedAtLocal, updatedAtUTC, timezone)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(uid) DO UPDATE SET
                nick=excluded.nick,
                schedule=excluded.schedule,
                updatedAtLocal=excluded.updatedAtLocal,
                updatedAtUTC=excluded.updatedAtUTC,
                timezone=excluded.timezone
            `,
            params: [
              uid,
              data.nick,
              JSON.stringify(data.schedule),
              data.updatedAtLocal,
              data.updatedAtUTC,
              data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
            ]
          }
        ]
      })
    });

    const text = await res.text();
    console.log("✅ SAVE RESPONSE:", res.status, text);

    if (!res.ok) {
      console.error("❌ Error al guardar:", text);
      throw new Error(`Error HTTP: ${res.status}`);
    }

    return res;
  } catch (error) {
    console.error("❌ Error en saveUserTorso:", error);
    throw error;
  }
}

// Obtener usuario
export async function getUserTorso(uid: string) {
  console.log("📥 Buscando usuario:", uid);
  
  try {
    const res = await fetch(TURSO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [
          {
            q: "SELECT * FROM users WHERE uid = ?",
            params: [uid]
          }
        ]
      })
    });

    const data = await res.json();
    console.log("📊 Respuesta Turso:", JSON.stringify(data, null, 2));

    if (!data.results || !data.results[0] || !data.results[0].rows || data.results[0].rows.length === 0) {
      console.log("⚠️ Usuario no encontrado");
      return { status: 404 };
    }

    const row = data.results[0].rows[0];
    const columns = data.results[0].columns;
    
    // Convertir array a objeto
    const userData: any = {};
    columns.forEach((col: string, index: number) => {
      userData[col] = row[index];
    });

    console.log("✅ Usuario encontrado:", userData.nick);

    return {
      status: 200,
      json: async () => userData
    };
  } catch (error) {
    console.error("❌ Error en getUserTorso:", error);
    return { status: 500 };
  }
}

// Buscar usuario por nick
export async function getUserTorsoByNick(nick: string) {
  console.log("📥 Buscando usuario por nick:", nick);

  try {
    const res = await fetch(TURSO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [
          {
            q: "SELECT * FROM users WHERE nick = ?",
            params: [nick]
          }
        ]
      })
    });

    const data = await res.json();
    console.log("📊 Respuesta Turso:", JSON.stringify(data, null, 2));

    if (!data.results || !data.results[0] || !data.results[0].rows || data.results[0].rows.length === 0) {
      console.log("⚠️ Nick no encontrado:", nick);
      return { status: 404 };
    }

    const row = data.results[0].rows[0];
    const columns = data.results[0].columns;

    const userData: any = {};
    columns.forEach((col: string, index: number) => {
      userData[col] = row[index];
    });

    console.log("✅ Usuario encontrado por nick:", userData.nick);

    return {
      status: 200,
      json: async () => userData
    };
  } catch (error) {
    console.error("❌ Error en getUserTorsoByNick:", error);
    return { status: 500 };
  }
}