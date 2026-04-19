import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import { saveUserTorso, getUserTorso, getUserTorsoByNick } from "./torso.ts";

const app = new Hono();

// Servir frontend
app.use("/*", serveStatic({ root: "./public" }));

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
    return c.json({ error: "Error al guardar" }, 500);
  }
});

// Obtener usuario por UID
app.get("/api/user/:uid", async (c) => {
  const uid = c.req.param("uid");

  const res = await getUserTorso(uid);

  if (res.status === 404) {
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

  if (res.status === 404) {
    return c.json({ exists: false });
  }

  const data = await res.json();

  return c.json({ exists: true, data });
});

export default app;

// Para desarrollo local
if (import.meta.main) {
  Deno.serve({ port: 8000 }, app.fetch);
  console.log("🚀 Servidor corriendo en http://localhost:8000");
}


// import { Hono } from "https://deno.land/x/hono/mod.ts";

// const app = new Hono();

// app.get("/", (c) => {
//   return c.html(`
//     <!DOCTYPE html>
//     <html lang="es">
//     <head>
//       <meta charset="UTF-8">
//       <meta name="viewport" content="width=device-width, initial-scale=1.0">
//       <title>Prueba Volátil - Schedule</title>
//       <script src="https://cdn.tailwindcss.com"></script>
//       <style>
//         .cell-active { background-color: #3b82f6 !important; border-color: #60a5fa !important; }
//         .cell-utc { background-color: #10b981 !important; border-color: #34d399 !important; }
//         .grid-cell { height: 22px; border: 1px solid #334155; }
//         .day-label { font-size: 9px; color: #94a3b8; text-transform: uppercase; font-weight: bold; }
//       </style>
//     </head>
//     <body class="bg-slate-900 text-slate-200 p-4 font-sans">
      
//       <div class="max-w-6xl mx-auto">
//         <header class="mb-6 text-center">
//           <h1 class="text-xl font-bold text-blue-400">Entorno de Pruebas (Memoria Volátil)</h1>
//           <p class="text-xs text-slate-500 mt-1">Si presionas F5 o recargas, los datos se borrarán.</p>
//           <div class="mt-4">
//             <input type="text" id="nick" placeholder="Nick de prueba..." 
//                    class="bg-slate-800 border border-slate-700 rounded px-3 py-1 text-sm outline-none focus:ring-1 focus:ring-blue-500">
//           </div>
//         </header>

//         <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
//           <div class="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
//             <h2 class="text-xs font-bold mb-3 text-slate-400 uppercase tracking-tighter">Panel Local (Clic aquí)</h2>
//             <div id="grid-local"></div>
//           </div>

//           <div class="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
//             <h2 class="text-xs font-bold mb-3 text-slate-400 uppercase tracking-tighter">Panel Espejo UTC</h2>
//             <div id="grid-utc" class="pointer-events-none"></div>
//           </div>
//         </div>
//       </div>

//       <script>
//         const dias = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
//         // ESTADO TEMPORAL (Se borra al recargar)
//         let localSchedule = []; 

//         function init() {
//           renderGrid('grid-local', 'L');
//           renderGrid('grid-utc', 'U');
//         }

//         function renderGrid(containerId, prefix) {
//           const container = document.getElementById(containerId);
//           container.innerHTML = '';
          
//           // Header de días
//           const header = document.createElement('div');
//           header.className = "flex mb-1";
//           header.innerHTML = '<div class="w-10"></div>' + 
//             dias.map(d => \`<div class="flex-1 text-center day-label">\${d}</div>\`).join('');
//           container.appendChild(header);

//           // Filas de horas
//           for (let h = 0; h < 24; h++) {
//             const row = document.createElement('div');
//             row.className = "flex gap-0.5 mb-0.5";
            
//             const time = document.createElement('div');
//             time.className = "w-10 text-[9px] text-slate-500 self-center font-mono";
//             time.innerText = h.toString().padStart(2, '0') + ':00';
//             row.appendChild(time);

//             for (let d = 0; d < 7; d++) {
//               const cell = document.createElement('div');
//               cell.id = \`\${prefix}-\${d}-\${h}\`;
//               cell.className = "grid-cell flex-1 bg-slate-800 border border-slate-700 hover:bg-slate-700 cursor-pointer";
              
//               if (prefix === 'L') {
//                 cell.onclick = () => toggleHour(d, h);
//               }
//               row.appendChild(cell);
//             }
//             container.appendChild(row);
//           }
//         }

//         function toggleHour(d, h) {
//           const key = \`\${d}-\${h}\`;
//           const index = localSchedule.indexOf(key);

//           if (index > -1) {
//             localSchedule.splice(index, 1);
//           } else {
//             localSchedule.push(key);
//           }

//           updateUI();
//         }

//         function updateUI() {
//           // Limpiar clases
//           document.querySelectorAll('.cell-active').forEach(c => c.classList.remove('cell-active'));
//           document.querySelectorAll('.cell-utc').forEach(c => c.classList.remove('cell-utc'));

//           // Aplicar estado actual
//           localSchedule.forEach(item => {
//             const [d, h] = item.split('-').map(Number);
            
//             // Marcar Local
//             document.getElementById(\`L-\${d}-\${h}\`).classList.add('cell-active');

//             // Calcular UTC
//             const date = new Date();
//             date.setHours(h, 0, 0, 0);
//             const utcHour = date.getUTCHours();
            
//             // Marcar UTC (el ID U-d-utcHour)
//             const utcCell = document.getElementById(\`U-\${d}-\${utcHour}\`);
//             if (utcCell) utcCell.classList.add('cell-utc');
//           });
//         }

//         init();
//       </script>
//     </body>
//     </html>
//   `);
// });

// Deno.serve(app.fetch);