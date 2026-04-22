const dias = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const REFERENCE_MONDAY = { year: 2025, month: 0, day: 6 };
const AUTH_STORAGE_KEY = "agenda:authToken";

const state = {
  authUser: null,
  authToken: localStorage.getItem(AUTH_STORAGE_KEY) || "",
  dashboardMeetings: [],
  currentMeeting: null,
  currentParticipant: null,
  localSchedule: [],
  refreshTimer: null,
  utcTooltipEl: null,
};

function query(id) {
  return document.getElementById(id);
}

function generateUID() {
  return crypto.randomUUID();
}

function parseSchedule(rawSchedule) {
  if (Array.isArray(rawSchedule)) return [...rawSchedule];
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (options.auth && state.authToken) {
    headers.set("Authorization", `Bearer ${state.authToken}`);
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { response, payload };
}

function setLineStatus(elementId, message, type = "info") {
  const element = query(elementId);
  if (!element) return;
  element.dataset.state = type;
  element.textContent = message;
}

function getMeetingUidFromUrl() {
  return new URLSearchParams(globalThis.location.search).get("meeting") || "";
}

function getMeetingLink(meetingUid = getMeetingUidFromUrl()) {
  if (!meetingUid) return "";
  const url = new URL(globalThis.location.href);
  url.searchParams.set("meeting", meetingUid);
  return url.toString();
}

function goToDashboard() {
  globalThis.location.href = "/";
}

function getParticipantStorageKey(meetingUid) {
  return `agenda:meeting:${meetingUid}:participantUid`;
}

function getParticipantSessionStorageKey(meetingUid) {
  return `agenda:meeting:${meetingUid}:session`;
}

function persistParticipantSession(user) {
  if (!user?.meetingUid) return;
  localStorage.setItem(getParticipantStorageKey(user.meetingUid), user.uid);
  localStorage.setItem(
    getParticipantSessionStorageKey(user.meetingUid),
    JSON.stringify({ uid: user.uid, nick: user.nick, participantToken: user.participantToken || "" }),
  );
}

function readParticipantSession(meetingUid) {
  if (!meetingUid) return null;
  const raw = localStorage.getItem(getParticipantSessionStorageKey(meetingUid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.uid) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearParticipantSession(meetingUid) {
  if (!meetingUid) return;
  localStorage.removeItem(getParticipantStorageKey(meetingUid));
  localStorage.removeItem(getParticipantSessionStorageKey(meetingUid));
}

function getParticipantTokenForMeeting(meetingUid = state.currentMeeting?.uid) {
  const session = meetingUid ? readParticipantSession(meetingUid) : null;
  return session?.participantToken || state.currentParticipant?.participantToken || "";
}

function setAuthSession(user, sessionToken) {
  state.authUser = user;
  if (sessionToken) {
    state.authToken = sessionToken;
    localStorage.setItem(AUTH_STORAGE_KEY, sessionToken);
  }
  updateNavigation();
  renderDashboardView();
}

function clearAuthSession() {
  state.authUser = null;
  state.authToken = "";
  state.dashboardMeetings = [];
  localStorage.removeItem(AUTH_STORAGE_KEY);
  updateNavigation();
  renderDashboardView();
}

function updateNavigation() {
  const button = query("nav-dashboard-btn");
  if (!button) return;
  button.textContent = state.authUser ? `Panel de ${state.authUser.username}` : "Crear reunion";
}

function showView(mode) {
  query("dashboard-view")?.classList.toggle("hidden", mode !== "dashboard");
  query("meeting-view")?.classList.toggle("hidden", mode !== "meeting");
  query("not-found-view")?.classList.toggle("hidden", mode !== "not-found");
}

function showMeetingNotFound() {
  showView("not-found");
  const statusEl = document.getElementById("not-found-redirect-status");
  let seconds = 5;
  if (statusEl) statusEl.textContent = `Redirigiendo al inicio en ${seconds}s...`;
  const interval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(interval);
      goToDashboard();
    } else if (statusEl) {
      statusEl.textContent = `Redirigiendo al inicio en ${seconds}s...`;
    }
  }, 1000);
}

function formatDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString("es-ES", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderDashboardView() {
  const authCard = query("auth-card");
  const dashboardCard = query("dashboard-card");
  const dashboardTitle = query("dashboard-title");
  const dashboardCopy = query("dashboard-copy");

  if (!state.authUser) {
    authCard?.classList.remove("hidden");
    dashboardCard?.classList.add("hidden");
    if (dashboardTitle) dashboardTitle.textContent = "Inicia sesion para crear reuniones";
    if (dashboardCopy) {
      dashboardCopy.textContent = "Crea tu usuario con nick y contrasena para administrar reuniones propias. Los invitados siguen entrando solo con el link y su nick.";
    }
    return;
  }

  authCard?.classList.add("hidden");
  dashboardCard?.classList.remove("hidden");
  if (dashboardTitle) dashboardTitle.textContent = `Hola, ${state.authUser.username}`;
  if (dashboardCopy) {
    dashboardCopy.textContent = "Desde aqui creas reuniones, copias links y llevas control de todo lo que abriste con tu cuenta.";
  }
  query("dashboard-username").textContent = state.authUser.username;
  renderOwnedMeetings();
}

function renderOwnedMeetings() {
  const container = query("owned-meeting-list");
  if (!container) return;

  if (!state.dashboardMeetings.length) {
    container.innerHTML = '<div class="meeting-card meeting-card-empty">Aun no has creado reuniones.</div>';
    return;
  }

  container.innerHTML = state.dashboardMeetings
    .map((meeting) => `
      <article class="meeting-card">
        <div class="meeting-card-copy">
          <p class="meeting-card-title">${escapeHtml(meeting.title)}</p>
          <p class="meeting-card-meta">${escapeHtml(formatDate(meeting.createdAtUTC))} · ${meeting.participantCount} participante(s)</p>
        </div>
        <div class="meeting-card-actions">
          <button type="button" class="action-btn action-btn-secondary action-btn-small" onclick="openOwnedMeeting('${meeting.uid}')">Abrir</button>
          <button type="button" class="action-btn action-btn-secondary action-btn-small" onclick="copyOwnedMeetingLink('${meeting.uid}')">Copiar link</button>
          <button type="button" class="action-btn action-btn-secondary action-btn-small" onclick="deleteOwnedMeeting('${meeting.uid}', '${escapeHtml(meeting.title)}')">Eliminar</button>
        </div>
      </article>
    `)
    .join("");
}

async function restoreAuthSession() {
  if (!state.authToken) {
    renderDashboardView();
    return;
  }

  try {
    const { response, payload } = await apiFetch("/api/auth/me", { auth: true });
    if (!response.ok || !payload?.authenticated) {
      clearAuthSession();
      return;
    }

    state.authUser = payload.user;
  } catch (error) {
    console.error(error);
    clearAuthSession();
    return;
  }

  updateNavigation();
  renderDashboardView();
}

async function loginUser() {
  const username = query("auth-username").value.trim();
  const password = query("auth-password").value;
  if (!username || !password) {
    setLineStatus("auth-status", "Escribe usuario y contrasena", "error");
    return;
  }

  query("btn-login").disabled = true;
  setLineStatus("auth-status", "Entrando...", "loading");

  try {
    const { response, payload } = await apiFetch("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });

    if (!response.ok || !payload?.user || !payload?.sessionToken) {
      throw new Error(payload?.error || "No se pudo iniciar sesion");
    }

    setAuthSession(payload.user, payload.sessionToken);
    query("auth-password").value = "";
    setLineStatus("auth-status", `Sesion iniciada como ${payload.user.username}`, "ok");
    await loadDashboardMeetings();
  } catch (error) {
    console.error(error);
    setLineStatus("auth-status", error.message || "Error al iniciar sesion", "error");
  } finally {
    query("btn-login").disabled = false;
  }
}

async function registerUser() {
  const username = query("auth-username").value.trim();
  const password = query("auth-password").value;
  if (!username || !password) {
    setLineStatus("auth-status", "Escribe usuario y contrasena", "error");
    return;
  }

  query("btn-register").disabled = true;
  setLineStatus("auth-status", "Creando usuario...", "loading");

  try {
    const { response, payload } = await apiFetch("/api/auth/register", {
      method: "POST",
      body: { username, password },
    });

    if (!response.ok || !payload?.user || !payload?.sessionToken) {
      throw new Error(payload?.error || "No se pudo crear el usuario");
    }

    setAuthSession(payload.user, payload.sessionToken);
    query("auth-password").value = "";
    setLineStatus("auth-status", `Usuario ${payload.user.username} creado`, "ok");
    await loadDashboardMeetings();
  } catch (error) {
    console.error(error);
    setLineStatus("auth-status", error.message || "Error al crear usuario", "error");
  } finally {
    query("btn-register").disabled = false;
  }
}

async function requestPasswordReset() {
  const username = query("recovery-username").value.trim() || query("auth-username").value.trim();
  if (!username) {
    setLineStatus("recovery-status", "Escribe tu usuario", "error");
    return;
  }

  query("btn-forgot").disabled = true;
  setLineStatus("recovery-status", "Generando codigo temporal...", "loading");

  try {
    const { response, payload } = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      body: { username },
    });

    if (!response.ok) {
      throw new Error(payload?.error || "No se pudo generar el codigo");
    }

    query("recovery-username").value = username;

    if (payload?.resetToken) {
      query("recovery-token").value = payload.resetToken;
      const expires = payload.expiresAtUTC ? ` (expira ${formatDate(payload.expiresAtUTC)})` : "";
      setLineStatus("recovery-status", `Codigo generado${expires}. Ya lo deje pegado en el campo.`, "ok");
    } else {
      setLineStatus("recovery-status", payload?.message || "Si el usuario existe, se genero un codigo temporal.", "info");
    }
  } catch (error) {
    console.error(error);
    setLineStatus("recovery-status", error.message || "Error al generar codigo", "error");
  } finally {
    query("btn-forgot").disabled = false;
  }
}

