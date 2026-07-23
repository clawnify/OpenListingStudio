// Typed client for the studio API. Mirrors the server row shapes 1:1.

export type BrandColors = { primary?: string; secondary?: string; accent?: string; background?: string };
export type BrandFonts = { heading?: string; body?: string };

export type BrandKit = {
  id: string;
  name: string;
  colors: string; // JSON
  fonts: string; // JSON
  tone: string;
  notes: string;
  logo_r2_key: string | null;
  created_at: string;
};

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

export type Insight = { point: string; quote: string | null };
export type LaunchInsights = {
  source: "reviews" | "ai";
  pains: Insight[];
  desires: Insight[];
  objections: Insight[];
  vocabulary: Insight[];
};

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
  insights: string | null; // JSON
  listing_copy: string | null; // JSON
  error: string | null;
  created_at: string;
  updated_at: string;
  assets?: Asset[];
};

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
  createBrandKit: (b: { name: string; colors: BrandColors; fonts: BrandFonts; tone?: string; notes?: string }) =>
    fetch("/api/brand-kits", j(b)).then(json<BrandKit>),
  updateBrandKit: (id: string, b: Partial<{ name: string; colors: BrandColors; fonts: BrandFonts; tone: string; notes: string }>) =>
    fetch(`/api/brand-kits/${id}`, { ...j(b), method: "PUT" }).then(json<BrandKit>),
  deleteBrandKit: (id: string) => fetch(`/api/brand-kits/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),

  // Products
  listProducts: () => fetch("/api/products").then(json<Product[]>),
  getProduct: (id: string) => fetch(`/api/products/${id}`).then(json<Product>),
  createProduct: (b: { name: string; brand_kit_id?: string; asin?: string; category?: string; features?: string[]; marketplace?: string }) =>
    fetch("/api/products", j(b)).then(json<Product>),
  updateProduct: (id: string, b: Partial<{ name: string; brand_kit_id: string; asin: string | null; category: string; features: string[]; marketplace: string }>) =>
    fetch(`/api/products/${id}`, { ...j(b), method: "PUT" }).then(json<Product>),
  deleteProduct: (id: string) => fetch(`/api/products/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  async uploadPhoto(productId: string, file: File): Promise<{ key: string; url: string }> {
    const fd = new FormData();
    fd.append("file", file);
    return json(await fetch(`/api/products/${productId}/photos`, { method: "POST", body: fd }));
  },

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
  createLaunch: (b: { product_id: string; kind?: "launch" | "optimize" }) => fetch("/api/launches", j(b)).then(json<Launch>),
  generateLaunch: (id: string) => fetch(`/api/launches/${id}/generate`, { method: "POST" }).then(json<Launch>),
  getLaunch: (id: string) => fetch(`/api/launches/${id}`).then(json<Launch>),
  listLaunches: (productId: string) => fetch(`/api/products/${productId}/launches`).then(json<Launch[]>),
  saveCopy: (id: string, copy: ListingCopy) => fetch(`/api/launches/${id}/copy`, { ...j(copy), method: "PUT" }).then(json<Launch>),
  markExported: (id: string) =>
    fetch(`/api/launches/${id}/status`, { ...j({ status: "exported" }), method: "PUT" }).then(json<Launch>),

  // Assets
  renderAsset: (id: string) => fetch(`/api/assets/${id}/render`, { method: "POST" }).then(json<Asset>),
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
