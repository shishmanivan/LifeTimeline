const RESEND_SEND_EMAIL_URL = "https://api.resend.com/emails";

export type SendRecoveryCodeEmailInput = {
  to: string;
  code: string;
  expiresAtIso: string;
};

export function isRecoveryEmailConfigured(): boolean {
  const apiKey = process.env.RECOVERY_EMAIL_API_KEY?.trim();
  const from = process.env.RECOVERY_EMAIL_FROM?.trim();
  return Boolean(apiKey && from);
}

function extractResendErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") {
    return record.message;
  }
  const err = record.error;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") {
      return msg;
    }
  }
  return undefined;
}

/**
 * Sends a recovery code via Resend HTTP API.
 * Expects RECOVERY_EMAIL_API_KEY and RECOVERY_EMAIL_FROM to be set; callers
 * should use {@link isRecoveryEmailConfigured} first.
 */
export async function sendRecoveryCodeEmail(
  input: SendRecoveryCodeEmailInput
): Promise<void> {
  const apiKey = process.env.RECOVERY_EMAIL_API_KEY?.trim();
  const from = process.env.RECOVERY_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    throw new Error(
      "sendRecoveryCodeEmail requires RECOVERY_EMAIL_API_KEY and RECOVERY_EMAIL_FROM"
    );
  }

  const text = [
    `Your recovery code is: ${input.code}`,
    "",
    `This code expires at ${input.expiresAtIso} (ISO 8601).`,
    "",
    "If you did not request this code, you can ignore this email.",
  ].join("\n");

  const response = await fetch(RESEND_SEND_EMAIL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: "Your recovery code",
      text,
    }),
  });

  if (response.ok) {
    return;
  }

  let detail = response.statusText || `HTTP ${response.status}`;
  const raw = await response.text();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const msg = extractResendErrorMessage(parsed);
      if (msg) {
        detail = msg;
      } else {
        detail = raw.slice(0, 500);
      }
    } catch {
      detail = raw.slice(0, 500);
    }
  }

  throw new Error(`Resend email send failed (${response.status}): ${detail}`);
}