async function resetPasswordWithToken() {
  const username = query("recovery-username").value.trim() || query("auth-username").value.trim();
  const token = query("recovery-token").value.trim();
  const newPassword = query("recovery-new-password").value;

  if (!username || !token || !newPassword) {
    setLineStatus("recovery-status", "Completa usuario, codigo y nueva contrasena", "error");
    return;
  }

  query("btn-reset-password").disabled = true;
  setLineStatus("recovery-status", "Restableciendo contrasena...", "loading");

  try {
    const { response, payload } = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: { username, token, newPassword },
    });

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "No se pudo restablecer la contrasena");
    }

    query("auth-username").value = username;
    query("auth-password").value = "";
    query("recovery-token").value = "";
    query("recovery-new-password").value = "";
    setLineStatus("recovery-status", payload.message || "Contrasena actualizada.", "ok");
    setLineStatus("auth-status", "Contrasena cambiada. Ahora inicia sesion.", "ok");
  } catch (error) {
    console.error(error);
    setLineStatus("recovery-status", error.message || "Error al restablecer contrasena", "error");
  } finally {
    query("btn-reset-password").disabled = false;
  }
}

async function logoutUser() {
  query("btn-logout").disabled = true;
  try {
    await apiFetch("/api/auth/logout", { method: "POST", auth: true });
  } catch (error) {
    console.error(error);
  }

  clearAuthSession();
  setLineStatus("auth-status", "Sesion cerrada", "ok");
  query("btn-logout").disabled = false;
}

async function loadDashboardMeetings() {
  if (!state.authUser) {
    state.dashboardMeetings = [];
    renderOwnedMeetings();
    return;
  }

  try {
    const { response, payload } = await apiFetch("/api/dashboard/meetings", { auth: true });
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "No se pudieron cargar tus reuniones");
    }

    state.dashboardMeetings = payload.meetings || [];
    renderOwnedMeetings();
  } catch (error) {
    console.error(error);
    setLineStatus("dashboard-status", error.message || "Error cargando reuniones", "error");
  }
}

async function createOwnedMeeting() {
  const title = query("dashboard-meeting-title").value.trim();
  if (!title) {
    setLineStatus("dashboard-status", "Escribe un titulo para la reunion", "error");
    return;
  }

  query("btn-dashboard-create").disabled = true;
  setLineStatus("dashboard-status", "Creando reunion...", "loading");

  try {
    const { response, payload } = await apiFetch("/api/meetings", {
      method: "POST",
      auth: true,
      body: { title },
    });

    if (!response.ok || !payload?.meeting) {
      throw new Error(payload?.error || "No se pudo crear la reunion");
    }

    query("dashboard-meeting-title").value = "";
    setLineStatus("dashboard-status", "Reunion creada. Ya aparece en tu panel.", "ok");
    await loadDashboardMeetings();
  } catch (error) {
    console.error(error);
    setLineStatus("dashboard-status", error.message || "Error al crear la reunion", "error");
  } finally {
    query("btn-dashboard-create").disabled = false;
  }
}

