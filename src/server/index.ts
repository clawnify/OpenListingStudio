import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";
import { initUploads, putUpload, getUpload, deleteUpload, rid } from "./uploads.js";
import { TOOLS, getTool, publicTool } from "./tools.js";
import { routeImage, analyzeImage, hasAlphaChannel } from "./image.js";
import { splitReviews, type AiEnv } from "./ai.js";
import { validateListingCopy, type ListingCopy } from "./amazon-limits.js";
import { getTemplate, MAIN_IMAGE_TEMPLATE_ID } from "./templates.js";
import { renderStatic } from "./render.js";
import { liveReviewsStatus, findAsin, fetchLiveReviews, type LiveReviewsEnv } from "./reviews-live.js";
import {
  generateLaunch,
  reapStaleAssets,
  refreshAssetsStep,
  parseReviewsCsv,
  parseConfig,
  initialSteps,
  buildTemplateCtx,
  firstPhotoDataUri,
  parsePhotos,
  type PhotoRole,
  type BrandKitRow,
  type ProductRow,
  type ReviewRow,
  type LaunchRow,
  type AssetRow,
} from "./launch.js";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  OPENROUTER_API_KEY: string;
  FAL_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  CLAWNIFY_TOKEN?: string;
  SERVICES_URL?: string;
  LISTING_MODEL?: string;
};
type Env = { Bindings: Bindings };

const app = createApp<Env>({
  title: "Open Listing Studio API",
  version: "1.0.0",
  description:
    "AI listing-content studio: brand kits, product library with review ingestion, review-grounded launch workflow (listing copy + image stack + A+ modules), and directed-edit image tools.",
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// createApp bakes the DB init; uploads init is app-specific, keep it.
app.use("*", async (c, next) => {
  initUploads(c.env.UPLOADS);
  await next();
});

// ── Health ───────────────────────────────────────────────────────────

app.get("/api/health", async (c) => {
  const live = await liveReviewsStatus(c.env as LiveReviewsEnv);
  return c.json({
    openrouter: !!c.env.OPENROUTER_API_KEY,
    fal: !!c.env.FAL_API_KEY,
    render: !!c.env.CLAWNIFY_TOKEN,
    reviews_live: live,
  });
});

// ── Brand kits ───────────────────────────────────────────────────────

app.get("/api/brand-kits", async (c) =>
  c.json(await query<BrandKitRow>("SELECT * FROM brand_kits ORDER BY created_at DESC")),
);

/** Voice chips arrive as an array; legacy free text is tolerated and split later. */
function toneField(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v.filter((x) => typeof x === "string" && x.trim()).slice(0, 12));
  if (typeof v === "string") return v;
  return "[]";
}

app.post("/api/brand-kits", async (c) => {
  const b = await c.req.json<Partial<Omit<BrandKitRow, "tone">> & { colors?: unknown; fonts?: unknown; tone?: unknown }>().catch(() => ({}) as Record<string, never>);
  const id = crypto.randomUUID();
  await run("INSERT INTO brand_kits (id, name, colors, fonts, tone, notes) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    (typeof b.name === "string" && b.name.trim()) || "Untitled Brand",
    JSON.stringify(b.colors ?? {}),
    JSON.stringify(b.fonts ?? {}),
    toneField(b.tone),
    typeof b.notes === "string" ? b.notes : "",
  ]);
  return c.json(await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]), 201);
});

app.get("/api/brand-kits/:id", async (c) => {
  const row = await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.put("/api/brand-kits/:id", async (c) => {
  const id = c.req.param("id");
  const cur = await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]);
  if (!cur) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<Omit<BrandKitRow, "tone">> & { colors?: unknown; fonts?: unknown; tone?: unknown }>();
  await run("UPDATE brand_kits SET name=?, colors=?, fonts=?, tone=?, notes=?, logo_r2_key=? WHERE id=?", [
    typeof b.name === "string" && b.name.trim() ? b.name : cur.name,
    b.colors !== undefined ? JSON.stringify(b.colors) : cur.colors,
    b.fonts !== undefined ? JSON.stringify(b.fonts) : cur.fonts,
    b.tone !== undefined ? toneField(b.tone) : cur.tone,
    typeof b.notes === "string" ? b.notes : cur.notes,
    b.logo_r2_key !== undefined ? b.logo_r2_key : cur.logo_r2_key,
    id,
  ]);
  return c.json(await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]));
});

