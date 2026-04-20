const dias = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const REFERENCE_MONDAY = { year: 2025, month: 0, day: 6 };

let localSchedule = [];
let currentMeeting = null;
let currentUser = null;
let refreshTimer = null;
let utcTooltipEl = null;

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

function getUtcTooltip() {
  if (utcTooltipEl) return utcTooltipEl;

  utcTooltipEl = document.createElement("div");
  utcTooltipEl.id = "utc-tooltip";
  utcTooltipEl.className = "utc-tooltip hidden";
  document.body.appendChild(utcTooltipEl);
  return utcTooltipEl;
}

function hideUtcTooltip() {
  const tooltip = getUtcTooltip();
  tooltip.classList.add("hidden");
}

function positionUtcTooltip(event) {
  const tooltip = getUtcTooltip();
  const offset = 14;
  let left = event.clientX + offset;
  let top = event.clientY + offset;

  const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
  const maxTop = window.innerHeight - tooltip.offsetHeight - 8;

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

  if (names.length === 1) {
    tooltip.innerHTML = `
      <p class="utc-tooltip-slot">${escapeHtml(title)}</p>
      <p class="utc-tooltip-single">${escapeHtml(names[0])}</p>
    `;
  } else {
    tooltip.innerHTML = `
      <p class="utc-tooltip-slot">${escapeHtml(title)}</p>
      <p class="utc-tooltip-meta">${names.length} participantes</p>
      <ul class="utc-tooltip-list">
        ${names.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}
      </ul>
    `;
  }

  tooltip.classList.remove("hidden");
  positionUtcTooltip(event);
}

function onUtcCellEnter(event) {
  showUtcTooltip(event.currentTarget, event);
}

function onUtcCellMove(event) {
  const tooltip = getUtcTooltip();
  if (tooltip.classList.contains("hidden")) return;
  positionUtcTooltip(event);
}

function onUtcCellLeave() {
  hideUtcTooltip();
}

function getMeetingUidFromUrl() {
  return new URLSearchParams(window.location.search).get("meeting") || "";
}

function getMeetingLink(meetingUid = getMeetingUidFromUrl()) {
  if (!meetingUid) return "";
  const url = new URL(window.location.href);
  url.searchParams.set("meeting", meetingUid);
  return url.toString();
}

function getParticipantStorageKey(meetingUid) {
  return `agenda:meeting:${meetingUid}:participantUid`;
}

function getSessionStorageKey(meetingUid) {
  return `agenda:meeting:${meetingUid}:session`;
}

function persistSession(user) {
  if (!user?.meetingUid) return;
  localStorage.setItem(getSessionStorageKey(user.meetingUid), JSON.stringify({ uid: user.uid, nick: user.nick }));
}