function openOwnedMeeting(meetingUid) {
  globalThis.location.href = `/?meeting=${encodeURIComponent(meetingUid)}`;
}

async function copyOwnedMeetingLink(meetingUid) {
  try {
    await navigator.clipboard.writeText(getMeetingLink(meetingUid));
    setLineStatus("dashboard-status", "Link copiado al portapapeles", "ok");
  } catch (error) {
    console.error(error);
    setLineStatus("dashboard-status", "No se pudo copiar el link", "error");
  }
}

async function deleteOwnedMeeting(meetingUid, meetingTitle = "") {
  if (!state.authUser) {
    setLineStatus("dashboard-status", "Debes iniciar sesion para eliminar reuniones", "error");
    return;
  }

  const title = String(meetingTitle || "").trim();
  const message = title
    ? `Vas a eliminar la reunion \"${title}\". Esta accion no se puede deshacer. Deseas continuar?`
    : "Vas a eliminar esta reunion. Esta accion no se puede deshacer. Deseas continuar?";

  const confirmed = globalThis.confirm(message);
  if (!confirmed) {
    return;
  }

  setLineStatus("dashboard-status", "Eliminando reunion...", "loading");

  try {
    const { response, payload } = await apiFetch(`/api/meetings/${encodeURIComponent(meetingUid)}`, {
      method: "DELETE",
      auth: true,
    });

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "No se pudo eliminar la reunion");
    }

    setLineStatus("dashboard-status", "Reunion eliminada", "ok");
    await loadDashboardMeetings();
  } catch (error) {
    console.error(error);
    setLineStatus("dashboard-status", error.message || "Error al eliminar la reunion", "error");
  }
}

function setMeetingStatus(message, type = "info") {
  setLineStatus("meeting-status", message, type);
}

function setParticipantLoggedIn(user) {
  state.currentParticipant = user;
  persistParticipantSession(user);
  query("nick").value = user.nick;
  query("nick").disabled = true;
  query("btn-signin").textContent = "Salir";
  query("btn-save").disabled = false;
  query("local-schedule-panel")?.classList.remove("hidden");
  setMeetingStatus(`Dentro de la reunion como ${user.nick}`, "ok");
}

function setParticipantLoggedOut(options = { clearStorage: true }) {
  if (options.clearStorage && state.currentMeeting?.uid) {
    clearParticipantSession(state.currentMeeting.uid);
  }

  state.currentParticipant = null;
  state.localSchedule = [];
  query("nick").value = "";
  query("nick").disabled = false;
  query("btn-signin").textContent = "Entrar";
  query("btn-save").disabled = true;
  query("local-schedule-panel")?.classList.add("hidden");
  updateMeetingUI();
  setMeetingStatus("", "info");
}

function setMeetingState(meeting) {
  state.currentMeeting = meeting;

  if (!meeting) {
    query("meeting-hero-title").textContent = "Coordina una reunion por link";
    query("participant-list").innerHTML = "";
    query("utc-summary").textContent = "Esperando participantes.";
    setParticipantLoggedOut({ clearStorage: false });
    stopAutoRefresh();
    return;
  }

  query("meeting-hero-title").textContent = meeting.title;
  startAutoRefresh();
}

function applyParticipantData(user) {
  state.localSchedule = parseSchedule(user.localSchedule);
  setParticipantLoggedIn({
    uid: user.uid,
    nick: user.nick,
    meetingUid: user.meetingUid,
    participantToken: user.participantToken || state.currentParticipant?.participantToken || getParticipantTokenForMeeting(user.meetingUid),
  });
  updateMeetingUI();
}

function toUtcSlot(localDay, localHour) {
  const localDate = new Date(
    REFERENCE_MONDAY.year,
    REFERENCE_MONDAY.month,
    REFERENCE_MONDAY.day + localDay,
    localHour,
    0,
    0,
    0,
  );
  const utcDay = (localDate.getUTCDay() + 6) % 7;
  return `${utcDay}-${localDate.getUTCHours()}`;
}

function toUtcScheduleFromLocal(localItems) {
  return [...new Set(parseSchedule(localItems).map((item) => {
    const [day, hour] = String(item).split("-").map(Number);
    if (Number.isNaN(day) || Number.isNaN(hour)) return null;
    return toUtcSlot(day, hour);
  }).filter(Boolean))];
}

function getCurrentUtcSchedule() {
  return toUtcScheduleFromLocal(state.localSchedule);
}

