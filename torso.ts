export const TURSO_URL = Deno.env.get("TURSO_URL") || "";
export const TURSO_AUTH_TOKEN = Deno.env.get("TURSO_AUTH_TOKEN") || "";

function unwrapTursoPayload(payload: unknown) {
  return Array.isArray(payload) ? payload[0] : payload;
}

function getTursoError(payload: unknown): string | null {
  const root = unwrapTursoPayload(payload) as { error?: unknown; results?: Array<{ error?: unknown }> } | null;
  if (!root) return "Respuesta vacia de Turso";
  if (root.error) return String(root.error);
  if (Array.isArray(root.results)) {
    const withError = root.results.find((r) => r?.error);
    if (withError?.error) return String(withError.error);
  }
  return null;
}

type TursoRowResult = {
  rows?: unknown[][];
  columns?: string[];
  error?: unknown;
};

type TursoRootPayload = {
  error?: unknown;
  results?: TursoRowResult[] | TursoRowResult;
};

function getFirstResult(root: TursoRootPayload): TursoRowResult | null {
  if (!root.results) return null;
  if (Array.isArray(root.results)) return root.results[0] || null;
  return root.results;
}

// Verificar configuración
if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error("❌ ERROR: Variables de entorno no configuradas");
  console.error("Por favor crea un archivo .env con:");
  console.error("TURSO_URL=libsql://tu-database.turso.io");
  console.error("TURSO_AUTH_TOKEN=tu-token");
}

// Guardar usuario (INSERT o UPDATE)
export async function saveUserTorso(uid: string, data: { nick: string; schedule: string[]; updatedAtLocal: string; updatedAtUTC: string; timezone?: string }) {
  const cleanNick = String(data.nick || "").trim();
  console.log("📤 Intentando guardar en Turso:", { uid, nick: cleanNick, scheduleLength: data.schedule?.length });
  
  try {
    // Primero verificar si el nick ya existe en OTRO usuario
    const checkRes = await fetch(TURSO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [
          {
            q: "SELECT uid FROM users WHERE nick = ? AND uid != ?",
            params: [cleanNick, uid]
          }
        ]
      })
    });

    const checkDataRaw = await checkRes.json();
    const checkError = getTursoError(checkDataRaw);
    if (checkError) {
      throw new Error(`Error validando nick: ${checkError}`);
    }

    const checkData = unwrapTursoPayload(checkDataRaw) as TursoRootPayload | null;
    const checkResult = checkData ? getFirstResult(checkData) : null;
    const existingUser = checkResult?.rows?.[0];

    // Si existe un usuario con este nick pero es un UID diferente → ERROR
    if (existingUser) {
      console.error("❌ Nick ya está en uso por otro usuario");
      throw new Error(`Nick "${data.nick}" ya está en uso`);
    }

    // Serializar schedule como JSON string
    const scheduleJson = JSON.stringify(data.schedule || []);
    console.log("📝 Schedule a guardar:", scheduleJson);

    // Usar dos statements: primero eliminar el usuario viejo, luego insertar el nuevo
    // Esto evita conflictos de UNIQUE constraint
    const res = await fetch(TURSO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [
          {
            q: "DELETE FROM users WHERE uid = ?",
            params: [uid]
          },
          {
            q: `
              INSERT INTO users (uid, nick, schedule, updatedAtLocal, updatedAtUTC, timezone)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
            params: [
              uid,
              cleanNick,
              scheduleJson,
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

    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Respuesta invalida de Turso al guardar");
    }

    const saveError = getTursoError(payload);
    if (saveError) {
      if (saveError.includes("UNIQUE constraint failed: users.nick")) {
        throw new Error(`Nick "${cleanNick}" ya está en uso`);
      }
      throw new Error(`Error SQL al guardar: ${saveError}`);
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

    const raw = await res.json();
    const error = getTursoError(raw);
    if (error) {
      console.error("❌ Error SQL en getUserTorso:", error);
      return { status: 500 };
    }

    const data = unwrapTursoPayload(raw) as TursoRootPayload;
    console.log("📊 Respuesta Turso:", JSON.stringify(data, null, 2));

    const firstResult = getFirstResult(data);
    if (!firstResult?.rows || firstResult.rows.length === 0) {
      console.log("⚠️ Usuario no encontrado");
      return { status: 404 };
    }

    const row = firstResult.rows[0];
    const columns = firstResult.columns || [];
    
    // Convertir array a objeto
    const userData: Record<string, unknown> = {};
    columns.forEach((col: string, index: number) => {
      userData[col] = row[index];
    });

    console.log("✅ Usuario encontrado:", userData.nick);

    return {
      status: 200,
      json: () => userData
    };
  } catch (error) {
    console.error("❌ Error en getUserTorso:", error);
    return { status: 500 };
  }
}

// Buscar usuario por nick
export async function getUserTorsoByNick(nick: string) {
  const cleanNick = String(nick || "").trim();
  console.log("📥 Buscando usuario por nick:", cleanNick);

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
            params: [cleanNick]
          }
        ]
      })
    });

    const raw = await res.json();
    const error = getTursoError(raw);
    if (error) {
      console.error("❌ Error SQL en getUserTorsoByNick:", error);
      return { status: 500 };
    }

    const data = unwrapTursoPayload(raw) as TursoRootPayload;
    console.log("📊 Respuesta Turso:", JSON.stringify(data, null, 2));

    const firstResult = getFirstResult(data);
    if (!firstResult?.rows || firstResult.rows.length === 0) {
      console.log("⚠️ Nick no encontrado:", cleanNick);
      return { status: 404 };
    }

    const row = firstResult.rows[0];
    const columns = firstResult.columns || [];

    const userData: Record<string, unknown> = {};
    columns.forEach((col: string, index: number) => {
      userData[col] = row[index];
    });

    console.log("✅ Usuario encontrado por nick:", userData.nick);

    return {
      status: 200,
      json: () => userData
    };
  } catch (error) {
    console.error("❌ Error en getUserTorsoByNick:", error);
    return { status: 500 };
  }
}