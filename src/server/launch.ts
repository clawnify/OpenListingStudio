/**
 * The Launch pipeline — the packaged workflow that turns a product + its
 * reviews + its brand kit into a ready listing: insights → compliant listing
 * copy → the image-stack asset rows.
 *
 * Execution model (proven in other Clawnify templates): the pipeline's TEXT
 * stages run inside one follow-up request (POST /api/launches/:id/generate) —
 * two OpenRouter calls, safely inside request limits. IMAGE rendering is NOT
 * done here (ctx.waitUntil is hard-capped at ~30s): generate only creates
 * `pending` asset rows; the client (or agent) fires POST /api/assets/:id/render
 * per asset in parallel, each rendering in its own request. A stale guard
 * flips assets stuck `rendering` >5 min to `failed`.
 */

import { query, get, run } from "./db.js";
import { extractInsights, generateListingCopy, type AiEnv, type LaunchInsights } from "./ai.js";
import type { ListingCopy } from "./amazon-limits.js";
import { TEMPLATES, MAIN_IMAGE_TEMPLATE_ID, DEFAULT_BRAND, PLACEHOLDER_PHOTO, type BrandStyle, type TemplateCtx } from "./templates.js";
import { readUploadAsBase64DataUrl, getUpload } from "./uploads.js";
import { removeBackground, hasAlphaChannel } from "./image.js";

// ── Row types ────────────────────────────────────────────────────────

export interface BrandKitRow {
  id: string;
  name: string;
  colors: string;
  fonts: string;
  tone: string; // JSON array of voice chips (legacy: free text)
  notes: string;
  logo_r2_key: string | null;
  mood_board_r2_keys: string;
  created_at: string;
}

