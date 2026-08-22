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
// is a drop-in for hero shots when quality matters more. (The `-preview`
// variants 404 at the provider since the GA models shipped — verified live.)
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image";
export const PRO_IMAGE_MODEL = "google/gemini-3-pro-image";

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
  opts: { imageUrl: string; prompt: string; model?: string; extraImages?: string[] },
): Promise<{ url: string }> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const model = opts.model || DEFAULT_IMAGE_MODEL;
  const inputUrl = await resolveForProvider(opts.imageUrl);
  const extra = await Promise.all((opts.extraImages || []).map((u) => resolveForProvider(u)));

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: inputUrl } },
          ...extra.map((u) => ({ type: "image_url", image_url: { url: u } })),
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
          "X-Title": "OpenListingStudio",
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

// ── Alpha detection ──────────────────────────────────────────────────

/**
 * True when the image bytes carry a REAL alpha channel:
 *   PNG  — color type 6 (RGBA) or 4 (gray+alpha), or a tRNS chunk on
 *          palette/grayscale/truecolor images.
 *   WebP — VP8X alpha flag, or the VP8L lossless alpha bit.
 * Everything else (JPEG, opaque PNG/WebP) → false. Used to validate uploaded
 * cutouts and to skip BiRefNet when the source is already transparent.
 */
export function hasAlphaChannel(bytes: Uint8Array): boolean {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length > 33 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const colorType = bytes[25];
    if (colorType === 4 || colorType === 6) return true;
    // Scan chunks for tRNS (transparency on palette/opaque color types).
    let off = 8;
    while (off + 8 <= bytes.length) {
      const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (type === "tRNS") return true;
      if (type === "IDAT" || type === "IEND") break; // tRNS must precede IDAT
      off += 12 + len;
    }
    return false;
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length > 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourcc === "VP8X") return (bytes[20] & 0x10) !== 0; // extended header alpha flag
    if (fourcc === "VP8L") return (bytes[24] & 0x10) !== 0; // lossless alpha bit
    return false; // plain VP8 (lossy) has no alpha
  }
  return false;
}

// ── Dispatchers (open-studio pattern: provider routing lives in ONE place) ──

/**
 * Single image-operation dispatcher shared by the UI tool route, the agent v1
 * route, and the launch main-image render — so provider branching (fal vs
 * OpenRouter, key checks, fallbacks) is written exactly once.
 *   op "edit"       → OpenRouter Gemini image edit (reference images in).
 *   op "upscale"    → fal.ai SeedVR when FAL_API_KEY is set, else a Gemini
 *                     enhance pass so the tool still works OpenRouter-only.
 *   op "remove_bg"  → fal.ai BiRefNet v2 (true alpha matting). No model
 *                     fallback — a generative "edit" can't produce real
 *                     transparency, so this op requires FAL_API_KEY.
 */
export async function routeImage(
  env: ImageEnv,
  params: { op: "edit" | "upscale" | "remove_bg"; imageUrl: string; prompt: string; model?: string; extraImages?: string[] },
): Promise<{ url: string }> {
  if (params.op === "remove_bg") {
    return removeBackground(env, { imageUrl: params.imageUrl });
  }
  if (params.op === "upscale" && env.FAL_API_KEY) {
    return upscaleImage(env, { imageUrl: params.imageUrl });
  }
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set — configure it in the app environment");
  }
  return editImage(env, { imageUrl: params.imageUrl, prompt: params.prompt, model: params.model, extraImages: params.extraImages });
}

/**
 * Vision analyze via OpenRouter (routeAnalyze pattern): images + prompt →
 * text or JSON. Used by the asset QA pass.
 */
export async function analyzeImage(
  env: ImageEnv & { LISTING_MODEL?: string },
  params: { prompt: string; imageUrls: string[]; model?: string },
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const model = params.model || env.LISTING_MODEL || "anthropic/claude-sonnet-4";
  const content: Array<Record<string, unknown>> = [];
  for (const u of params.imageUrls) content.push({ type: "image_url", image_url: { url: await resolveForProvider(u) } });
  content.push({ type: "text", text: params.prompt });
  const res = await fetchWith5xxRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenListingStudio",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${summarizeUpstreamError(res.status, raw)}`);
  const data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Vision model returned no content");
  return text;
}

/**
 * Background removal via fal.ai BiRefNet v2 → transparent PNG, rehosted in R2.
 * Contract (verified against fal's current v2 API page): POST
 * https://fal.run/fal-ai/birefnet/v2 with { image_url, output_format,
 * refine_foreground } → { image: { url } }. Requires FAL_API_KEY.
 */
export async function removeBackground(
  env: ImageEnv,
  opts: { imageUrl: string },
): Promise<{ url: string }> {
  if (!env.FAL_API_KEY) throw new Error("Background removal needs FAL_API_KEY set in the app environment");
  const inputUrl = await resolveForProvider(opts.imageUrl);
  const res = await fetchWith5xxRetry("https://fal.run/fal-ai/birefnet/v2", {
    method: "POST",
    headers: { Authorization: `Key ${env.FAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: inputUrl,
      output_format: "png", // png keeps the alpha channel
      refine_foreground: true, // cleaner product edges for compositing
    }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`fal.ai birefnet ${summarizeUpstreamError(res.status, rawText)}`);
  const data = JSON.parse(rawText) as { image?: { url: string } };
  if (!data.image?.url) throw new Error("fal.ai birefnet response missing image url");
  return { url: await rehost(data.image.url, "png", "image/png") };
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
