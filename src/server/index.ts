import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";
import { initUploads, putUpload, getUpload, deleteUpload, rid } from "./uploads.js";
import { TOOLS, getTool, publicTool } from "./tools.js";
import { editImage, upscaleImage } from "./image.js";
import { splitReviews, type AiEnv } from "./ai.js";
import { validateListingCopy, type ListingCopy } from "./amazon-limits.js";
import { getTemplate, MAIN_IMAGE_TEMPLATE_ID } from "./templates.js";
import { renderStatic } from "./render.js";
import { liveReviewsStatus, findAsin, fetchLiveReviews, type LiveReviewsEnv } from "./reviews-live.js";
import {
  generateLaunch,
  reapStaleAssets,
  parseReviewsCsv,
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

app.post("/api/brand-kits", async (c) => {
  const b = await c.req.json<Partial<BrandKitRow> & { colors?: unknown; fonts?: unknown }>().catch(() => ({}) as Record<string, never>);
  const id = crypto.randomUUID();
  await run("INSERT INTO brand_kits (id, name, colors, fonts, tone, notes) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    (typeof b.name === "string" && b.name.trim()) || "Untitled Brand",
    JSON.stringify(b.colors ?? {}),
    JSON.stringify(b.fonts ?? {}),
    typeof b.tone === "string" ? b.tone : "",
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
  const b = await c.req.json<Partial<BrandKitRow> & { colors?: unknown; fonts?: unknown }>();
  await run("UPDATE brand_kits SET name=?, colors=?, fonts=?, tone=?, notes=?, logo_r2_key=? WHERE id=?", [
    typeof b.name === "string" && b.name.trim() ? b.name : cur.name,
    b.colors !== undefined ? JSON.stringify(b.colors) : cur.colors,
    b.fonts !== undefined ? JSON.stringify(b.fonts) : cur.fonts,
    typeof b.tone === "string" ? b.tone : cur.tone,
    typeof b.notes === "string" ? b.notes : cur.notes,
    b.logo_r2_key !== undefined ? b.logo_r2_key : cur.logo_r2_key,
    id,
  ]);
  return c.json(await get<BrandKitRow>("SELECT * FROM brand_kits WHERE id=?", [id]));
});

app.delete("/api/brand-kits/:id", async (c) => {
  const id = c.req.param("id");
  await run("UPDATE products SET brand_kit_id='' WHERE brand_kit_id=?", [id]);
  await run("DELETE FROM brand_kits WHERE id=?", [id]);
  return c.json({ ok: true });
});

// ── Products ─────────────────────────────────────────────────────────

app.get("/api/products", async (c) => {
  const rows = await query<ProductRow & { review_count: number; launch_count: number }>(
    `SELECT p.*,
       (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count,
       (SELECT COUNT(*) FROM launches l WHERE l.product_id = p.id) AS launch_count
     FROM products p ORDER BY p.created_at DESC`,
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
  await putUpload(key, await file.arrayBuffer(), file.type || "image/png");
  const photos = parsePhotos(product.image_r2_keys);
  const role: PhotoRole =
    roleRaw === "main" || roleRaw === "angle" || roleRaw === "detail" ? roleRaw : photos.length === 0 ? "main" : "angle";
  photos.push({ r2_key: key, role });
  await run("UPDATE products SET image_r2_keys=? WHERE id=?", [JSON.stringify(photos), id]);
  return c.json({ key, url: `/api/uploads/${key}`, photos }, 201);
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

app.get("/api/products/:id/reviews", async (c) =>
  c.json(await query<ReviewRow>("SELECT * FROM reviews WHERE product_id=? ORDER BY created_at DESC", [c.req.param("id")])),
);

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

/** Core create: insert the launch in `generating` and return it (202 semantics). */
async function createLaunch(productId: string, kind: string): Promise<LaunchRow | null> {
  const product = await get<ProductRow>("SELECT * FROM products WHERE id=?", [productId]);
  if (!product) return null;
  const id = crypto.randomUUID();
  await run("INSERT INTO launches (id, product_id, kind, status) VALUES (?, ?, ?, 'generating')", [
    id,
    productId,
    kind === "optimize" ? "optimize" : "launch",
  ]);
  return (await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [id]))!;
}

app.post("/api/launches", async (c) => {
  const b = await c.req.json<{ product_id?: string; kind?: string }>().catch(() => ({}) as { product_id?: string; kind?: string });
  if (!b.product_id) return c.json({ error: "product_id is required" }, 400);
  const launch = await createLaunch(b.product_id, b.kind || "launch");
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
      const tool = getTool("white_background")!;
      const { url } = await editImage(env, { imageUrl: photo, prompt: tool.buildPrompt({}) });
      key = url.replace("/api/uploads/", "");
    } else {
      if (!env.CLAWNIFY_TOKEN) throw new Error("Rendering needs CLAWNIFY_TOKEN (set automatically when deployed on Clawnify)");
      const tmpl = getTemplate(asset.template_id);
      if (!tmpl) throw new Error(`Unknown template: ${asset.template_id}`);
      if (!asset.launch_id) throw new Error("Template assets belong to a launch");
      const launch = await get<LaunchRow>("SELECT * FROM launches WHERE id=?", [asset.launch_id]);
      if (!launch) throw new Error("Launch not found");
      const ctx = await buildTemplateCtx(launch);
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
  return (await get<AssetRow>("SELECT * FROM assets WHERE id=?", [asset.id]))!;
}

app.post("/api/assets/:id/render", async (c) => {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id=?", [c.req.param("id")]);
  if (!asset) return c.json({ error: "Not found" }, 404);
  return c.json(await renderAsset(c.env, asset));
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
    const { url } =
      tool.id === "upscale" && env.FAL_API_KEY
        ? await upscaleImage(env, { imageUrl: input.source_image_url })
        : await editImage(env, { imageUrl: input.source_image_url, prompt });
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
  summary: "List the product library (with review counts) — pick a product_id for /api/v1/launches or /api/v1/render.",
  responses: { 200: { content: { "application/json": { schema: z.array(ProductSchema) } }, description: "OK" } },
});
app.openapi(listProductsRoute, async (c) => {
  const rows = await query<ProductRow & { review_count: number }>(
    `SELECT p.*, (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count
     FROM products p ORDER BY p.created_at DESC`,
  );
  return c.json(
    rows.map((p) => ({
      id: p.id,
      brand_kit_id: p.brand_kit_id,
      name: p.name,
      asin: p.asin,
      marketplace: p.marketplace,
      category: p.category,
      features: JSON.parse(p.features || "[]") as string[],
      review_count: p.review_count,
    })),
    200,
  );
});

export default app;