/** Voice chips, accepting both the chips array and the legacy free-text tone. */
export function toneChips(kit: BrandKitRow | null): string[] {
  if (!kit?.tone) return [];
  try {
    const arr = JSON.parse(kit.tone);
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    /* legacy free text */
  }
  return kit.tone
    .split(/[,;·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export interface ProductRow {
  id: string;
  brand_kit_id: string;
  name: string;
  asin: string | null;
  marketplace: string;
  category: string;
  features: string;
  specs: string;
  image_r2_keys: string;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  product_id: string;
  source: string;
  rating: number | null;
  title: string | null;
  body: string;
  created_at: string;
}

export interface LaunchRow {
  id: string;
  product_id: string;
  kind: string;
  status: string;
  insights: string | null;
  listing_copy: string | null;
  steps: string | null;
  config: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Generation config + workflow steps ───────────────────────────────

export interface LaunchConfig {
  image_type: "listing" | "aplus" | "full";
  qty: 1 | 2 | 3; // number of feed images (listing tier)
  format: string; // aspect, e.g. "1:1"
}

export function parseConfig(raw: string | null | undefined): LaunchConfig {
  const c = parse<Partial<LaunchConfig>>(raw ?? "{}", {});
  return {
    image_type: c.image_type === "listing" || c.image_type === "aplus" ? c.image_type : "full",
    qty: c.qty === 1 || c.qty === 2 ? c.qty : 3,
    format: typeof c.format === "string" && c.format ? c.format : "1:1",
  };
}

export type StepStatus = "pending" | "active" | "done" | "failed";
export interface LaunchStep {
  step: string;
  label: string;
  status: StepStatus;
  meta: string[]; // display chips, e.g. "487 reviews", "4.4 rating"
}

export const LAUNCH_STEPS: Array<{ step: string; label: string }> = [
  { step: "reading_product_data", label: "Reading product data" },
  { step: "analyzing_customer_voice", label: "Analyzing customer voice" },
  { step: "ranking_drivers", label: "Ranking conversion drivers/blockers" },
  { step: "content_briefs", label: "Content strategy & listing copy" },
  { step: "generating_assets", label: "Generating assets" },
];

export function initialSteps(): LaunchStep[] {
  return LAUNCH_STEPS.map((s, i) => ({ ...s, status: i === 0 ? "active" : "pending", meta: [] }));
}

/** Persist a step transition so the client's poll animates the timeline. */
async function setStep(launchId: string, steps: LaunchStep[], step: string, status: StepStatus, meta?: string[]): Promise<void> {
  const idx = steps.findIndex((s) => s.step === step);
  if (idx === -1) return;
  steps[idx] = { ...steps[idx], status, meta: meta ?? steps[idx].meta };
  if (status === "done" && idx + 1 < steps.length && steps[idx + 1].status === "pending") {
    steps[idx + 1] = { ...steps[idx + 1], status: "active" };
  }
  await run("UPDATE launches SET steps=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(steps), launchId]);
}

export interface AssetRow {
  id: string;
  launch_id: string | null;
  product_id: string;
  template_id: string;
  size_label: string;
  width: number;
  height: number;
  status: string;
  r2_key: string | null;
  error: string | null;
  qa: string | null; // JSON { status: pass|fail, issues: string[], checked_at }
  created_at: string;
}

// ── JSON field helpers ───────────────────────────────────────────────

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function brandStyle(kit: BrandKitRow | null): BrandStyle {
  if (!kit) return DEFAULT_BRAND;
  const colors = parse<Partial<BrandStyle["colors"]> & { palette?: unknown }>(kit.colors, {});
  const fonts = parse<Partial<BrandStyle["fonts"]>>(kit.fonts, {});
  const palette = Array.isArray(colors.palette)
    ? colors.palette.filter((x): x is string => typeof x === "string" && /^#[0-9a-f]{3,8}$/i.test(x))
    : [];
  return {
    name: kit.name || "",
    colors: { ...DEFAULT_BRAND.colors, primary: colors.primary || DEFAULT_BRAND.colors.primary, secondary: colors.secondary || DEFAULT_BRAND.colors.secondary, accent: colors.accent || DEFAULT_BRAND.colors.accent, background: colors.background || DEFAULT_BRAND.colors.background },
    fonts: { ...DEFAULT_BRAND.fonts, ...fonts },
    palette,
  };
}

export function productFacts(p: ProductRow): { name: string; category: string; features: string[]; specs: Record<string, string> } {
  return {
    name: p.name,
    category: p.category,
    features: parse<string[]>(p.features, []).filter((f) => typeof f === "string" && f.trim()),
    specs: parse<Record<string, string>>(p.specs, {}),
  };
}

// ── Product photos (with roles) ──────────────────────────────────────

export type PhotoRole = "main" | "angle" | "detail";
export interface PhotoRef {
  r2_key: string;
  role: PhotoRole;
  /** Cached transparent cutout (BiRefNet) of this photo, generated lazily. */
  cutout_r2_key?: string;
}

/** Parse image_r2_keys, accepting both the legacy string[] and PhotoRef[] shapes. */
export function parsePhotos(raw: string | null | undefined): PhotoRef[] {
  const arr = parse<unknown[]>(raw ?? "[]", []);
  return arr
    .map((x, i): PhotoRef | null => {
      if (typeof x === "string") return { r2_key: x, role: i === 0 ? "main" : "angle" };
      if (x && typeof x === "object" && typeof (x as PhotoRef).r2_key === "string") {
        const p = x as PhotoRef;
        return {
          r2_key: p.r2_key,
          role: p.role === "angle" || p.role === "detail" ? p.role : "main",
          ...(typeof p.cutout_r2_key === "string" && p.cutout_r2_key ? { cutout_r2_key: p.cutout_r2_key } : {}),
        };
      }
      return null;
    })
    .filter((x): x is PhotoRef => x !== null);
}

/** The photo the image stack + tools edit: the `main`-role photo, else the first. */
export function mainPhoto(p: ProductRow): PhotoRef | null {
  const photos = parsePhotos(p.image_r2_keys);
  return photos.find((x) => x.role === "main") ?? photos[0] ?? null;
}

export async function firstPhotoDataUri(p: ProductRow): Promise<string> {
  const photo = mainPhoto(p);
  if (photo) {
    const uri = await readUploadAsBase64DataUrl(photo.r2_key);
    if (uri) return uri;
  }
  return PLACEHOLDER_PHOTO;
}

/**
 * The photo templates composite: a transparent CUTOUT of the main photo so
 * the product sits clean on any template background (no opaque white box).
 * Generated lazily via BiRefNet on the first templated render when a FAL key
 * is present, cached on the photo entry (cutout_r2_key), and reused after.
 * Graceful fallback to the raw photo when there's no key or the cut fails.
 */
export async function templatePhotoDataUri(
  p: ProductRow,
  env?: { FAL_API_KEY?: string; OPENROUTER_API_KEY: string },
): Promise<string> {
  const photo = mainPhoto(p);
  if (!photo) return PLACEHOLDER_PHOTO;

  if (photo.cutout_r2_key) {
    const cached = await readUploadAsBase64DataUrl(photo.cutout_r2_key);
    if (cached) return cached;
  }

  const persistCutout = async (cutoutKey: string) => {
    const photos = parsePhotos(p.image_r2_keys).map((x) =>
      x.r2_key === photo.r2_key ? { ...x, cutout_r2_key: cutoutKey } : x,
    );
    await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(photos), p.id]);
  };

  // A source that already carries real alpha (a transparent packshot uploaded
  // as the product photo) IS its own cutout — never spend a fal call on it.
  const rawObj = await getUpload(photo.r2_key);
  if (rawObj && hasAlphaChannel(new Uint8Array(rawObj.data))) {
    await persistCutout(photo.r2_key);
    const uri = await readUploadAsBase64DataUrl(photo.r2_key);
    if (uri) return uri;
  }

  if (env?.FAL_API_KEY) {
    try {
      const { url } = await removeBackground(env, { imageUrl: `/api/uploads/${photo.r2_key}` });
      const cutoutKey = url.replace("/api/uploads/", "");
      // Persist the cutout on the photo entry so the next render reuses it.
      await persistCutout(cutoutKey);
      const uri = await readUploadAsBase64DataUrl(cutoutKey);
      if (uri) return uri;
    } catch {
      /* fall through to the raw photo — compositing must never hard-fail on the cut */
    }
  }
  return firstPhotoDataUri(p);
}

export async function buildTemplateCtx(
  launch: LaunchRow,
  env?: { FAL_API_KEY?: string; OPENROUTER_API_KEY: string },
): Promise<TemplateCtx | null> {
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [launch.product_id]);
  if (!product) return null;
  const kit = product.brand_kit_id
    ? await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [product.brand_kit_id])
    : null;
  return {
    product: productFacts(product),
    brand: brandStyle(kit ?? null),
    copy: parse<ListingCopy | null>(launch.listing_copy, null),
    insights: parse<LaunchInsights | null>(launch.insights, null),
    // env present (a real render) → cutout path; absent (preview/QA context) →
    // cached cutout or raw, never a fal call.
    photoDataUri: await templatePhotoDataUri(product, env),
  };
}

// ── The generation pipeline ──────────────────────────────────────────

/**
 * The image stack a launch gets, shaped by its generation config:
 *   listing → main-image concept + `qty` feed images
 *   aplus   → the 3 A+ modules
 *   full    → everything (the default)
 */
export function launchAssetPlan(config: LaunchConfig): Array<{ template_id: string; size_label: string; width: number; height: number }> {
  const feed = TEMPLATES.filter((t) => t.group === "feed").slice(0, config.qty);
  const aplus = TEMPLATES.filter((t) => t.group === "aplus");
  const main = { template_id: MAIN_IMAGE_TEMPLATE_ID, size_label: "Main image concept", width: 1600, height: 1600 };
  const pick =
    config.image_type === "listing" ? [main, ...feed] : config.image_type === "aplus" ? [...aplus] : [main, ...feed, ...aplus];
  return pick.map((t) =>
    "id" in t ? { template_id: t.id, size_label: t.size_label, width: t.width, height: t.height } : t,
  );
}

/**
 * Run the text stages for one launch in-request: insights → copy → asset rows.
 * Flips the launch to `ready` (or `failed` with the error). Idempotent-ish:
 * re-running replaces insights/copy and recreates pending asset rows.
 */
export async function generateLaunch(env: AiEnv, launchId: string): Promise<LaunchRow> {
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [launchId]);
  if (!launch) throw new Error("Launch not found");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [launch.product_id]);
  if (!product) throw new Error("Product not found for launch");
  const kit = product.brand_kit_id
    ? await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [product.brand_kit_id])
    : null;

  const steps = initialSteps();
  await run("UPDATE launches SET status='generating', error=NULL, steps=?, updated_at=datetime('now') WHERE id=?", [
    JSON.stringify(steps),
    launchId,
  ]);

  try {
    // 1. Reading product data
    const facts = productFacts(product);
    const photos = parsePhotos(product.image_r2_keys);
    const reviews = await query<ReviewRow>(
      "SELECT * FROM reviews WHERE product_id=? ORDER BY created_at DESC LIMIT 200",
      [product.id],
    );
    await setStep(launchId, steps, "reading_product_data", "done", [
      `${facts.features.length} features`,
      `${photos.length} image${photos.length === 1 ? "" : "s"}`,
    ]);

    // 2. Analyzing customer voice (+ 3. drivers come out of the same research call)
    const ratings = reviews.map((r) => r.rating).filter((r): r is number => r != null);
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
    const insights = await extractInsights(env, {
      productName: facts.name,
      category: facts.category,
      features: facts.features,
      reviews: reviews.map((r) => ({ title: r.title, body: r.body })),
    });
    await setStep(launchId, steps, "analyzing_customer_voice", "done", [
      `${reviews.length} review${reviews.length === 1 ? "" : "s"}`,
      ...(avg ? [`${avg} rating`] : []),
      ...(insights.source === "ai" ? ["AI-estimated"] : []),
    ]);
    const nDrivers = insights.conversion_drivers.filter((d) => d.kind === "driver").length;
    const nBlockers = insights.conversion_drivers.length - nDrivers;
    await setStep(launchId, steps, "ranking_drivers", "done", [`${nDrivers} drivers`, `${nBlockers} blockers`]);
    await run("UPDATE launches SET insights=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(insights), launchId]);

    // 4. Content strategy & listing copy
    const { copy, enforced } = await generateListingCopy(env, {
      productName: facts.name,
      category: facts.category,
      features: facts.features,
      specs: facts.specs,
      brand: kit ? { name: kit.name, tone: toneChips(kit).join(", "), notes: kit.notes } : null,
      insights,
      kind: launch.kind === "optimize" ? "optimize" : "launch",
    });
    await setStep(launchId, steps, "content_briefs", "done", ["title + 5 bullets", "backend keywords"]);

    // 5. Plan the image stack (renders are client-driven, per-asset requests).
    const config = parseConfig(launch.config);
    await run("DELETE FROM assets WHERE launch_id=?", [launchId]);
    const plan = launchAssetPlan(config);
    for (const a of plan) {
      await run(
        "INSERT INTO assets (id, launch_id, product_id, template_id, size_label, width, height, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
        [crypto.randomUUID(), launchId, product.id, a.template_id, a.size_label, a.width, a.height],
      );
    }
    await setStep(launchId, steps, "generating_assets", "active", [`${plan.length} assets planned`]);

    await run(
      "UPDATE launches SET status='ready', insights=?, listing_copy=?, error=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(insights), JSON.stringify(copy), enforced ? "copy was hard-truncated to Amazon limits after the model exceeded them" : null, launchId],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failing = steps.find((s) => s.status === "active");
    if (failing) await setStep(launchId, steps, failing.step, "failed");
    await run("UPDATE launches SET status='failed', error=?, updated_at=datetime('now') WHERE id=?", [msg.slice(0, 1000), launchId]);
  }

  return (await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [launchId]))!;
}