function getParticipantsForAggregate() {
  if (!state.currentMeeting) return [];

  const participants = (state.currentMeeting.participants || []).map((participant) => ({
    ...participant,
    localSchedule: parseSchedule(participant.localSchedule),
    utcSchedule: (() => {
      const storedUtc = parseSchedule(participant.utcSchedule);
      return storedUtc.length > 0 ? storedUtc : toUtcScheduleFromLocal(participant.localSchedule);
    })(),
  }));

  if (!state.currentParticipant) return participants;

  const currentUtc = getCurrentUtcSchedule();
  const index = participants.findIndex((participant) => participant.uid === state.currentParticipant.uid);

  if (index >= 0) {
    participants[index] = {
      ...participants[index],
      localSchedule: [...state.localSchedule],
      utcSchedule: currentUtc,
    };
    return participants;
  }

  return [
    ...participants,
    {
      uid: state.currentParticipant.uid,
      meetingUid: state.currentMeeting.uid,
      nick: state.currentParticipant.nick,
      localSchedule: [...state.localSchedule],
      utcSchedule: currentUtc,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  ];
}

function buildUtcAggregate() {
  const aggregate = new Map();
  const participants = getParticipantsForAggregate();

  participants.forEach((participant) => {
    parseSchedule(participant.utcSchedule).forEach((slot) => {
      const entry = aggregate.get(slot) || { count: 0, nicks: [] };
      entry.count += 1;
      entry.nicks.push(participant.nick);
      aggregate.set(slot, entry);
    });
  });

  let maxCount = 0;
  aggregate.forEach((entry) => {
    if (entry.count > maxCount) maxCount = entry.count;
  });

  return { aggregate, participants, maxCount };
}

function formatUtcSlot(slot) {
  const [day, hour] = slot.split("-").map(Number);
  return `${dias[day]} ${String(hour).padStart(2, "0")}:00 UTC`;
}

function renderParticipantList(participants) {
  const container = query("participant-list");
  if (!container) return;

  if (!participants.length) {
    container.innerHTML = '<div class="participant-pill participant-pill-muted">Todavia no hay participantes guardados.</div>';
    return;
  }

  container.innerHTML = participants
    .slice()
    .sort((left, right) => left.nick.localeCompare(right.nick))
    .map((participant) => `<div class="participant-pill">${escapeHtml(participant.nick)}</div>`)
    .join("");
}

function renderUtcSummary(participants, aggregate, maxCount) {
  const summary = query("utc-summary");
  const footer = query("utc-overview-footer");
  if (!summary) return;

  if (!state.currentMeeting) {
    summary.innerHTML = '<div class="summary-empty">Abre una reunion para ver coincidencias.</div>';
    footer?.classList.add("hidden");
    return;
  }

  if (!participants.length) {
    summary.innerHTML = '<div class="summary-empty">Aun no hay horarios guardados en esta reunion.</div>';
    footer?.classList.add("hidden");
    return;
  }

  if (!maxCount) {
    summary.innerHTML = '<div class="summary-empty">Todavia no hay bloques marcados por los participantes.</div>';
    footer?.classList.add("hidden");
    return;
  }

  const bestSlots = [...aggregate.entries()]
    .filter(([, entry]) => entry.count === maxCount)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 4);

  summary.innerHTML = `
    <div class="summary-grid">
      <div class="summary-best-slots">
        ${bestSlots.map(([slot, entry]) => `
          <div class="summary-slot-row">
            <span class="summary-slot-dot"></span>
            <strong class="summary-slot-label">${escapeHtml(formatUtcSlot(slot))}</strong>
            <span class="summary-slot-count">${entry.count}/${participants.length} disponibles</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
  footer?.classList.remove("hidden");
}

function getUtcTooltip() {
  if (state.utcTooltipEl) return state.utcTooltipEl;
  const tooltip = document.createElement("div");
  tooltip.id = "utc-tooltip";
  tooltip.className = "utc-tooltip hidden";
  document.body.appendChild(tooltip);
  state.utcTooltipEl = tooltip;
  return tooltip;
}

function hideUtcTooltip() {
  getUtcTooltip().classList.add("hidden");
}

