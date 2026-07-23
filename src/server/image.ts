/**
 * Image engine — the one place that talks to image-model providers.
 *
 *  - editImage(): directed image edit via OpenRouter's chat-completions image
 *    path (Gemini image). The source product photo is passed as an input so
 *    the model edits the real product instead of inventing one.
 *  - upscaleImage(): fal.ai SeedVR upscale (requires FAL_API_KEY).
 *
 * Every result is re-hosted in R2 so URLs are stable and same-origin.
 */
import { putUpload, readUploadAsBase64DataUrl, rid } from "./uploads.js";

export type ImageEnv = {
  OPENROUTER_API_KEY: string;
  FAL_API_KEY?: string;
};

// Gemini image models on OpenRouter. Default is the fast one; the Pro model
// is a drop-in for hero shots when quality matters more.
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
export const PRO_IMAGE_MODEL = "google/gemini-3-pro-image-preview";

function looksLikeHtml(s: string): boolean {
  return /<!doctype html>|<html\b/i.test(s.slice(0, 200));
}

function summarizeUpstreamError(status: number, body: string): string {
  if (looksLikeHtml(body)) return `${status} upstream error — retried but still failing`;
  return `status ${status}: ${body.slice(0, 400)}`;
}

async function fetchWith5xxRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!isRetryable || attempt === maxRetries) return res;
    const retryAfter = res.headers.get("retry-after");
    const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 10000) : delay;
    await new Promise((r) => setTimeout(r, waitMs));
    delay = Math.min(delay * 2, 10000);
  }
  return fetch(url, init); // unreachable
}

/** Resolve a same-origin /api/uploads/* URL to a base64 data URL so providers can read it. */
export async function resolveForProvider(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith("/api/uploads/")) {
    const filename = imageUrl.replace("/api/uploads/", "");
    const dataUrl = await readUploadAsBase64DataUrl(filename);
    if (dataUrl) return dataUrl;
  }
  return imageUrl;
}

async function rehost(remoteUrl: string, ext: string, mime: string): Promise<string> {
  if (remoteUrl.startsWith("data:")) {
    const base64 = remoteUrl.split(",")[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return putUpload(`${rid("res")}.${ext}`, bytes.buffer, mime);
  }
  const data = await (await fetch(remoteUrl)).arrayBuffer();
  return putUpload(`${rid("res")}.${ext}`, data, mime);
}

/**
 * Directed image edit. `imageUrl` is the source product photo; `prompt` is the
 * resolved tool instruction. Returns the R2 URL of the edited image.
 */
export async function editImage(
  env: ImageEnv,
  opts: { imageUrl: string; prompt: string; model?: string },
): Promise<{ url: string }> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const model = opts.model || DEFAULT_IMAGE_MODEL;
  const inputUrl = await resolveForProvider(opts.imageUrl);

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: inputUrl } },
          { type: "text", text: opts.prompt },
        ],
      },
    ],
    modalities: ["image", "text"],
  };

  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWith5xxRetry("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://clawnify.com",
          "X-Title": "Open Listing Studio",
        },
        body: JSON.stringify(body),
      });
      const rawText = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${summarizeUpstreamError(res.status, rawText)}`);
      if (looksLikeHtml(rawText)) throw new Error("OpenRouter returned HTML — retrying");
      const data = JSON.parse(rawText) as {
        choices?: Array<{ message?: { images?: Array<{ image_url: { url: string } }> } }>;
      };
      const img = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!img) throw new Error("Model returned no image");
      return { url: await rehost(img, "png", "image/png") };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastError || new Error("Image edit failed after retries");
}

/** Upscale via fal.ai SeedVR. Requires FAL_API_KEY. */
export async function upscaleImage(
  env: ImageEnv,
  opts: { imageUrl: string; factor?: number },
): Promise<{ url: string }> {
  if (!env.FAL_API_KEY) throw new Error("Upscale needs FAL_API_KEY set in the app environment");
  const inputUrl = await resolveForProvider(opts.imageUrl);
  const res = await fetchWith5xxRetry("https://fal.run/fal-ai/seedvr/upscale/image", {
    method: "POST",
    headers: { Authorization: `Key ${env.FAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: inputUrl,
      upscale_mode: "factor",
      upscale_factor: opts.factor ?? 2,
      output_format: "png",
    }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`fal.ai ${summarizeUpstreamError(res.status, rawText)}`);
  const data = JSON.parse(rawText) as { image?: { url: string } };
  if (!data.image?.url) throw new Error("fal.ai response missing image url");
  return { url: await rehost(data.image.url, "png", "image/png") };
}
