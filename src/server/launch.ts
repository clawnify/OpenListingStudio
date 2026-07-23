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
import { readUploadAsBase64DataUrl } from "./uploads.js";

// ── Row types ────────────────────────────────────────────────────────

export interface BrandKitRow {
  id: string;
  name: string;
  colors: string;
  fonts: string;
  tone: string;
  notes: string;
  logo_r2_key: string | null;
  created_at: string;
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
  error: string | null;
  created_at: string;
  updated_at: string;
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
  const colors = parse<Partial<BrandStyle["colors"]>>(kit.colors, {});
  const fonts = parse<Partial<BrandStyle["fonts"]>>(kit.fonts, {});
  return {
    name: kit.name || "",
    colors: { ...DEFAULT_BRAND.colors, ...colors },
    fonts: { ...DEFAULT_BRAND.fonts, ...fonts },
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

export async function firstPhotoDataUri(p: ProductRow): Promise<string> {
  const keys = parse<string[]>(p.image_r2_keys, []);
  if (keys.length) {
    const uri = await readUploadAsBase64DataUrl(keys[0]);
    if (uri) return uri;
  }
  return PLACEHOLDER_PHOTO;
}

export async function buildTemplateCtx(launch: LaunchRow): Promise<TemplateCtx | null> {
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
    photoDataUri: await firstPhotoDataUri(product),
  };
}

// ── The generation pipeline ──────────────────────────────────────────

/** The image stack every launch gets: main-image concept + 3 feed + 3 A+ modules. */
export function launchAssetPlan(): Array<{ template_id: string; size_label: string; width: number; height: number }> {
  return [
    { template_id: MAIN_IMAGE_TEMPLATE_ID, size_label: "Main image concept", width: 1600, height: 1600 },
    ...TEMPLATES.map((t) => ({ template_id: t.id, size_label: t.size_label, width: t.width, height: t.height })),
  ];
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

  await run("UPDATE launches SET status='generating', error=NULL, updated_at=datetime('now') WHERE id=?", [launchId]);

  try {
    const facts = productFacts(product);
    const reviews = await query<ReviewRow>(
      "SELECT * FROM reviews WHERE product_id=? ORDER BY created_at DESC LIMIT 200",
      [product.id],
    );

    const insights = await extractInsights(env, {
      productName: facts.name,
      category: facts.category,
      features: facts.features,
      reviews: reviews.map((r) => ({ title: r.title, body: r.body })),
    });

    const { copy, enforced } = await generateListingCopy(env, {
      productName: facts.name,
      category: facts.category,
      features: facts.features,
      specs: facts.specs,
      brand: kit ? { name: kit.name, tone: kit.tone, notes: kit.notes } : null,
      insights,
      kind: launch.kind === "optimize" ? "optimize" : "launch",
    });

    // Replace any prior asset stack for this launch, then plan the new one.
    await run("DELETE FROM assets WHERE launch_id=?", [launchId]);
    for (const a of launchAssetPlan()) {
      await run(
        "INSERT INTO assets (id, launch_id, product_id, template_id, size_label, width, height, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
        [crypto.randomUUID(), launchId, product.id, a.template_id, a.size_label, a.width, a.height],
      );
    }

    await run(
      "UPDATE launches SET status='ready', insights=?, listing_copy=?, error=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(insights), JSON.stringify(copy), enforced ? "copy was hard-truncated to Amazon limits after the model exceeded them" : null, launchId],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run("UPDATE launches SET status='failed', error=?, updated_at=datetime('now') WHERE id=?", [msg.slice(0, 1000), launchId]);
  }

  return (await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [launchId]))!;
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
