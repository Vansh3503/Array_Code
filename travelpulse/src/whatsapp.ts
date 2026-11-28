import type { Env } from "./types";

export interface Recipient {
  label: string;
  phone: string; // digits only, international format without "+"
}

/** RECIPIENTS secret: "Mom:+919800000000,Dad:+919811111111" */
export function parseRecipients(raw: string | undefined): Recipient[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part, i) => {
      const [a, b] = part.includes(":") ? part.split(":", 2) : [`Recipient ${i + 1}`, part];
      return { label: a.trim(), phone: (b ?? "").replace(/[^\d]/g, "") };
    })
    .filter((r) => r.phone.length >= 8 && r.phone.length <= 15);
}

export type WaMode = "dry_run" | "template" | "text";

export function waMode(env: Env): WaMode {
  const m = (env.WHATSAPP_MODE ?? "dry_run").toLowerCase();
  return m === "template" || m === "text" ? m : "dry_run";
}

export interface SendResult {
  ok: boolean;
  wamid?: string;
  error?: string;
  code?: number;
  retryable?: boolean;
}

// Meta error codes that are worth retrying later.
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

async function post(env: Env, payload: unknown): Promise<SendResult> {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not configured", retryable: false };
  }
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION ?? "v25.0"}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    if (res.ok && data.messages?.[0]?.id) return { ok: true, wamid: data.messages[0].id };
    const code = data.error?.code;
    const detail = data.error?.error_data?.details;
    return {
      ok: false,
      code,
      error: `HTTP ${res.status} ${code ?? ""} ${data.error?.message ?? ""}${detail ? ` – ${detail}` : ""}`.trim(),
      retryable: res.status >= 500 || (code !== undefined && RETRYABLE.has(code)),
    };
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}`, retryable: true };
  }
}

export function templatePayload(env: Env, to: string, params: string[]) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME ?? "travel_update",
      language: { code: env.WHATSAPP_TEMPLATE_LANG ?? "en" },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
    },
  };
}

export function textPayload(to: string, body: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: body.slice(0, 4096) },
  };
}

/**
 * Send one message. In "text" mode we fall back to the template automatically when Meta
 * says the 24-hour customer-service window is closed (error 131047).
 */
export async function sendWhatsApp(
  env: Env,
  mode: WaMode,
  to: string,
  text: string,
  params: string[],
): Promise<SendResult> {
  if (mode === "dry_run") return { ok: true, wamid: undefined };
  if (mode === "text") {
    const r = await post(env, textPayload(to, text));
    if (r.ok || r.code !== 131047 || !env.WHATSAPP_TEMPLATE_NAME) return r;
  }
  return post(env, templatePayload(env, to, params));
}

/** Verify Meta's X-Hub-Signature-256 header on webhook deliveries. */
export async function verifyMetaSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