/**
 * Called after an asset render resolves: when nothing is left pending or
 * rendering for the launch, flip the `generating_assets` step to done.
 */
export async function refreshAssetsStep(launchId: string): Promise<void> {
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [launchId]);
  if (!launch?.steps) return;
  const assets = await query<AssetRow>("SELECT status FROM assets WHERE launch_id=?", [launchId]);
  if (!assets.length || assets.some((a) => a.status === "pending" || a.status === "rendering")) return;
  const steps = parse<LaunchStep[]>(launch.steps, []);
  const idx = steps.findIndex((s) => s.step === "generating_assets");
  if (idx === -1 || steps[idx].status === "done") return;
  const done = assets.filter((a) => a.status === "done").length;
  const failed = assets.length - done;
  steps[idx] = {
    ...steps[idx],
    status: failed && !done ? "failed" : "done",
    meta: [`${done} rendered`, ...(failed ? [`${failed} failed`] : [])],
  };
  await run("UPDATE launches SET steps=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(steps), launchId]);
}

/** Stale guard: assets stuck `rendering` for >5 minutes flip to `failed`. */
export async function reapStaleAssets(): Promise<void> {
  await run(
    "UPDATE assets SET status='failed', error='render timed out' WHERE status='rendering' AND created_at < datetime('now','-5 minutes')",
  );
}

