function byId(id) {
  return document.getElementById(id);
}

function setStatus(id, message, type = "info") {
  const el = byId(id);
  if (!el) return;
  el.dataset.state = type;
  el.textContent = message;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { response, payload };
}

async function requestRecoveryToken() {
  const username = String(byId("recovery-username")?.value || "").trim();
  if (!username) {
    setStatus("recovery-status", "Escribe tu usuario", "error");
    return;
  }

  const button = byId("btn-request-token");
  if (button) button.disabled = true;
  setStatus("recovery-status", "Generando codigo...", "loading");

  try {
    const { response, payload } = await postJson("/api/auth/token", { username });
    if (!response.ok) {
      throw new Error(payload?.error || "No se pudo generar el codigo");
    }

    if (payload?.resetToken) {
      setStatus("recovery-status", `Codigo temporal: ${payload.resetToken}`, "ok");
      sessionStorage.setItem("agenda:lastResetToken", String(payload.resetToken));
      sessionStorage.setItem("agenda:lastResetUsername", username);
      return;
    }

    setStatus("recovery-status", payload?.message || "Si el usuario existe, se genero un codigo temporal.", "info");
  } catch (error) {
    console.error(error);
    setStatus("recovery-status", error.message || "Error al generar codigo", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitPasswordReset() {
  const username = String(byId("reset-username")?.value || "").trim();
  const token = String(byId("reset-token")?.value || "").trim();
  const newPassword = String(byId("reset-password")?.value || "");

  if (!username || !token || !newPassword) {
    setStatus("reset-status", "Completa usuario, codigo y contrasena", "error");
    return;
  }

  const button = byId("btn-reset-password");
  if (button) button.disabled = true;
  setStatus("reset-status", "Restableciendo...", "loading");

  try {
    const { response, payload } = await postJson("/api/auth/restablecer", {
      username,
      token,
      newPassword,
    });

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "No se pudo restablecer la contrasena");
    }

    setStatus("reset-status", payload.message || "Contrasena actualizada.", "ok");
    sessionStorage.removeItem("agenda:lastResetToken");
  } catch (error) {
    console.error(error);
    setStatus("reset-status", error.message || "Error al restablecer", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function hydrateResetForm() {
  const usernameInput = byId("reset-username");
  const tokenInput = byId("reset-token");
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = sessionStorage.getItem("agenda:lastResetUsername") || "";
  }
  if (tokenInput && !tokenInput.value) {
    tokenInput.value = sessionStorage.getItem("agenda:lastResetToken") || "";
  }
}

globalThis.requestRecoveryToken = requestRecoveryToken;
globalThis.submitPasswordReset = submitPasswordReset;

hydrateResetForm();
