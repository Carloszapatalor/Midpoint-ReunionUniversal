const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const RECOVERY_FROM_EMAIL = Deno.env.get("RECOVERY_FROM_EMAIL") || "Reunion Universal <onboarding@resend.dev>";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") || "http://localhost:8000";

type SendResult = { delivered: boolean; fallback: boolean };

function buildRecoveryLink(token: string) {
  const url = new URL(APP_BASE_URL);
  url.searchParams.set("recovery", token);
  return url.toString();
}

function buildHtml(link: string) {
  return `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f1b17;">
      <h2 style="margin: 0 0 12px;">Tus reuniones en Reunion Universal</h2>
      <p style="margin: 0 0 16px;">Hola, recibimos una solicitud para recuperar tus reuniones asociadas a este email.</p>
      <p style="margin: 0 0 16px;">
        <a href="${link}" style="display: inline-block; padding: 10px 16px; border-radius: 12px; background: #ea580c; color: #fff7ed; text-decoration: none; font-weight: 700;">
          Restaurar mis reuniones
        </a>
      </p>
      <p style="margin: 0 0 16px; color: #57534e;">O copia este enlace en tu navegador:</p>
      <p style="margin: 0 0 16px; word-break: break-all;"><code>${link}</code></p>
      <p style="margin: 0; color: #78716c; font-size: 13px;">El enlace expira en 30 minutos y solo se puede usar una vez. Si no lo solicitaste, ignora este correo.</p>
    </div>
  `;
}

export async function sendRecoveryEmail(email: string, token: string): Promise<SendResult> {
  const link = buildRecoveryLink(token);

  if (!RESEND_API_KEY) {
    console.warn(`[mailer] RESEND_API_KEY no configurado. Link de recuperacion para ${email}: ${link}`);
    return { delivered: false, fallback: true };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RECOVERY_FROM_EMAIL,
        to: [email],
        subject: "Recupera tus reuniones",
        html: buildHtml(link),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[mailer] Resend fallo (${response.status}): ${body}. Link: ${link}`);
      return { delivered: false, fallback: true };
    }

    return { delivered: true, fallback: false };
  } catch (error) {
    console.error(`[mailer] Error enviando email:`, error, `Link: ${link}`);
    return { delivered: false, fallback: true };
  }
}