// Mood board: pinned inspiration images on the kit.
app.post("/api/brand-kits/:id/mood-board", async (c) => {
  const id = c.req.param("id");
  const kit = await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]);
  if (!kit) return c.json({ error: "Not found" }, 404);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const key = `${rid("mood")}.${ext}`;
  await putUpload(key, await file.arrayBuffer(), file.type || "image/png");
  const keys = (JSON.parse(kit.mood_board_r2_keys || "[]") as string[]).concat(key);
  await run("UPDATE brand_kits SET mood_board_r2_keys=? WHERE id=?", [JSON.stringify(keys), id]);
  return c.json({ key, url: `/api/uploads/${key}`, mood_board_r2_keys: keys }, 201);
});

app.delete("/api/brand-kits/:id/mood-board", async (c) => {
  const id = c.req.param("id");
  const kit = await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]);
  if (!kit) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ r2_key?: string }>().catch(() => ({}) as { r2_key?: string });
  if (!b.r2_key) return c.json({ error: "r2_key is required" }, 400);
  const keys = (JSON.parse(kit.mood_board_r2_keys || "[]") as string[]).filter((k) => k !== b.r2_key);
  await run("UPDATE brand_kits SET mood_board_r2_keys=? WHERE id=?", [JSON.stringify(keys), id]);
  await deleteUpload(b.r2_key).catch(() => {});
  return c.json({ ok: true, mood_board_r2_keys: keys });
});

app.delete("/api/brand-kits/:id", async (c) => {
  const id = c.req.param("id");
  await run("UPDATE products SET brand_kit_id='' WHERE brand_kit_id=?", [id]);
  await run("DELETE FROM brand_kits WHERE id=?", [id]);
  return c.json({ ok: true });
});

// ── Products ─────────────────────────────────────────────────────────

/** Bounded pagination params (AGENTS.md: no endpoint returns an unbounded collection). */
function pageParams(c: { req: { query: (k: string) => string | undefined } }, defLimit = 25, maxLimit = 100) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(c.req.query("limit") || "", 10) || defLimit));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "", 10) || 0);
  const search = (c.req.query("search") || "").trim();
  return { limit, offset, search };
}