// ── CSV review parsing ───────────────────────────────────────────────

/**
 * Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF).
 * Columns are matched by header name: body/review/text (required),
 * rating/stars, title/headline. A headerless single-column file is treated
 * as one review body per line.
 */
export function parseReviewsCsv(text: string): Array<{ rating: number | null; title: string | null; body: string }> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const bodyIdx = header.findIndex((h) => ["body", "review", "text", "content", "comment"].includes(h));
  if (bodyIdx === -1) {
    // No recognizable header — every non-empty first cell is a review body.
    return rows
      .map((r) => (r[0] || "").trim())
      .filter(Boolean)
      .map((body) => ({ rating: null, title: null, body }));
  }
  const ratingIdx = header.findIndex((h) => ["rating", "stars", "score"].includes(h));
  const titleIdx = header.findIndex((h) => ["title", "headline", "summary"].includes(h));
  return rows
    .slice(1)
    .map((r) => {
      const body = (r[bodyIdx] || "").trim();
      const ratingRaw = ratingIdx >= 0 ? parseFloat(r[ratingIdx] || "") : NaN;
      return {
        body,
        rating: Number.isFinite(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null,
        title: titleIdx >= 0 && (r[titleIdx] || "").trim() ? r[titleIdx].trim() : null,
      };
    })
    .filter((r) => r.body.length > 0);
}