function readSession(meetingUid) {
  if (!meetingUid) return null;

  const raw = localStorage.getItem(getSessionStorageKey(meetingUid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.uid && !parsed?.nick) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearSession(meetingUid) {
  if (!meetingUid) return;
  localStorage.removeItem(getParticipantStorageKey(meetingUid));
  localStorage.removeItem(getSessionStorageKey(meetingUid));
}

function setStatus(message, type = "info") {
  const el = document.getElementById("status");
  el.dataset.state = type;
  el.textContent = message;
}

function setLoggedIn(user) {
  currentUser = user;
  persistSession(user);
  document.getElementById("nick").value = user.nick;
  document.getElementById("nick").disabled = true;
  document.getElementById("btn-signin").textContent = "Salir";
  document.getElementById("btn-save").disabled = false;
  setStatus(`Dentro de la reunion como ${user.nick}`, "ok");
}

function setLoggedOut(options = { clearStorage: true }) {
  if (options.clearStorage && currentMeeting?.uid) {
    clearSession(currentMeeting.uid);
  }

  currentUser = null;
  localSchedule = [];
  document.getElementById("nick").value = "";
  document.getElementById("nick").disabled = false;
  document.getElementById("btn-signin").textContent = "Entrarxd";
  document.getElementById("btn-save").disabled = true;
  updateUI();
  setStatus("", "info");
}

function setMeetingState(meeting) {
  currentMeeting = meeting;
  const details = document.getElementById("meeting-details");
  const copyButton = document.getElementById("btn-copy-link");

  if (!meeting) {
    details.classList.add("hidden");
    document.getElementById("meeting-name").textContent = "Sin reunion";
    document.getElementById("meeting-code").textContent = "UID pendiente";
    document.getElementById("meeting-link").value = "";
    document.getElementById("meeting-stats").textContent = "Crea una reunion para comenzar.";
    document.getElementById("participant-list").innerHTML = "";
    document.getElementById("utc-summary").textContent = "Esperando participantes.";
    copyButton.disabled = true;
    setLoggedOut({ clearStorage: false });
    stopAutoRefresh();
    return;
  }

  details.classList.remove("hidden");
  document.getElementById("meeting-name").textContent = meeting.title;
  document.getElementById("meeting-code").textContent = meeting.uid;
  document.getElementById("meeting-link").value = getMeetingLink(meeting.uid);
  document.getElementById("meeting-stats").textContent = `${meeting.participants.length} participante(s) en esta reunion.`;
  copyButton.disabled = false;
  startAutoRefresh();
}

function applyUserData(user) {
  localSchedule = parseSchedule(user.localSchedule);
  localStorage.setItem(getParticipantStorageKey(user.meetingUid), user.uid);
  setLoggedIn({ uid: user.uid, nick: user.nick, meetingUid: user.meetingUid });
  updateUI();
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
  return toUtcScheduleFromLocal(localSchedule);
}

function getParticipantsForAggregate() {
  if (!currentMeeting) return [];

  const participants = (currentMeeting.participants || []).map((participant) => ({
    ...participant,
    localSchedule: parseSchedule(participant.localSchedule),
    utcSchedule: (() => {
      const storedUtc = parseSchedule(participant.utcSchedule);
      if (storedUtc.length > 0) return storedUtc;
      return toUtcScheduleFromLocal(participant.localSchedule);
    })(),
  }));

  if (!currentUser) return participants;

  const currentUtc = getCurrentUtcSchedule();
  const index = participants.findIndex((participant) => participant.uid === currentUser.uid);

  if (index >= 0) {
    participants[index] = {
      ...participants[index],
      localSchedule: [...localSchedule],
      utcSchedule: currentUtc,
    };
    return participants;
  }

  return [
    ...participants,
    {
      uid: currentUser.uid,
      meetingUid: currentMeeting.uid,
      nick: currentUser.nick,
      localSchedule: [...localSchedule],
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
    if (entry.count > maxCount) {
      maxCount = entry.count;
    }
  });

  return { aggregate, participants, maxCount };
}

function formatUtcSlot(slot) {
  const [day, hour] = slot.split("-").map(Number);
  return `${dias[day]} ${String(hour).padStart(2, "0")}:00 UTC`;
}

function renderParticipantList(participants) {
  const container = document.getElementById("participant-list");

  if (!participants.length) {
    container.innerHTML = '<div class="participant-pill participant-pill-muted">Todavia no hay participantes guardados.</div>';
    return;
  }

  container.innerHTML = participants
    .slice()
    .sort((left, right) => left.nick.localeCompare(right.nick))
    .map((participant) => {
      const slots = parseSchedule(participant.utcSchedule).length;
      const timezone = participant.timezone || "UTC";
      return `<div class="participant-pill">${participant.nick} <span>${timezone} · ${slots} bloque(s)</span></div>`;
    })
    .join("");
}

function renderUtcSummary(participants, aggregate, maxCount) {
  const summary = document.getElementById("utc-summary");

  if (!currentMeeting) {
    summary.textContent = "Crea o abre una reunion para ver coincidencias.";
    return;
  }

  if (!participants.length) {
    summary.textContent = "Aun no hay horarios guardados en esta reunion.";
    return;
  }

  if (!maxCount) {
    summary.textContent = "Todavia no hay bloques marcados por los participantes.";
    return;
  }

  const bestSlots = [...aggregate.entries()]
    .filter(([, entry]) => entry.count === maxCount)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 4);

  summary.innerHTML = bestSlots
    .map(([slot, entry]) => `<strong>${formatUtcSlot(slot)}</strong> · ${entry.count}/${participants.length} disponibles`)
    .join("<br>");
}

function clearUtcCells() {
  document.querySelectorAll("#grid-utc .grid-cell").forEach((cell) => {
    cell.classList.remove("cell-utc", "cell-best", "cell-all");
    cell.textContent = "";
    cell.style.removeProperty("--availability-strength");
    cell.title = "";
    cell.dataset.names = "";
    cell.dataset.count = "";
  });
}

function updateUI() {
  document.querySelectorAll("#grid-local .grid-cell").forEach((cell) => cell.classList.remove("cell-active"));
  clearUtcCells();

  localSchedule.forEach((item) => {
    const [day, hour] = item.split("-").map(Number);
    document.getElementById(`L-${day}-${hour}`)?.classList.add("cell-active");
  });

  const { aggregate, participants, maxCount } = buildUtcAggregate();
  const participantCount = participants.length || 1;

  aggregate.forEach((entry, slot) => {
    const [day, hour] = slot.split("-").map(Number);
    const cell = document.getElementById(`U-${day}-${hour}`);
    if (!cell) return;

    const uniqueNicks = [...new Set(entry.nicks)].sort((left, right) => left.localeCompare(right));

    cell.classList.add("cell-utc");
    if (entry.count === maxCount && maxCount > 0) cell.classList.add("cell-best");
    if (entry.count === participants.length && participants.length > 0) cell.classList.add("cell-all");
    cell.style.setProperty("--availability-strength", String(entry.count / participantCount));
    cell.textContent = String(entry.count);
    cell.dataset.slot = slot;
    cell.dataset.count = String(entry.count);
    cell.dataset.names = JSON.stringify(uniqueNicks);
    cell.title = `${formatUtcSlot(slot)} · ${uniqueNicks.join(", ")}`;
  });

  renderParticipantList(participants);
  renderUtcSummary(participants, aggregate, maxCount);
}

function renderGrid(containerId, prefix) {
  const container = document.getElementById(containerId);
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
        cell.addEventListener("mouseenter", onUtcCellEnter);
        cell.addEventListener("mousemove", onUtcCellMove);
        cell.addEventListener("mouseleave", onUtcCellLeave);
      }
      row.appendChild(cell);
    }

    container.appendChild(row);
  }
}