app.get("/api/products", async (c) => {
  const { limit, offset, search } = pageParams(c);
  const where = search ? "WHERE p.name LIKE ? OR p.asin LIKE ?" : "";
  const args = search ? [`%${search}%`, `%${search}%`] : [];
  const rows = await query<ProductRow & { review_count: number; launch_count: number }>(
    `SELECT p.*,
       (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count,
       (SELECT COUNT(*) FROM launches l WHERE l.product_id = p.id) AS launch_count
     FROM products p ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  return c.json(rows);
});

app.post("/api/products", async (c) => {
  const b = await c.req.json<Partial<ProductRow> & { features?: unknown; specs?: unknown }>().catch(() => ({}) as Record<string, never>);
  if (typeof b.name !== "string" || !b.name.trim()) return c.json({ error: "name is required" }, 400);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO products (id, brand_kit_id, name, asin, marketplace, category, features, specs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      typeof b.brand_kit_id === "string" ? b.brand_kit_id : "",
      b.name.trim(),
      typeof b.asin === "string" && b.asin.trim() ? b.asin.trim() : null,
      typeof b.marketplace === "string" && b.marketplace.trim() ? b.marketplace.trim() : "amazon.com",
      typeof b.category === "string" ? b.category : "",
      JSON.stringify(Array.isArray(b.features) ? b.features : []),
      JSON.stringify(b.specs && typeof b.specs === "object" ? b.specs : {}),
    ],
  );
  return c.json(await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]), 201);
});

app.get("/api/products/:id", async (c) => {
  const row = await get<ProductRow>("SELECT * FROM products WHERE id=?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.put("/api/products/:id", async (c) => {
  const id = c.req.param("id");
  const cur = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!cur) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<ProductRow> & { features?: unknown; specs?: unknown; image_r2_keys?: unknown }>();
  await run(
    "UPDATE products SET brand_kit_id=?, name=?, asin=?, marketplace=?, category=?, features=?, specs=?, image_r2_keys=? WHERE id=?",
    [
      typeof b.brand_kit_id === "string" ? b.brand_kit_id : cur.brand_kit_id,
      typeof b.name === "string" && b.name.trim() ? b.name.trim() : cur.name,
      b.asin !== undefined ? (typeof b.asin === "string" && b.asin.trim() ? b.asin.trim() : null) : cur.asin,
      typeof b.marketplace === "string" && b.marketplace.trim() ? b.marketplace.trim() : cur.marketplace,
      typeof b.category === "string" ? b.category : cur.category,
      b.features !== undefined ? JSON.stringify(Array.isArray(b.features) ? b.features : []) : cur.features,
      b.specs !== undefined ? JSON.stringify(b.specs && typeof b.specs === "object" ? b.specs : {}) : cur.specs,
      b.image_r2_keys !== undefined ? JSON.stringify(Array.isArray(b.image_r2_keys) ? b.image_r2_keys : []) : cur.image_r2_keys,
      id,
    ],
  );
  return c.json(await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]));
});

app.delete("/api/products/:id", async (c) => {
  const id = c.req.param("id");
  await run("DELETE FROM assets WHERE product_id=?", [id]);
  await run("DELETE FROM launches WHERE product_id=?", [id]);
  await run("DELETE FROM reviews WHERE product_id=?", [id]);
  await run("DELETE FROM products WHERE id=?", [id]);
  return c.json({ ok: true });
});

// Upload a product photo → appended to the product's image_r2_keys with a
// role (main | angle | detail). The first photo defaults to `main`.
app.post("/api/products/:id/photos", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const roleRaw = form.get("role");
  const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const key = `${rid("up")}.${ext}`;
  const buf = await file.arrayBuffer();
  await putUpload(key, buf, file.type || "image/png");
  const photos = parsePhotos(product.image_r2_keys);
  const role: PhotoRole =
    roleRaw === "main" || roleRaw === "angle" || roleRaw === "detail" ? roleRaw : photos.length === 0 ? "main" : "angle";
  // A transparent packshot is its own cutout — templates composite it as-is.
  const selfCutout = hasAlphaChannel(new Uint8Array(buf));
  photos.push({ r2_key: key, role, ...(selfCutout ? { cutout_r2_key: key } : {}) });
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(photos), id]);
  return c.json({ key, url: `/api/uploads/${key}`, photos }, 201);
});

/**
 * Upload your own transparent cutout for a photo (professional packshots).
 * Multipart: `file` + `r2_key` of the photo it belongs to. The file MUST
 * carry a real alpha channel — a white-matte JPEG can't silently become the
 * "cutout". Replaces (and deletes) any previous generated cutout.
 */
app.put("/api/products/:id/photos/cutout", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const form = await c.req.formData();
  const file = form.get("file");
  const r2_key = form.get("r2_key");
  if (!(file instanceof File) || typeof r2_key !== "string" || !r2_key) {
    return c.json({ error: "file and r2_key are required" }, 400);
  }
  const photos = parsePhotos(product.image_r2_keys);
  const photo = photos.find((p) => p.r2_key === r2_key);
  if (!photo) return c.json({ error: "Photo not found on this product" }, 404);
  const buf = await file.arrayBuffer();
  if (!hasAlphaChannel(new Uint8Array(buf))) {
    return c.json({ error: "That file has no alpha channel — export a transparent PNG (or WebP) and retry" }, 400);
  }
  const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const cutoutKey = `${rid("cut")}.${ext}`;
  await putUpload(cutoutKey, buf, file.type || "image/png");
  if (photo.cutout_r2_key && photo.cutout_r2_key !== photo.r2_key) await deleteUpload(photo.cutout_r2_key).catch(() => {});
  const next = photos.map((p) => (p.r2_key === r2_key ? { ...p, cutout_r2_key: cutoutKey } : p));
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(next), id]);
  return c.json({ ok: true, cutout_r2_key: cutoutKey, photos: next });
});

/** Regenerate a photo's cutout via BiRefNet (replaces + deletes the old one). */
app.post("/api/products/:id/photos/cutout", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  if (!c.env.FAL_API_KEY) return c.json({ error: "Cutout generation needs FAL_API_KEY set in the app environment" }, 503);
  const b = await c.req.json<{ r2_key?: string }>().catch(() => ({}) as { r2_key?: string });
  if (!b.r2_key) return c.json({ error: "r2_key is required" }, 400);
  const photos = parsePhotos(product.image_r2_keys);
  const photo = photos.find((p) => p.r2_key === b.r2_key);
  if (!photo) return c.json({ error: "Photo not found on this product" }, 404);
  const { url } = await routeImage(c.env, { op: "remove_bg", imageUrl: `/api/uploads/${photo.r2_key}`, prompt: "" });
  const cutoutKey = url.replace("/api/uploads/", "");
  if (photo.cutout_r2_key && photo.cutout_r2_key !== photo.r2_key && photo.cutout_r2_key !== cutoutKey) {
    await deleteUpload(photo.cutout_r2_key).catch(() => {});
  }
  const next = photos.map((p) => (p.r2_key === b.r2_key ? { ...p, cutout_r2_key: cutoutKey } : p));
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(next), id]);
  return c.json({ ok: true, cutout_r2_key: cutoutKey, photos: next });
});

// Remove a product photo — drops the entry AND deletes the R2 object.
app.delete("/api/products/:id/photos", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ r2_key?: string }>().catch(() => ({}) as { r2_key?: string });
  if (!b.r2_key) return c.json({ error: "r2_key is required" }, 400);
  const photos = parsePhotos(product.image_r2_keys);
  const remaining = photos.filter((p) => p.r2_key !== b.r2_key);
  if (remaining.length === photos.length) return c.json({ error: "Photo not found on this product" }, 404);
  // Keep an addressable hero: if the main photo was removed, promote the first.
  if (remaining.length && !remaining.some((p) => p.role === "main")) remaining[0].role = "main";
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(remaining), id]);
  await deleteUpload(b.r2_key).catch(() => {});
  const removed = photos.find((p) => p.r2_key === b.r2_key);
  if (removed?.cutout_r2_key) await deleteUpload(removed.cutout_r2_key).catch(() => {});
  return c.json({ ok: true, photos: remaining });
});

// Change a photo's role. Setting `main` demotes the previous main to `angle`.
app.put("/api/products/:id/photos", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ r2_key?: string; role?: string }>();
  if (!b.r2_key || !["main", "angle", "detail"].includes(b.role || "")) {
    return c.json({ error: "r2_key and role (main|angle|detail) are required" }, 400);
  }
  const photos = parsePhotos(product.image_r2_keys);
  if (!photos.some((p) => p.r2_key === b.r2_key)) return c.json({ error: "Photo not found on this product" }, 404);
  for (const p of photos) {
    if (p.r2_key === b.r2_key) p.role = b.role as PhotoRole;
    else if (b.role === "main" && p.role === "main") p.role = "angle";
  }
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(photos), id]);
  return c.json({ ok: true, photos });
});

// ── Reviews ──────────────────────────────────────────────────────────

app.get("/api/products/:id/reviews", async (c) => {
  const { limit, offset } = pageParams(c, 50, 200);
  return c.json(
    await query<ReviewRow>("SELECT * FROM reviews WHERE product_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", [
      c.req.param("id"),
      limit,
      offset,
    ]),
  );
});

async function insertReviews(
  productId: string,
  source: string,
  reviews: Array<{ rating: number | null; title: string | null; body: string }>,
): Promise<number> {
  let n = 0;
  for (const r of reviews) {
    if (!r.body?.trim()) continue;
    await run("INSERT INTO reviews (id, product_id, source, rating, title, body) VALUES (?, ?, ?, ?, ?, ?)", [
      crypto.randomUUID(),
      productId,
      source,
      r.rating,
      r.title,
      r.body.trim(),
    ]);
    n++;
  }
  return n;
}

// Paste ingestion — one review per line, or free text the AI splits verbatim.
app.post("/api/products/:id/reviews/paste", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  if (!b.text?.trim()) return c.json({ error: "text is required" }, 400);
  const reviews = await splitReviews(c.env as AiEnv, b.text);
  if (!reviews.length) return c.json({ error: "No reviews found in the pasted text" }, 400);
  const imported = await insertReviews(id, "paste", reviews);
  return c.json({ imported }, 201);
});

// CSV ingestion — columns matched by header (body/review/text, rating, title).
app.post("/api/products/:id/reviews/csv", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const reviews = parseReviewsCsv(await file.text());
  if (!reviews.length) return c.json({ error: "No reviews found in the CSV (needs a body/review/text column)" }, 400);
  const imported = await insertReviews(id, "csv", reviews);
  return c.json({ imported }, 201);
});

// Live ingestion via SerpAPI's Amazon engines (needs SERPAPI_API_KEY).
app.post("/api/products/:id/reviews/import-live", async (c) => {
  const id = c.req.param("id");
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [id]);
  if (!product) return c.json({ error: "Not found" }, 404);
  const env = c.env as LiveReviewsEnv;
  let asin = product.asin;
  if (!asin) {
    const found = await findAsin(env, { query: product.name, marketplace: product.marketplace });
    if (!found) return c.json({ error: `No Amazon listing found for "${product.name}" — set the product's ASIN and retry` }, 404);
    asin = found.asin;
    await run("UPDATE products SET asin=? WHERE id=?", [asin, id]);
  }
  const reviews = await fetchLiveReviews(env, { asin, marketplace: product.marketplace });
  if (!reviews.length) return c.json({ error: `No review text returned for ASIN ${asin}` }, 404);
  const imported = await insertReviews(id, "serpapi", reviews);
  return c.json({ imported, asin }, 201);
});

