const dias = ["Lun","Mar","Mie","Jue","Vie","Sab","Dom"];
let localSchedule = [];
let currentUser = null; // { uid, nick }

function generateUID() {
  return crypto.randomUUID();
}

function setStatus(msg, type = "info") {
  const el = document.getElementById("status");
  const colors = { info: "text-slate-400", ok: "text-green-400", error: "text-red-400", loading: "text-yellow-400" };
  el.className = "text-xs mt-2 h-4 " + (colors[type] || colors.info);
  el.textContent = msg;
}

function setLoggedIn(user) {
  currentUser = user;
  document.getElementById("nick").value = user.nick;
  document.getElementById("nick").disabled = true;
  document.getElementById("btn-signin").textContent = "Cerrar Sesión";
  document.getElementById("btn-signin").classList.replace("bg-blue-600", "bg-slate-600");
  document.getElementById("btn-save").disabled = false;
  setStatus(`Conectado como ${user.nick}`, "ok");
}

function setLoggedOut() {
  currentUser = null;
  localStorage.removeItem("uid");
  document.getElementById("nick").value = "";
  document.getElementById("nick").disabled = false;
  document.getElementById("btn-signin").textContent = "Iniciar Sesión";
  document.getElementById("btn-signin").classList.replace("bg-slate-600", "bg-blue-600");
  document.getElementById("btn-save").disabled = true;
  localSchedule = [];
  updateUI();
  setStatus("", "info");
}

function parseSchedule(rawSchedule) {
  if (Array.isArray(rawSchedule)) return rawSchedule;
  if (typeof rawSchedule === "string" && rawSchedule.trim()) {
    try {
      const parsed = JSON.parse(rawSchedule);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function applyUserData(user) {
  localStorage.setItem("uid", user.uid);
  localSchedule = parseSchedule(user.schedule);
  updateUI();
  setLoggedIn({ uid: user.uid, nick: user.nick });
}

async function signIn() {
  // Si ya hay sesión → Sign Out
  if (currentUser) {
    setLoggedOut();
    return;
  }

  const nick = document.getElementById("nick").value.trim();
  if (!nick) { setStatus("Escribe un nick primero", "error"); return; }

  setStatus("Buscando...", "loading");
  document.getElementById("btn-signin").disabled = true;

  try {
    const res = await fetch(`/api/nick/${encodeURIComponent(nick)}`);
    const data = await res.json();
    
    console.log("📊 Respuesta de búsqueda por nick:", data);

    if (data.exists) {
      // Usuario encontrado → cargar datos
      const user = data.data;
      console.log("✅ Usuario encontrado:", user);
      console.log("📅 Schedule desde BD:", user.schedule);

      applyUserData(user);

      console.log("📌 localSchedule parseado:", localSchedule);
      setStatus(`Bienvenido de vuelta, ${nick}!`, "ok");
    } else {
      // Usuario no existe → crear
      const uid = generateUID();
      localStorage.setItem("uid", uid);

      const saveRes = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, nick, schedule: [] })
      });

      if (saveRes.status === 409) {
        // Si hay conflicto, intentar cargar usuario existente por nick
        const existingRes = await fetch(`/api/nick/${encodeURIComponent(nick)}`);
        const existingData = await existingRes.json();
        if (existingData.exists && existingData.data) {
          applyUserData(existingData.data);
          setStatus(`Bienvenido de vuelta, ${nick}!`, "ok");
          return;
        }

        localStorage.removeItem("uid");
        setStatus("❌ Ese nick ya está en uso", "error");
        return;
      }

      if (!saveRes.ok) { 
        localStorage.removeItem("uid");
        setStatus("Error al crear usuario", "error"); 
        return; 
      }

      localSchedule = [];
      updateUI();
      setLoggedIn({ uid, nick });
      setStatus(`Bienvenido, ${nick}! Cuenta creada.`, "ok");
    }
  } catch (e) {
    console.error("❌ Error en signIn:", e);
    setStatus("Error de conexión", "error");
  } finally {
    document.getElementById("btn-signin").disabled = false;
  }
}

async function saveUser() {
  if (!currentUser) return;

  setStatus("Guardando...", "loading");
  document.getElementById("btn-save").disabled = true;

  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: currentUser.uid, nick: currentUser.nick, schedule: localSchedule })
    });

    if (res.ok) {
      setStatus("Guardado ✓", "ok");
    } else {
      setStatus("Error al guardar", "error");
    }
  } catch (e) {
    setStatus("Error de conexión", "error");
  } finally {
    document.getElementById("btn-save").disabled = false;
  }
}

function init() {
  renderGrid('grid-local','L');
  renderGrid('grid-utc','U');
}

function renderGrid(containerId, prefix) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = "flex mb-1";
  header.innerHTML =
    '<div class="w-10"></div>' +
    dias.map(d => `<div class="flex-1 text-center day-label">${d}</div>`).join('');
  container.appendChild(header);

  for (let h = 0; h < 24; h++) {
    const row = document.createElement('div');
    row.className = "flex gap-0.5 mb-0.5";

    const time = document.createElement('div');
    time.className = "w-10 text-[9px] text-slate-500 font-mono";
    time.innerText = h.toString().padStart(2, '0') + ':00';
    row.appendChild(time);

    for (let d = 0; d < 7; d++) {
      const cell = document.createElement('div');
      cell.id = `${prefix}-${d}-${h}`;
      cell.className = "grid-cell flex-1 bg-slate-800 cursor-pointer";
      if (prefix === 'L') cell.onclick = () => toggleHour(d, h);
      row.appendChild(cell);
    }

    container.appendChild(row);
  }
}

function toggleHour(d, h) {
  if (!currentUser) return;
  const key = `${d}-${h}`;
  const i = localSchedule.indexOf(key);
  if (i > -1) localSchedule.splice(i, 1);
  else localSchedule.push(key);
  updateUI();
}

function updateUI() {
  document.querySelectorAll(".cell-active").forEach(c => c.classList.remove("cell-active"));
  document.querySelectorAll(".cell-utc").forEach(c => c.classList.remove("cell-utc"));

  localSchedule.forEach(item => {
    const [d, h] = item.split("-").map(Number);
    document.getElementById(`L-${d}-${h}`)?.classList.add("cell-active");

    const date = new Date();
    date.setHours(h);
    const utc = date.getUTCHours();
    document.getElementById(`U-${d}-${utc}`)?.classList.add("cell-utc");
  });
}

init();