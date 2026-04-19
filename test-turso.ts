// Script de prueba para verificar conexión a Turso
const TURSO_URL = Deno.env.get("TURSO_URL") || "";
const TURSO_AUTH_TOKEN = Deno.env.get("TURSO_AUTH_TOKEN") || "";

console.log("🔍 Verificando configuración...\n");

if (!TURSO_URL) {
  console.error("❌ TURSO_URL no está configurada");
  Deno.exit(1);
}

if (!TURSO_AUTH_TOKEN) {
  console.error("❌ TURSO_AUTH_TOKEN no está configurada");
  Deno.exit(1);
}

console.log("✅ TURSO_URL:", TURSO_URL);
console.log("✅ TURSO_AUTH_TOKEN:", TURSO_AUTH_TOKEN.substring(0, 20) + "...\n");

console.log("🔌 Probando conexión a Turso...\n");

try {
  // Probar conexión con una consulta simple
  const res = await fetch(TURSO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TURSO_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      statements: [
        {
          q: "SELECT * FROM users LIMIT 1"
        }
      ]
    })
  });

  const data = await res.json();
  
  console.log("📊 Respuesta de Turso:");
  console.log(JSON.stringify(data, null, 2));
  
  if (res.ok) {
    console.log("\n✅ ¡Conexión exitosa!");
  } else {
    console.log("\n❌ Error en la respuesta");
  }
  
} catch (error) {
  console.error("\n❌ Error conectando:", error);
  Deno.exit(1);
}
