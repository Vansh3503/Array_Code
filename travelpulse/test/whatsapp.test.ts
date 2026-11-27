import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhatsApp } from "../src/whatsapp";
import type { Env } from "../src/types";

const env = {
  WHATSAPP_TOKEN: "tok",
  WHATSAPP_PHONE_NUMBER_ID: "12345",
  WHATSAPP_API_VERSION: "v25.0",
  WHATSAPP_TEMPLATE_NAME: "travel_update",
  WHATSAPP_TEMPLATE_LANG: "en",
} as unknown as Env;

const params = ["h", "loc", "3:30 PM", "2:00 AM", "78%", "8°C", "Las Vegas", "https://maps", "https://live"];

afterEach(() => vi.unstubAllGlobals());

function mockFetch(...responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: any; auth: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

describe("sendWhatsApp", () => {
  it("sends an approved template with 9 body parameters", async () => {
    const calls = mockFetch({ status: 200, body: { messages: [{ id: "wamid.1" }] } });
    const r = await sendWhatsApp(env, "template", "919800000000", "full text", params);
    expect(r).toEqual({ ok: true, wamid: "wamid.1" });
    expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/12345/messages");
    expect(calls[0].auth).toBe("Bearer tok");
    expect(calls[0].body.type).toBe("template");
    expect(calls[0].body.template.name).toBe("travel_update");
    expect(calls[0].body.template.components[0].parameters).toHaveLength(9);
  });

  it("text mode falls back to the template when the 24h window is closed (131047)", async () => {
    const calls = mockFetch(
      { status: 400, body: { error: { code: 131047, message: "Re-engagement message" } } },
      { status: 200, body: { messages: [{ id: "wamid.2" }] } },
    );
    const r = await sendWhatsApp(env, "text", "919800000000", "full text", params);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.body.type)).toEqual(["text", "template"]);
  });

  it("classifies retryable vs permanent errors", async () => {
    mockFetch({ status: 429, body: { error: { code: 130429, message: "rate limit" } } });
    expect((await sendWhatsApp(env, "template", "1", "t", params)).retryable).toBe(true);
    mockFetch({ status: 400, body: { error: { code: 132001, message: "Template name does not exist" } } });
    const r = await sendWhatsApp(env, "template", "1", "t", params);
    expect(r.retryable).toBe(false);
    expect(r.error).toContain("132001");
  });

  it("dry_run never calls the network", async () => {
    const calls = mockFetch();
    expect((await sendWhatsApp(env, "dry_run", "1", "t", params)).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
