/**
 * Live Amazon review ingestion — the SerpAPI seam.
 *
 * ── Why direct HTTP instead of the connections broker's run() ──
 * The platform's SerpAPI integration executes through the managed broker
 * (Composio), whose SerpAPI toolkit exposes 48 actions (SERPAPI_SEARCH,
 * SERPAPI_EBAY_SEARCH, SERPAPI_WALMART_SEARCH, …) but — verified against the
 * live toolkit docs — NO Amazon engine, and the broker never releases raw
 * credentials (tokens are permanently redacted broker-side), so we can't call
 * SerpAPI's Amazon engines with the org-connected key either. Until the
 * broker grows an Amazon action, the live tier runs on a directly-provided
 * SERPAPI_API_KEY (optional env var, BYOK) against SerpAPI's own HTTP API:
 *   • engine=amazon         — keyword search (param `k`) to resolve an ASIN
 *   • engine=amazon_product — product page incl. reviews_information
 * // shortcut: direct-key only; switch to connect("serpapi").run(...) the day
 * // Composio ships an SERPAPI_AMAZON_* action.
 *
 * ── Grounding ──
 * Imported bodies are verbatim customer snippets from Amazon's review section
 * as returned by SerpAPI — real customer text, stored with source:"serpapi".
 * Zero results / no key degrade to paste + CSV ingestion; nothing is invented.
 */

import { describe, secret, type ConnectionsEnv } from "@clawnify/connections";

export type LiveReviewsEnv = ConnectionsEnv & { SERPAPI_API_KEY?: string };

export interface LiveReview {
  rating: number | null;
  title: string | null;
  body: string;
}

export interface LiveReviewsStatus {
  /** True when the direct SerpAPI key is present — the tier that can actually pull Amazon data. */
  ready: boolean;
  /** True when the org has SerpAPI connected via the platform broker (informational — the broker has no Amazon engine yet). */
  broker_connected: boolean;
}

export async function liveReviewsStatus(env: LiveReviewsEnv): Promise<LiveReviewsStatus> {
  const ready = !!apiKey(env);
  let broker_connected = false;
  try {
    // Gotcha (from open-seo): isConnected() returns false for undescribed
    // services — readiness must go through describe() with an explicit
    // `requires` entry.
    const [entry] = await describe(env, undefined, [{ service: "serpapi", as: "integration" }]);
    broker_connected = !!entry?.connected;
  } catch {
    broker_connected = false;
  }
  return { ready, broker_connected };
}

function apiKey(env: LiveReviewsEnv): string | null {
  return secret("SERPAPI_API_KEY", env) || env.SERPAPI_API_KEY || null;
}

async function serpGet(env: LiveReviewsEnv, params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = apiKey(env);
  if (!key) throw new Error("SERPAPI_API_KEY is not set — live Amazon import needs it (paste and CSV import always work)");
  const qs = new URLSearchParams({ ...params, api_key: key });
  const res = await fetch(`https://serpapi.com/search?${qs}`);
  const raw = await res.text();
  if (!res.ok) throw new Error(`SerpAPI status ${res.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Resolve an ASIN from a product name via SerpAPI's Amazon search engine. */
export async function findAsin(
  env: LiveReviewsEnv,
  input: { query: string; marketplace?: string },
): Promise<{ asin: string; title: string } | null> {
  const data = await serpGet(env, {
    engine: "amazon",
    k: input.query,
    amazon_domain: input.marketplace || "amazon.com",
  });
  const organic = (data.organic_results as Array<Record<string, unknown>>) || [];
  for (const r of organic) {
    if (typeof r.asin === "string" && r.asin) {
      return { asin: r.asin, title: typeof r.title === "string" ? r.title : "" };
    }
  }
  return null;
}

/**
 * Pull the review evidence for an ASIN via SerpAPI's Amazon product engine.
 * Returns the verbatim customer snippets from the product page's Reviews
 * Information section (SerpAPI aggregates full reviews into themed insight
 * groups; the snippets are real customer text).
 */
export async function fetchLiveReviews(
  env: LiveReviewsEnv,
  input: { asin: string; marketplace?: string },
): Promise<LiveReview[]> {
  const data = await serpGet(env, {
    engine: "amazon_product",
    asin: input.asin,
    amazon_domain: input.marketplace || "amazon.com",
  });

  const out: LiveReview[] = [];
  const seen = new Set<string>();
  const push = (body: unknown, title?: unknown, rating?: unknown) => {
    if (typeof body !== "string") return;
    const trimmed = body.trim();
    if (trimmed.length < 8 || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({
      body: trimmed,
      title: typeof title === "string" && title.trim() ? title.trim() : null,
      rating: typeof rating === "number" && rating >= 1 && rating <= 5 ? rating : null,
    });
  };

  const ri = data.reviews_information as Record<string, unknown> | undefined;
  // Themed insight groups → example snippets (verbatim customer text).
  const insights = (ri?.insights as Array<Record<string, unknown>>) || [];
  for (const group of insights) {
    const examples = (group.examples as Array<Record<string, unknown>>) || [];
    for (const ex of examples) push(ex.snippet, group.title);
  }
  // Some responses also carry individual review objects — take them when present.
  for (const listKey of ["authors_reviews", "top_reviews", "reviews"]) {
    const list = (ri?.[listKey] as Array<Record<string, unknown>>) || (data[listKey] as Array<Record<string, unknown>>) || [];
    for (const r of list) push(r.body ?? r.snippet ?? r.text, r.title, r.rating);
  }
  return out;
}