app.delete("/api/reviews/:id", async (c) => {
  await run("DELETE FROM reviews WHERE id=?", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ── Launches (the packaged workflow) ─────────────────────────────────

/** Core create: insert the launch in `generating` with its generation config (202 semantics). */
async function createLaunch(productId: string, kind: string, config?: unknown): Promise<LaunchRow | null> {
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [productId]);
  if (!product) return null;
  const id = crypto.randomUUID();
  const cfg = parseConfig(typeof config === "object" && config ? JSON.stringify(config) : null);
  await run("INSERT INTO launches (id, product_id, kind, status, config, steps) VALUES (?, ?, ?, 'generating', ?, ?)", [
    id,
    productId,
    kind === "optimize" ? "optimize" : "launch",
    JSON.stringify(cfg),
    JSON.stringify(initialSteps()),
  ]);
  return (await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [id]))!;
}

app.post("/api/launches", async (c) => {
  const b = await c.req
    .json<{ product_id?: string; kind?: string; config?: unknown }>()
    .catch(() => ({}) as { product_id?: string; kind?: string; config?: unknown });
  if (!b.product_id) return c.json({ error: "product_id is required" }, 400);
  const launch = await createLaunch(b.product_id, b.kind || "launch", b.config);
  if (!launch) return c.json({ error: "Product not found" }, 404);
  return c.json(launch, 202);
});

// The text stages run inside THIS request (2 OpenRouter calls) — the client
// calls it right after create. Image rendering stays per-asset (see below).
app.post("/api/launches/:id/generate", async (c) => {
  const launch = await generateLaunch(c.env as AiEnv, c.req.param("id"));
  return c.json(launch);
});

app.get("/api/launches/:id", async (c) => {
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [c.req.param("id")]);
  if (!launch) return c.json({ error: "Not found" }, 404);
  await reapStaleAssets();
  const assets = await query<AssetRow>("SELECT * FROM assets WHERE launch_id=? ORDER BY created_at", [launch.id]);
  return c.json({ ...launch, assets });
});

