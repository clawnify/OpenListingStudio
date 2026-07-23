// Typed client for the studio API. Mirrors the server row shapes 1:1.

export type BrandColors = { primary?: string; secondary?: string; accent?: string; background?: string };
export type BrandFonts = { heading?: string; body?: string };

export type BrandKit = {
  id: string;
  name: string;
  colors: string; // JSON { primary, secondary, accent, background, palette?: hex[] }
  fonts: string; // JSON
  tone: string; // JSON array of voice chips (legacy: free text)
  notes: string;
  logo_r2_key: string | null;
  mood_board_r2_keys: string; // JSON array
  created_at: string;
};

/** Voice chips, tolerating the legacy free-text tone. */
export function parseTone(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    /* legacy */
  }
  return raw
    .split(/[,;·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export type Product = {
  id: string;
  brand_kit_id: string;
  name: string;
  asin: string | null;
  marketplace: string;
  category: string;
  features: string; // JSON array
  specs: string; // JSON object
  image_r2_keys: string; // JSON array
  created_at: string;
  review_count?: number;
  launch_count?: number;
};

export type Review = {
  id: string;
  product_id: string;
  source: "paste" | "csv" | "serpapi";
  rating: number | null;
  title: string | null;
  body: string;
  created_at: string;
};

export type Sentiment = "positive" | "negative" | "neutral";
export type Journey = "pre_purchase" | "post_purchase";

export type ReviewInsight = {
  insight: string;
  sentiment: Sentiment;
  journey: Journey;
  review_count: number;
  quotes: string[];
  reliability: number;
};
export type ProductFeature = { feature: string; journey: Journey; source: "reviews" | "listing" | "specs" };
export type ConversionDriver = { driver: string; kind: "driver" | "blocker"; relevance: number; journey: Journey };

export type LaunchInsights = {
  source: "reviews" | "ai";
  review_insights: ReviewInsight[];
  product_features: ProductFeature[];
  conversion_drivers: ConversionDriver[];
};

/** Parse launch.insights tolerating the legacy {pains,desires,…} shape. */
export function parseInsights(raw: string | null | undefined): LaunchInsights | null {
  const d = parseJson<Record<string, unknown> | null>(raw, null);
  if (!d) return null;
  if (Array.isArray(d.review_insights)) return d as unknown as LaunchInsights;
  // Legacy mapping: pains/objections → negative, desires/vocabulary → positive.
  const legacy = (arr: unknown, sentiment: Sentiment): ReviewInsight[] =>
    (Array.isArray(arr) ? arr : []).map((x) => {
      const it = x as { point?: string; quote?: string | null };
      return {
        insight: it.point || "",
        sentiment,
        journey: "post_purchase" as Journey,
        review_count: it.quote ? 1 : 0,
        quotes: it.quote ? [it.quote] : [],
        reliability: 0,
      };
    });
  return {
    source: d.source === "ai" ? "ai" : "reviews",
    review_insights: [
      ...legacy(d.desires, "positive"),
      ...legacy(d.pains, "negative"),
      ...legacy(d.objections, "negative"),
      ...legacy(d.vocabulary, "neutral"),
    ].filter((i) => i.insight),
    product_features: [],
    conversion_drivers: [],
  };
}

export type StepStatus = "pending" | "active" | "done" | "failed";
export type LaunchStep = { step: string; label: string; status: StepStatus; meta: string[] };

export type LaunchConfig = { image_type: "listing" | "aplus" | "full"; qty: 1 | 2 | 3; format: string };

export type ListingCopy = {
  title: string;
  bullets: string[];
  description: string;
  backend_keywords: string;
};

export type Launch = {
  id: string;
  product_id: string;
  kind: "launch" | "optimize";
  status: "draft" | "generating" | "ready" | "failed" | "exported";
  insights: string | null; // JSON — parse with parseInsights()
  listing_copy: string | null; // JSON
  steps: string | null; // JSON LaunchStep[]
  config: string | null; // JSON LaunchConfig
  error: string | null;
  created_at: string;
  updated_at: string;
  assets?: Asset[];
};

export type AssetQa = { status: "pass" | "fail"; issues: string[]; checked_at: string };

export type Asset = {
  id: string;
  launch_id: string | null;
  product_id: string;
  template_id: string;
  size_label: string;
  width: number;
  height: number;
  status: "pending" | "rendering" | "done" | "failed";
  r2_key: string | null;
  error: string | null;
  qa: string | null; // JSON AssetQa
  created_at: string;
};

export type ToolInput = {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export type Tool = {
  id: string;
  label: string;
  category: string;
  icon: string;
  description: string;
  inputs: ToolInput[];
  disclaimer?: string;
  requiresFal?: boolean;
};

export type Health = {
  openrouter: boolean;
  fal: boolean;
  render: boolean;
  reviews_live: { ready: boolean; broker_connected: boolean };
};

export function assetUrl(a: Asset): string | null {
  return a.r2_key ? `/api/uploads/${a.r2_key}` : null;
}

export type PhotoRole = "main" | "angle" | "detail";
export type PhotoRef = { r2_key: string; role: PhotoRole; cutout_r2_key?: string };

/** Parse product.image_r2_keys, accepting both legacy string[] and PhotoRef[]. */
export function parsePhotos(raw: string | null | undefined): PhotoRef[] {
  const arr = parseJson<unknown[]>(raw, []);
  return arr
    .map((x, i): PhotoRef | null => {
      if (typeof x === "string") return { r2_key: x, role: i === 0 ? "main" : "angle" };
      if (x && typeof x === "object" && typeof (x as PhotoRef).r2_key === "string") {
        const p = x as PhotoRef;
        return {
          r2_key: p.r2_key,
          role: p.role === "angle" || p.role === "detail" ? p.role : "main",
          ...(p.cutout_r2_key ? { cutout_r2_key: p.cutout_r2_key } : {}),
        };
      }
      return null;
    })
    .filter((x): x is PhotoRef => x !== null);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; violations?: string[] };
    const msg = body.violations?.length ? `${body.error}: ${body.violations.join("; ")}` : body.error;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

const j = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => fetch("/api/health").then(json<Health>),

  // Brand kits
  listBrandKits: () => fetch("/api/brand-kits").then(json<BrandKit[]>),
  createBrandKit: (b: { name: string; colors: BrandColors & { palette?: string[] }; fonts: BrandFonts; tone?: string[]; notes?: string }) =>
    fetch("/api/brand-kits", j(b)).then(json<BrandKit>),
  updateBrandKit: (
    id: string,
    b: Partial<{ name: string; colors: BrandColors & { palette?: string[] }; fonts: BrandFonts; tone: string[]; notes: string }>,
  ) => fetch(`/api/brand-kits/${id}`, { ...j(b), method: "PUT" }).then(json<BrandKit>),
  deleteBrandKit: (id: string) => fetch(`/api/brand-kits/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  async uploadMoodBoard(kitId: string, file: File): Promise<{ key: string; url: string; mood_board_r2_keys: string[] }> {
    const fd = new FormData();
    fd.append("file", file);
    return json(await fetch(`/api/brand-kits/${kitId}/mood-board`, { method: "POST", body: fd }));
  },
  deleteMoodBoard: (kitId: string, r2_key: string) =>
    fetch(`/api/brand-kits/${kitId}/mood-board`, { ...j({ r2_key }), method: "DELETE" }).then(
      json<{ ok: true; mood_board_r2_keys: string[] }>,
    ),

  // Products
  listProducts: () => fetch("/api/products").then(json<Product[]>),
  getProduct: (id: string) => fetch(`/api/products/${id}`).then(json<Product>),
  createProduct: (b: { name: string; brand_kit_id?: string; asin?: string; category?: string; features?: string[]; marketplace?: string }) =>
    fetch("/api/products", j(b)).then(json<Product>),
  updateProduct: (id: string, b: Partial<{ name: string; brand_kit_id: string; asin: string | null; category: string; features: string[]; marketplace: string }>) =>
    fetch(`/api/products/${id}`, { ...j(b), method: "PUT" }).then(json<Product>),
  deleteProduct: (id: string) => fetch(`/api/products/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  async uploadPhoto(productId: string, file: File, role?: PhotoRole): Promise<{ key: string; url: string; photos: PhotoRef[] }> {
    const fd = new FormData();
    fd.append("file", file);
    if (role) fd.append("role", role);
    return json(await fetch(`/api/products/${productId}/photos`, { method: "POST", body: fd }));
  },
  deletePhoto: (productId: string, r2_key: string) =>
    fetch(`/api/products/${productId}/photos`, { ...j({ r2_key }), method: "DELETE" }).then(json<{ ok: true; photos: PhotoRef[] }>),
  regenerateCutout: (productId: string, r2_key: string) =>
    fetch(`/api/products/${productId}/photos/cutout`, { ...j({ r2_key }), method: "POST" }).then(
      json<{ ok: true; cutout_r2_key: string; photos: PhotoRef[] }>,
    ),
  async uploadCutout(productId: string, r2_key: string, file: File): Promise<{ ok: true; cutout_r2_key: string; photos: PhotoRef[] }> {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("r2_key", r2_key);
    return json(await fetch(`/api/products/${productId}/photos/cutout`, { method: "PUT", body: fd }));
  },
  setPhotoRole: (productId: string, r2_key: string, role: PhotoRole) =>
    fetch(`/api/products/${productId}/photos`, { ...j({ r2_key, role }), method: "PUT" }).then(json<{ ok: true; photos: PhotoRef[] }>),

  // Reviews
  listReviews: (productId: string) => fetch(`/api/products/${productId}/reviews`).then(json<Review[]>),
  pasteReviews: (productId: string, text: string) =>
    fetch(`/api/products/${productId}/reviews/paste`, j({ text })).then(json<{ imported: number }>),
  async uploadReviewsCsv(productId: string, file: File): Promise<{ imported: number }> {
    const fd = new FormData();
    fd.append("file", file);
    return json(await fetch(`/api/products/${productId}/reviews/csv`, { method: "POST", body: fd }));
  },
  importLiveReviews: (productId: string) =>
    fetch(`/api/products/${productId}/reviews/import-live`, { method: "POST" }).then(json<{ imported: number; asin: string }>),
  deleteReview: (id: string) => fetch(`/api/reviews/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),

  // Launches
  createLaunch: (b: { product_id: string; kind?: "launch" | "optimize"; config?: Partial<LaunchConfig> }) =>
    fetch("/api/launches", j(b)).then(json<Launch>),
  generateLaunch: (id: string) => fetch(`/api/launches/${id}/generate`, { method: "POST" }).then(json<Launch>),
  getLaunch: (id: string) => fetch(`/api/launches/${id}`).then(json<Launch>),
  listLaunches: (productId: string) => fetch(`/api/products/${productId}/launches`).then(json<Launch[]>),
  saveCopy: (id: string, copy: ListingCopy) => fetch(`/api/launches/${id}/copy`, { ...j(copy), method: "PUT" }).then(json<Launch>),
  markExported: (id: string) =>
    fetch(`/api/launches/${id}/status`, { ...j({ status: "exported" }), method: "PUT" }).then(json<Launch>),

  // Assets
  renderAsset: (id: string) => fetch(`/api/assets/${id}/render`, { method: "POST" }).then(json<Asset>),
  qaAsset: (id: string) => fetch(`/api/assets/${id}/qa`, { method: "POST" }).then(json<Asset>),
  listProductAssets: (productId: string) => fetch(`/api/products/${productId}/assets`).then(json<Asset[]>),

  // Tools
  listTools: () => fetch("/api/tools").then(json<Tool[]>),
  runTool: (b: { tool_id: string; source_image_url: string; params: Record<string, string>; product_id?: string }) =>
    fetch("/api/render", j(b)).then(json<Asset>),
  async upload(file: File): Promise<{ url: string; key: string }> {
    const fd = new FormData();
    fd.append("file", file);
    return json(await fetch("/api/uploads", { method: "POST", body: fd }));
  },
};