function positionUtcTooltip(event) {
  const tooltip = getUtcTooltip();
  const offset = 14;
  let left = event.clientX + offset;
  let top = event.clientY + offset;

  const maxLeft = globalThis.innerWidth - tooltip.offsetWidth - 8;
  const maxTop = globalThis.innerHeight - tooltip.offsetHeight - 8;

  if (left > maxLeft) left = maxLeft;
  if (top > maxTop) top = maxTop;
  if (left < 8) left = 8;
  if (top < 8) top = 8;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showUtcTooltip(cell, event) {
  const namesRaw = cell.dataset.names;
  if (!namesRaw) {
    hideUtcTooltip();
    return;
  }

  let names = [];
  try {
    names = JSON.parse(namesRaw);
  } catch {
    names = [];
  }

  if (!Array.isArray(names) || !names.length) {
    hideUtcTooltip();
    return;
  }

  const slot = cell.dataset.slot || "";
  const title = slot ? formatUtcSlot(slot) : "Horario UTC";
  const tooltip = getUtcTooltip();

  tooltip.innerHTML = names.length === 1
    ? `
      <p class="utc-tooltip-slot">${escapeHtml(title)}</p>
      <p class="utc-tooltip-single">${escapeHtml(names[0])}</p>
    `
    : `
      <p class="utc-tooltip-slot">${escapeHtml(title)}</p>
      <p class="utc-tooltip-meta">${names.length} participantes</p>
      <ul class="utc-tooltip-list">${names.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>
    `;

  tooltip.classList.remove("hidden");
  positionUtcTooltip(event);
}

function clearUtcCells() {
  document.querySelectorAll("#grid-utc .grid-cell").forEach((cell) => {
    cell.classList.remove("cell-utc");
    cell.textContent = "";
    cell.style.removeProperty("--availability-strength");
    cell.style.removeProperty("--availability-glow");
    cell.title = "";
    cell.dataset.names = "";
    cell.dataset.count = "";
  });
}

function updateMeetingUI() {
  document.querySelectorAll("#grid-local .grid-cell").forEach((cell) => cell.classList.remove("cell-active"));
  clearUtcCells();

  state.localSchedule.forEach((item) => {
    const [day, hour] = item.split("-").map(Number);
    query(`L-${day}-${hour}`)?.classList.add("cell-active");
  });

  const { aggregate, participants, maxCount } = buildUtcAggregate();
  const participantCount = participants.length || 1;

  aggregate.forEach((entry, slot) => {
    const [day, hour] = slot.split("-").map(Number);
    const cell = query(`U-${day}-${hour}`);
    if (!cell) return;

    const uniqueNicks = [...new Set(entry.nicks)].sort((left, right) => left.localeCompare(right));
    cell.classList.add("cell-utc");
    cell.style.setProperty("--availability-strength", String(entry.count / participantCount));
    cell.style.setProperty("--availability-glow", String(entry.count / Math.max(maxCount || 1, 1)));
    cell.dataset.slot = slot;
    cell.dataset.count = String(entry.count);
    cell.dataset.names = JSON.stringify(uniqueNicks);
    cell.title = `${formatUtcSlot(slot)} · ${uniqueNicks.join(", ")}`;
  });

  renderParticipantList(participants);
  renderUtcSummary(participants, aggregate, maxCount);
}

function renderGrid(containerId, prefix) {
  const container = query(containerId);
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "grid-row grid-header";
  header.innerHTML = '<div class="time-cell"></div>' + dias.map((day) => `<div class="day-label">${day}</div>`).join("");
  container.appendChild(header);

  for (let hour = 0; hour < 24; hour += 1) {
    const row = document.createElement("div");
    row.className = "grid-row";

    const time = document.createElement("div");
    time.className = "time-cell";
    time.textContent = `${String(hour).padStart(2, "0")}:00`;
    row.appendChild(time);

    for (let day = 0; day < 7; day += 1) {
      const cell = document.createElement("button");
      cell.id = `${prefix}-${day}-${hour}`;
      cell.type = "button";
      cell.className = "grid-cell";
      cell.disabled = prefix === "U";
      if (prefix === "L") {
        cell.addEventListener("click", () => toggleHour(day, hour));
      } else {
        cell.dataset.slot = `${day}-${hour}`;
        cell.addEventListener("mouseenter", (event) => showUtcTooltip(event.currentTarget, event));
        cell.addEventListener("mousemove", (event) => {
          if (!getUtcTooltip().classList.contains("hidden")) {
            positionUtcTooltip(event);
          }
        });
        cell.addEventListener("mouseleave", hideUtcTooltip);
      }
      row.appendChild(cell);
    }

    container.appendChild(row);
  }
}

function toggleHour(day, hour) {
  if (!state.currentParticipant) {
    setMeetingStatus("Entra con tu nick para editar tu horario", "error");
    return;
  }

  const key = `${day}-${hour}`;
  const index = state.localSchedule.indexOf(key);
  if (index >= 0) {
    state.localSchedule.splice(index, 1);
  } else {
    state.localSchedule.push(key);
  }
  updateMeetingUI();
}

async function loadMeeting(meetingUid, { restoreParticipantSession = true } = {}) {
  if (!meetingUid) {
    setMeetingState(null);
    updateMeetingUI();
    return;
  }

  try {
    const { response, payload } = await apiFetch(`/api/meetings/${encodeURIComponent(meetingUid)}`);

    if (response.status === 404 || !payload?.exists) {
      showMeetingNotFound();
      return;
    }

    if (!response.ok) {
      throw new Error(payload?.error || "Error al abrir la reunion");
    }

    setMeetingState(payload.meeting);
    showView("meeting");
    updateMeetingUI();

    const withSchedule = payload.meeting.participants.filter(
      (participant) => parseSchedule(participant.localSchedule).length > 0 || parseSchedule(participant.utcSchedule).length > 0,
    ).length;
    const total = payload.meeting.participants.length;
    setMeetingStatus(
      total === 0 ? "Reunion cargada. Nadie ha registrado horario aun." : `${total} participante(s) · ${withSchedule} con horario guardado.`,
      total > 0 ? "ok" : "info",
    );

    if (!restoreParticipantSession) return;

    const storedUid = localStorage.getItem(getParticipantStorageKey(payload.meeting.uid)) || readParticipantSession(payload.meeting.uid)?.uid;
    if (!state.currentParticipant && storedUid) {
      await loadParticipantByUid(storedUid, false);
    }
  } catch (error) {
    console.error(error);
    setMeetingStatus(error.message || "Error al abrir la reunion", "error");
  }
}

async function loadParticipantByUid(uid, showStatus = true) {
  if (!state.currentMeeting?.uid || !uid) return;

  try {
    const participantToken = getParticipantTokenForMeeting(state.currentMeeting.uid);
    const { response, payload } = await apiFetch(`/api/meetings/${encodeURIComponent(state.currentMeeting.uid)}/participants/uid/${encodeURIComponent(uid)}`,
      {
        headers: participantToken ? { "x-participant-token": participantToken } : {},
      });
    if (response.status === 404 || !payload?.exists) {
      clearParticipantSession(state.currentMeeting.uid);
      if (state.currentParticipant?.uid === uid) {
        setParticipantLoggedOut({ clearStorage: false });
      }
      return;
    }

    if (response.status === 409 || payload?.reserved) {
      clearParticipantSession(state.currentMeeting.uid);
      if (state.currentParticipant?.uid === uid) {
        setParticipantLoggedOut({ clearStorage: false });
      }
      if (showStatus) {
        setMeetingStatus(payload?.error || "Este nick ya esta reservado en otro dispositivo", "error");
      }
      return;
    }

    if (!response.ok) return;

    applyParticipantData({ ...payload.participant, participantToken: payload.participantToken });
    if (showStatus) {
      setMeetingStatus(`Bienvenido de vuelta, ${payload.participant.nick}`, "ok");
    }
  } catch (error) {
    console.error(error);
  }
}

async function signInParticipant() {
  if (state.currentParticipant) {
    setParticipantLoggedOut();
    return;
  }

  if (!state.currentMeeting?.uid) {
    setMeetingStatus("Primero abre una reunion", "error");
    return;
  }

  const nick = query("nick").value.trim();
  if (!nick) {
    setMeetingStatus("Escribe tu nick para entrar", "error");
    return;
  }

  query("btn-signin").disabled = true;
  setMeetingStatus("Entrando a la reunion...", "loading");

  try {
    const storedSession = readParticipantSession(state.currentMeeting.uid);
    const lookup = await apiFetch(`/api/meetings/${encodeURIComponent(state.currentMeeting.uid)}/participants/nick/${encodeURIComponent(nick)}`, {
      headers: storedSession?.participantToken ? { "x-participant-token": storedSession.participantToken } : {},
    });
    if (lookup.response.ok && lookup.payload?.exists) {
      applyParticipantData({ ...lookup.payload.participant, participantToken: lookup.payload.participantToken });
      setMeetingStatus(`Bienvenido de vuelta, ${nick}`, "ok");
      return;
    }

    if (lookup.response.status === 409 || lookup.payload?.reserved) {
      throw new Error(lookup.payload?.error || "Ese nick ya fue reservado por otra persona en esta reunion");
    }

    const uid = generateUID();
    const created = await apiFetch(`/api/meetings/${encodeURIComponent(state.currentMeeting.uid)}/participants`, {
      method: "POST",
      body: {
        uid,
        nick,
        participantToken: storedSession?.participantToken || "",
        localSchedule: [],
        utcSchedule: [],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    });

    if (!created.response.ok || !created.payload?.participant) {
      throw new Error(created.payload?.error || "No se pudo entrar a la reunion");
    }

    applyParticipantData({ ...created.payload.participant, participantToken: created.payload.participantToken });
    await loadMeeting(state.currentMeeting.uid, { restoreParticipantSession: false });
    setMeetingStatus(`Entraste como ${nick}. Marca tus horarios y guarda.`, "ok");
  } catch (error) {
    console.error(error);
    setMeetingStatus(error.message || "Error al entrar", "error");
  } finally {
    query("btn-signin").disabled = false;
  }
}

async function saveParticipantSchedule() {
  if (!state.currentMeeting?.uid || !state.currentParticipant) return;

  query("btn-save").disabled = true;
  setMeetingStatus("Guardando horario...", "loading");

  try {
    const { response, payload } = await apiFetch(`/api/meetings/${encodeURIComponent(state.currentMeeting.uid)}/participants`, {
      method: "POST",
      body: {
        uid: state.currentParticipant.uid,
        nick: state.currentParticipant.nick,
        participantToken: state.currentParticipant.participantToken || getParticipantTokenForMeeting(state.currentMeeting.uid),
        localSchedule: state.localSchedule,
        utcSchedule: getCurrentUtcSchedule(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    });

    if (!response.ok || !payload?.participant) {
      throw new Error(payload?.error || "No se pudo guardar el horario");
    }

    applyParticipantData({ ...payload.participant, participantToken: payload.participantToken });
    await loadMeeting(state.currentMeeting.uid, { restoreParticipantSession: false });
    setMeetingStatus("Horario guardado y sincronizado con la reunion.", "ok");
  } catch (error) {
    console.error(error);
    setMeetingStatus(error.message || "Error al guardar", "error");
  } finally {
    query("btn-save").disabled = false;
  }
}

async function copyMeetingLink() {
  if (!state.currentMeeting?.uid) return;

  try {
    await navigator.clipboard.writeText(getMeetingLink(state.currentMeeting.uid));
    setMeetingStatus("Link copiado al portapapeles", "ok");
  } catch (error) {
    console.error(error);
    setMeetingStatus("No se pudo copiar el link", "error");
  }
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = globalThis.setInterval(async () => {
    if (!state.currentMeeting?.uid || document.hidden) return;
    await loadMeeting(state.currentMeeting.uid, { restoreParticipantSession: false });
  }, 15000);
}

function updateLocalTimezoneLabel() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const label = query("local-tz-label");
  const chip = query("local-tz-chip");
  if (label) label.textContent = `Tu horario - ${tz}`;
  if (chip) chip.textContent = tz;
}

async function init() {
  renderGrid("grid-local", "L");
  renderGrid("grid-utc", "U");
  updateLocalTimezoneLabel();
  updateNavigation();
  await restoreAuthSession();

  const meetingUid = getMeetingUidFromUrl();
  if (meetingUid) {
    await loadMeeting(meetingUid);
    return;
  }

  showView("dashboard");
  renderDashboardView();
  await loadDashboardMeetings();
}

globalThis.goToDashboard = goToDashboard;
globalThis.loginUser = loginUser;
globalThis.registerUser = registerUser;
globalThis.requestPasswordReset = requestPasswordReset;
globalThis.resetPasswordWithToken = resetPasswordWithToken;
globalThis.logoutUser = logoutUser;
globalThis.createOwnedMeeting = createOwnedMeeting;
globalThis.openOwnedMeeting = openOwnedMeeting;
globalThis.copyOwnedMeetingLink = copyOwnedMeetingLink;
globalThis.deleteOwnedMeeting = deleteOwnedMeeting;
globalThis.copyMeetingLink = copyMeetingLink;
globalThis.signInParticipant = signInParticipant;
globalThis.saveParticipantSchedule = saveParticipantSchedule;

init();