app.get("/api/products/:id/launches", async (c) =>
  c.json(await query<LaunchRow>("SELECT * FROM launches WHERE product_id=? ORDER BY created_at DESC", [c.req.param("id")])),
);

// Manual copy edits from the dashboard editor — validated against Amazon limits.
app.put("/api/launches/:id/copy", async (c) => {
  const id = c.req.param("id");
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [id]);
  if (!launch) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<ListingCopy>();
  const copy: ListingCopy = {
    title: (b.title || "").trim(),
    bullets: Array.isArray(b.bullets) ? b.bullets.map((x) => String(x)) : [],
    description: (b.description || "").trim(),
    backend_keywords: (b.backend_keywords || "").trim(),
  };
  const errors = validateListingCopy(copy);
  if (errors.length) return c.json({ error: "Copy violates Amazon limits", violations: errors }, 400);
  await run("UPDATE launches SET listing_copy=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(copy), id]);
  return c.json(await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [id]));
});

app.put("/api/launches/:id/status", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ status?: string }>();
  if (b.status !== "exported") return c.json({ error: "Only 'exported' can be set manually" }, 400);
  await run("UPDATE launches SET status='exported', updated_at=datetime('now') WHERE id=?", [id]);
  return c.json(await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [id]));
});

app.delete("/api/launches/:id", async (c) => {
  const id = c.req.param("id");
  await run("DELETE FROM assets WHERE launch_id=?", [id]);
  await run("DELETE FROM launches WHERE id=?", [id]);
  return c.json({ ok: true });
});

// ── Asset rendering ──────────────────────────────────────────────────

/**
 * Render ONE asset in-request. HTML templates go through the managed
 * screenshot service (CLAWNIFY_TOKEN); the main-image concept is a directed
 * image edit (white-background hero) through the image engine.
 */
async function renderAsset(env: Bindings, asset: AssetRow): Promise<AssetRow> {
  await run("UPDATE assets SET status='rendering', error=NULL WHERE id=?", [asset.id]);
  try {
    let key: string;
    if (asset.template_id === MAIN_IMAGE_TEMPLATE_ID || asset.template_id.startsWith("tool:")) {
      const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [asset.product_id]);
      if (!product) throw new Error("Product not found");
      const photo = await firstPhotoDataUri(product);
      if (photo.startsWith("data:image/svg")) throw new Error("Upload a product photo first — the main image edits your real photo");
      // Angle/detail reference photos ride along so the model sees the product from all sides.
      const refs = parsePhotos(product.image_r2_keys)
        .filter((p) => p.role !== "main")
        .slice(0, 2)
        .map((p) => `/api/uploads/${p.r2_key}`);
      const tool = getTool("white_background")!;
      const { url } = await routeImage(env, { op: "edit", imageUrl: photo, prompt: tool.buildPrompt({}), extraImages: refs });
      key = url.replace("/api/uploads/", "");
    } else {
      if (!env.CLAWNIFY_TOKEN) throw new Error("Rendering needs CLAWNIFY_TOKEN (set automatically when deployed on Clawnify)");
      const tmpl = getTemplate(asset.template_id);
      if (!tmpl) throw new Error(`Unknown template: ${asset.template_id}`);
      if (!asset.launch_id) throw new Error("Template assets belong to a launch");
      const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [asset.launch_id]);
      if (!launch) throw new Error("Launch not found");
      // env in → generates/caches the BiRefNet cutout for clean compositing.
      const ctx = await buildTemplateCtx(launch, env);
      if (!ctx) throw new Error("Product not found for launch");
      const html = tmpl.buildHTML(ctx);
      const bytes = await renderStatic({
        html,
        w: tmpl.width,
        h: tmpl.height,
        filename: `${tmpl.id}_${asset.id.slice(0, 8)}.png`,
        token: env.CLAWNIFY_TOKEN,
        servicesUrl: env.SERVICES_URL,
      });
      key = `${rid("res")}.png`;
      await putUpload(key, bytes, "image/png");
    }
    await run("UPDATE assets SET status='done', r2_key=? WHERE id=?", [key, asset.id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run("UPDATE assets SET status='failed', error=? WHERE id=?", [msg.slice(0, 1000), asset.id]);
  }
  if (asset.launch_id) await refreshAssetsStep(asset.launch_id);
  return (await get<AssetRow>("SELECT * FROM assets WHERE id=?", [asset.id]))!;
}