function toggleHour(day, hour) {
  if (!currentUser) {
    setStatus("Entra con tu nick para editar tu horario", "error");
    return;
  }

  const key = `${day}-${hour}`;
  const index = localSchedule.indexOf(key);
  if (index >= 0) {
    localSchedule.splice(index, 1);
  } else {
    localSchedule.push(key);
  }
  updateUI();
}

async function createMeeting() {
  const title = document.getElementById("meeting-title").value.trim();
  if (!title) {
    setStatus("Escribe un titulo para crear la reunion", "error");
    return;
  }

  const button = document.getElementById("btn-create-meeting");
  button.disabled = true;
  setStatus("Creando reunion...", "loading");

  try {
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.meeting) {
      throw new Error(payload.error || "No se pudo crear la reunion");
    }

    const url = new URL(window.location.href);
    url.searchParams.set("meeting", payload.meeting.uid);
    window.history.replaceState({}, "", url);
    document.getElementById("meeting-title").value = payload.meeting.title;

    await loadMeeting(payload.meeting.uid);
    setStatus("Reunion creada. Comparte el link y entra con tu nick.", "ok");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Error al crear la reunion", "error");
  } finally {
    button.disabled = false;
  }
}

async function loadMeeting(meetingUid, { restoreSession = true } = {}) {
  if (!meetingUid) {
    setMeetingState(null);
    updateUI();
    return;
  }

  try {
    const response = await fetch(`/api/meetings/${encodeURIComponent(meetingUid)}`);
    const payload = await response.json();

    if (response.status === 404 || !payload.exists) {
      setMeetingState(null);
      updateUI();
      throw new Error(payload.error || "La reunion no existe");
    }

    if (!response.ok) {
      throw new Error(payload.error || "Error al abrir la reunion");
    }

    // 1. Establecer la reunion y pintar UTC con TODOS los participantes ya guardados,
    //    sin importar si el usuario actual tiene sesion o no.
    setMeetingState(payload.meeting);
    document.getElementById("meeting-title").value = payload.meeting.title;
    updateUI();

    const withSchedule = payload.meeting.participants.filter(
      (p) => parseSchedule(p.localSchedule).length > 0 || parseSchedule(p.utcSchedule).length > 0,
    ).length;
    const total = payload.meeting.participants.length;
    setStatus(
      total === 0
        ? "Reunion cargada. Nadie ha registrado horario aun."
        : `${total} participante(s) · ${withSchedule} con horario guardado.`,
      total > 0 ? "ok" : "info",
    );

    // 2. Restaurar sesion si aplica (independiente del paso anterior).
    if (!restoreSession) return;

    const storedUid =
      localStorage.getItem(getParticipantStorageKey(payload.meeting.uid)) ||
      readSession(payload.meeting.uid)?.uid;

    if (!currentUser && storedUid) {
      await loadParticipantByUid(storedUid, false);
    } else if (currentUser) {
      const stillExists = payload.meeting.participants.find((p) => p.uid === currentUser.uid);
      if (!stillExists) {
        await loadParticipantByUid(currentUser.uid, false);
      }
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Error al abrir la reunion", "error");
  }
}

async function loadParticipantByUid(uid, showStatus = true) {
  if (!currentMeeting?.uid || !uid) return;

  try {
    const response = await fetch(`/api/meetings/${encodeURIComponent(currentMeeting.uid)}/participants/uid/${encodeURIComponent(uid)}`);
    const payload = await response.json();

    if (response.status === 404 || !payload.exists) {
      clearSession(currentMeeting.uid);
      if (currentUser?.uid === uid) {
        setLoggedOut({ clearStorage: false });
      }
      return;
    }

    if (!response.ok) {
      return;
    }

    applyUserData(payload.participant);
    if (showStatus) {
      setStatus(`Bienvenido de vuelta, ${payload.participant.nick}`, "ok");
    }
  } catch (error) {
    console.error(error);
  }
}

async function signIn() {
  if (currentUser) {
    setLoggedOut();
    return;
  }

  if (!currentMeeting?.uid) {
    setStatus("Primero crea o abre una reunion", "error");
    return;
  }

  const nick = document.getElementById("nick").value.trim();
  if (!nick) {
    setStatus("Escribe tu nick para entrar", "error");
    return;
  }

  const button = document.getElementById("btn-signin");
  button.disabled = true;
  setStatus("Entrando a la reunion...", "loading");

  try {
    const lookup = await fetch(`/api/meetings/${encodeURIComponent(currentMeeting.uid)}/participants/nick/${encodeURIComponent(nick)}`);
    const lookupData = await lookup.json();

    if (lookup.ok && lookupData.exists) {
      applyUserData(lookupData.participant);
      setStatus(`Bienvenido de vuelta, ${nick}`, "ok");
      return;
    }

    const uid = generateUID();
    const saveResponse = await fetch(`/api/meetings/${encodeURIComponent(currentMeeting.uid)}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid,
        nick,
        localSchedule: [],
        utcSchedule: [],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    });
    const savePayload = await saveResponse.json();

    if (!saveResponse.ok || !savePayload.participant) {
      throw new Error(savePayload.error || "No se pudo entrar a la reunion");
    }

    applyUserData(savePayload.participant);
    await loadMeeting(currentMeeting.uid, { restoreSession: false });
    setStatus(`Entraste como ${nick}. Marca tus horarios y guarda.`, "ok");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Error al entrar", "error");
  } finally {
    button.disabled = false;
  }
}

async function saveUser() {
  if (!currentMeeting?.uid || !currentUser) {
    return;
  }

  const button = document.getElementById("btn-save");
  button.disabled = true;
  setStatus("Guardando horario...", "loading");

  try {
    const response = await fetch(`/api/meetings/${encodeURIComponent(currentMeeting.uid)}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentUser.uid,
        nick: currentUser.nick,
        localSchedule,
        utcSchedule: getCurrentUtcSchedule(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.participant) {
      throw new Error(payload.error || "No se pudo guardar el horario");
    }

    applyUserData(payload.participant);
    await loadMeeting(currentMeeting.uid, { restoreSession: false });
    setStatus("Horario guardado y sincronizado con la reunion.", "ok");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Error al guardar", "error");
  } finally {
    button.disabled = false;
  }
}

async function copyMeetingLink() {
  const link = getMeetingLink(currentMeeting?.uid);
  if (!link) return;

  try {
    await navigator.clipboard.writeText(link);
    setStatus("Link copiado al portapapeles", "ok");
  } catch (error) {
    console.error(error);
    setStatus("No se pudo copiar el link", "error");
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = window.setInterval(async () => {
    if (!currentMeeting?.uid || document.hidden) return;

    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(currentMeeting.uid)}`);
      const payload = await response.json();
      if (!response.ok || !payload.exists) return;
      currentMeeting = payload.meeting;
      document.getElementById("meeting-stats").textContent = `${currentMeeting.participants.length} participante(s) en esta reunion.`;
      updateUI();
      // Pintar UTC sin perturbar la sesion activa
    } catch (error) {
      console.error(error);
    }
  }, 15000);
}

function init() {
  renderGrid("grid-local", "L");
  renderGrid("grid-utc", "U");
  setMeetingState(null);
  updateUI();

  const meetingUid = getMeetingUidFromUrl();
  if (meetingUid) {
    setStatus("Cargando horarios de la reunion...", "loading");
    loadMeeting(meetingUid, { restoreSession: true });
  }
}

window.createMeeting = createMeeting;
window.copyMeetingLink = copyMeetingLink;
window.signIn = signIn;
window.saveUser = saveUser;

init();