app.post("/api/assets/:id/render", async (c) => {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id=?", [c.req.param("id")]);
  if (!asset) return c.json({ error: "Not found" }, 404);
  return c.json(await renderAsset(c.env, asset));
});

/**
 * Optional vision QA (open-slides render→view→fix pattern, one pass): a
 * vision model checks the rendered asset against the brand kit + expected
 * slot content and stores a verdict on the row. A `fail` flags the card for
 * re-render / regeneration — it never blocks anything.
 */
app.post("/api/assets/:id/qa", async (c) => {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id=?", [c.req.param("id")]);
  if (!asset) return c.json({ error: "Not found" }, 404);
  if (asset.status !== "done" || !asset.r2_key) return c.json({ error: "Asset has no rendered image to check" }, 400);

  let expected = "";
  if (asset.launch_id) {
    const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [asset.launch_id]);
    const ctx = launch ? await buildTemplateCtx(launch) : null;
    if (ctx) {
      expected = [
        `Product: ${ctx.product.name}`,
        `Brand: ${ctx.brand.name || "(none)"} — colors ${Object.values(ctx.brand.colors).join(", ")}; heading font ${ctx.brand.fonts.heading}`,
        ctx.copy ? `Listing title: ${ctx.copy.title}` : "",
        ctx.copy?.bullets?.length ? `Benefit bullets: ${ctx.copy.bullets.map((b) => b.split(":")[0]).join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const verdictRaw = await analyzeImage(c.env, {
    imageUrls: [`/api/uploads/${asset.r2_key}`],
    prompt: `You are a strict e-commerce creative QA reviewer. Check this generated listing image (template: ${asset.template_id}, ${asset.width}×${asset.height}).

Expected context:
${expected || "(none — judge general quality only)"}

Check: (1) all text is legible, correctly spelled, not cut off; (2) the product looks natural, not warped or duplicated; (3) colors/fonts plausibly match the brand system; (4) no invented claims, watermarks, or artifacts; (5) composition works at thumbnail size.

Respond with ONLY a JSON object, no prose, no code fences: { "pass": boolean, "issues": string[] } — issues empty when passing, each issue one short sentence.`,
  });
  let verdict: { pass: boolean; issues: string[] };
  try {
    const cleaned = verdictRaw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const p = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as { pass?: unknown; issues?: unknown };
    verdict = {
      pass: p.pass === true,
      issues: Array.isArray(p.issues) ? p.issues.filter((x): x is string => typeof x === "string").slice(0, 6) : [],
    };
  } catch {
    return c.json({ error: "QA model returned an unparseable verdict" }, 502);
  }
  const qa = { status: verdict.pass ? "pass" : "fail", issues: verdict.issues, checked_at: new Date().toISOString() };
  await run("UPDATE assets SET qa=? WHERE id=?", [JSON.stringify(qa), asset.id]);
  return c.json(await get<AssetRow>("SELECT * FROM assets WHERE id=?", [asset.id]));
});

// Preview a template asset's compiled HTML (iframe srcdoc === what renders).
app.get("/api/assets/:id/preview", async (c) => {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id=?", [c.req.param("id")]);
  if (!asset || !asset.launch_id) return c.text("Not found", 404);
  const tmpl = getTemplate(asset.template_id);
  if (!tmpl) return c.text("This asset is an image edit — no HTML preview", 400);
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [asset.launch_id]);
  if (!launch) return c.text("Not found", 404);
  const ctx = await buildTemplateCtx(launch);
  if (!ctx) return c.text("Not found", 404);
  return c.html(tmpl.buildHTML(ctx));
});

// ── Directed-edit tools ──────────────────────────────────────────────

app.get("/api/tools", (c) => c.json(TOOLS.map(publicTool)));

/**
 * Run one directed-edit tool against a product photo, persist the result as
 * an asset row (launch_id NULL — Tools workspace output), return the row.
 * Shared by the UI route and the agent route: a single execution path.
 */
async function runTool(
  env: Bindings,
  input: { tool_id: string; source_image_url: string; params: Record<string, string>; product_id: string },
): Promise<AssetRow> {
  const tool = getTool(input.tool_id);
  if (!tool) throw new Error(`Unknown tool: ${input.tool_id}. Call GET /api/tools for the list.`);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO assets (id, launch_id, product_id, template_id, size_label, status) VALUES (?, NULL, ?, ?, 'Directed edit', 'rendering')",
    [id, input.product_id || "", `tool:${tool.id}`],
  );
  try {
    const prompt = tool.buildPrompt(input.params || {});
    const { url } = await routeImage(env, {
      op: tool.id === "upscale" ? "upscale" : tool.id === "remove_background" ? "remove_bg" : "edit",
      imageUrl: input.source_image_url,
      prompt,
    });
    await run("UPDATE assets SET status='done', r2_key=? WHERE id=?", [url.replace("/api/uploads/", ""), id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run("UPDATE assets SET status='failed', error=? WHERE id=?", [msg.slice(0, 1000), id]);
  }
  return (await get<AssetRow>("SELECT * FROM assets WHERE id=?", [id]))!;
}

app.post("/api/render", async (c) => {
  const b = await c.req.json<{ tool_id?: string; source_image_url?: string; params?: Record<string, string>; product_id?: string }>();
  if (!b.tool_id || !b.source_image_url) return c.json({ error: "tool_id and source_image_url are required" }, 400);
  const row = await runTool(c.env, {
    tool_id: b.tool_id,
    source_image_url: b.source_image_url,
    params: b.params || {},
    product_id: b.product_id || "",
  });
  return c.json(row);
});

app.get("/api/products/:id/assets", async (c) => {
  await reapStaleAssets();
  return c.json(
    await query<AssetRow>("SELECT * FROM assets WHERE product_id=? ORDER BY created_at DESC LIMIT 200", [c.req.param("id")]),
  );
});

app.delete("/api/assets/:id", async (c) => {
  await run("DELETE FROM assets WHERE id=?", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ── Uploads ──────────────────────────────────────────────────────────

app.post("/api/uploads", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const key = `${rid("up")}.${ext}`;
  const url = await putUpload(key, await file.arrayBuffer(), file.type || "image/png");
  return c.json({ url, key });
});

app.get("/api/uploads/:filename", async (c) => {
  const result = await getUpload(c.req.param("filename"));
  if (!result) return c.json({ error: "Not found" }, 404);
  return new Response(result.data, {
    headers: { "Content-Type": result.contentType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
});

// ── Agent-facing public API (in the OpenAPI spec) ────────────────────

const ToolInputSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "select"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
});
const ToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  icon: z.string(),
  description: z.string(),
  inputs: z.array(ToolInputSchema),
  disclaimer: z.string().optional(),
});

const listToolsRoute = createRoute({
  method: "get",
  path: "/api/v1/tools",
  summary: "List the directed-edit image tools an agent can run on a product photo.",
  responses: { 200: { content: { "application/json": { schema: z.array(ToolSchema) } }, description: "OK" } },
});
app.openapi(listToolsRoute, (c) => c.json(TOOLS.map(publicTool), 200));

const AssetSchema = z.object({
  id: z.string(),
  launch_id: z.string().nullable(),
  product_id: z.string(),
  template_id: z.string(),
  size_label: z.string(),
  width: z.number(),
  height: z.number(),
  status: z.string(),
  r2_key: z.string().nullable(),
  error: z.string().nullable(),
  qa: z.any().nullable(),
});

function publicAsset(a: AssetRow) {
  return {
    id: a.id,
    launch_id: a.launch_id,
    product_id: a.product_id,
    template_id: a.template_id,
    size_label: a.size_label,
    width: a.width,
    height: a.height,
    status: a.status,
    r2_key: a.r2_key ? `/api/uploads/${a.r2_key}` : null,
    error: a.error,
    qa: a.qa ? JSON.parse(a.qa) : null,
  };
}

const renderToolRoute = createRoute({
  method: "post",
  path: "/api/v1/render",
  summary:
    "Run a directed edit (white background, lifestyle scene, background swap, infographic overlay, upscale) on a product photo. Returns the finished asset (r2_key is the image URL).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tool_id: z.string().openapi({ example: "white_background" }),
            source_image_url: z.string().openapi({ description: "An /api/uploads/* URL or a public image URL." }),
            params: z.record(z.string()).optional().openapi({ example: { scene: "Kitchen counter" } }),
            product_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: AssetSchema } }, description: "Finished asset" },
    400: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Bad request" },
  },
});
app.openapi(renderToolRoute, async (c) => {
  const body = c.req.valid("json");
  if (!getTool(body.tool_id)) return c.json({ error: `Unknown tool: ${body.tool_id}` }, 400);
  const row = await runTool(c.env, {
    tool_id: body.tool_id,
    source_image_url: body.source_image_url,
    params: body.params || {},
    product_id: body.product_id || "",
  });
  return c.json(publicAsset(row), 200);
});

const LaunchSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  kind: z.string(),
  status: z.string(),
  insights: z.any().nullable(),
  listing_copy: z.any().nullable(),
  steps: z.any().nullable(),
  config: z.any().nullable(),
  error: z.string().nullable(),
  assets: z.array(AssetSchema),
});

function publicLaunch(l: LaunchRow, assets: AssetRow[]) {
  return {
    id: l.id,
    product_id: l.product_id,
    kind: l.kind,
    status: l.status,
    insights: l.insights ? JSON.parse(l.insights) : null,
    listing_copy: l.listing_copy ? JSON.parse(l.listing_copy) : null,
    steps: l.steps ? JSON.parse(l.steps) : null,
    config: l.config ? JSON.parse(l.config) : null,
    error: l.error,
    assets: assets.map(publicAsset),
  };
}

const createLaunchRoute = createRoute({
  method: "post",
  path: "/api/v1/launches",
  summary:
    "Run the Launch workflow for a product: extract review-grounded insights, generate Amazon-compliant listing copy, and plan the image stack. Runs synchronously; render each returned pending asset via POST /api/assets/{id}/render.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            product_id: z.string(),
            kind: z.enum(["launch", "optimize"]).optional().openapi({ example: "launch" }),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: LaunchSchema } }, description: "The generated launch" },
    404: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Product not found" },
  },
});
app.openapi(createLaunchRoute, async (c) => {
  const body = c.req.valid("json");
  const created = await createLaunch(body.product_id, body.kind || "launch");
  if (!created) return c.json({ error: "Product not found" }, 404);
  const launch = await generateLaunch(c.env as AiEnv, created.id);
  const assets = await query<AssetRow>("SELECT * FROM assets WHERE launch_id=? ORDER BY created_at", [launch.id]);
  return c.json(publicLaunch(launch, assets), 200);
});

const getLaunchRoute = createRoute({
  method: "get",
  path: "/api/v1/launches/{id}",
  summary: "Get a launch: status, review-grounded insights (with verbatim quotes), listing copy, and the image-stack assets.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: LaunchSchema } }, description: "Launch state" },
    404: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Not found" },
  },
});
app.openapi(getLaunchRoute, async (c) => {
  const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [c.req.valid("param").id]);
  if (!launch) return c.json({ error: "Not found" }, 404);
  await reapStaleAssets();
  const assets = await query<AssetRow>("SELECT * FROM assets WHERE launch_id=? ORDER BY created_at", [launch.id]);
  return c.json(publicLaunch(launch, assets), 200);
});

const ProductSchema = z.object({
  id: z.string(),
  brand_kit_id: z.string(),
  name: z.string(),
  asin: z.string().nullable(),
  marketplace: z.string(),
  category: z.string(),
  features: z.array(z.string()),
  review_count: z.number(),
});

const listProductsRoute = createRoute({
  method: "get",
  path: "/api/v1/products",
  summary:
    "List the product library (bounded page, with review counts) — pick a product_id for /api/v1/launches or /api/v1/render. Use ?search= to narrow instead of paging through everything.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ description: "Page size, default 25, max 100." }),
      offset: z.string().optional(),
      search: z.string().optional().openapi({ description: "Filter by product name or ASIN." }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(ProductSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "OK",
    },
  },
});
app.openapi(listProductsRoute, async (c) => {
  const { limit, offset, search } = pageParams(c);
  const where = search ? "WHERE p.name LIKE ? OR p.asin LIKE ?" : "";
  const args = search ? [`%${search}%`, `%${search}%`] : [];
  const totalRow = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM products p ${where}`, args);
  const rows = await query<ProductRow & { review_count: number }>(
    `SELECT p.*, (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count
     FROM products p ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  return c.json(
    {
      items: rows.map((p) => ({
        id: p.id,
        brand_kit_id: p.brand_kit_id,
        name: p.name,
        asin: p.asin,
        marketplace: p.marketplace,
        category: p.category,
        features: JSON.parse(p.features || "[]") as string[],
        review_count: p.review_count,
      })),
      total: totalRow?.n ?? rows.length,
      limit,
      offset,
    },
    200,
  );
});

export default app;
