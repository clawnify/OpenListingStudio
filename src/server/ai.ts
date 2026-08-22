/**
 * AI text engine — the one place that calls OpenRouter for text generation.
 * Uses the org's injected OPENROUTER_API_KEY (the platform standard); the
 * model is overridable via LISTING_MODEL.
 *
 * Grounding rules:
 *   • Insight quotes must be VERBATIM substrings of the stored review text —
 *     verified server-side after generation; non-verbatim quotes are dropped.
 *   • When a product has no reviews, insights are generated from the product
 *     facts alone and labelled source:"ai" — never presented as customer voice.
 */

import { LIMITS, type ListingCopy, validateListingCopy, enforceListingCopy } from "./amazon-limits.js";

export const DEFAULT_TEXT_MODEL = "anthropic/claude-sonnet-4";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type AiEnv = {
  OPENROUTER_API_KEY: string;
  LISTING_MODEL?: string;
};

async function complete(env: AiEnv, system: string, user: string): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenListingStudio",
    },
    body: JSON.stringify({
      model: env.LISTING_MODEL || DEFAULT_TEXT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter status ${res.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");
  return content;
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model returned no JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}

// ── Review paste-splitting ───────────────────────────────────────────

export interface SplitReview {
  rating: number | null;
  title: string | null;
  body: string;
}

const SPLIT_SYSTEM = `You split a raw paste of Amazon customer reviews into individual reviews.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
- Shape: { "reviews": [{ "rating": number|null, "title": string|null, "body": string }] }
- "body" must be the review text COPIED VERBATIM from the input — never paraphrase, summarize, translate, or fix typos.
- "rating" only when explicitly present (e.g. "5 stars", "★★★☆☆"); otherwise null.
- "title" only when the review clearly has a headline line; otherwise null. The title must not be duplicated inside body.
- Ignore non-review noise (dates, "Verified Purchase", helpful-vote counts).`;

/**
 * Split free-text pasted reviews. Cheap path first: if every non-empty line
 * looks like an independent review (one per line), skip the model entirely.
 */
export async function splitReviews(env: AiEnv, raw: string): Promise<SplitReview[]> {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const looksOnePerLine = lines.length > 1 && lines.every((l) => l.length >= 12 && l.length <= 600);
  if (looksOnePerLine) {
    return lines.map((body) => ({ rating: null, title: null, body }));
  }
  const content = await complete(env, SPLIT_SYSTEM, raw.slice(0, 30000));
  const parsed = parseJson(content) as { reviews?: SplitReview[] };
  const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  return reviews
    .filter((r) => typeof r?.body === "string" && r.body.trim().length > 0)
    .map((r) => ({
      rating: typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5 ? r.rating : null,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : null,
      body: r.body.trim(),
    }));
}

// ── Review insight extraction (structured) ───────────────────────────

export type Sentiment = "positive" | "negative" | "neutral";
export type Journey = "pre_purchase" | "post_purchase";

export interface ReviewInsight {
  insight: string;
  sentiment: Sentiment;
  journey: Journey;
  /** How many stored reviews contain at least one verified quote — computed server-side. */
  review_count: number;
  /** Verbatim excerpts from stored reviews, verified server-side. */
  quotes: string[];
  /** Model's confidence the insight holds across the corpus, 0-100. */
  reliability: number;
}

export interface ProductFeature {
  feature: string;
  journey: Journey;
  source: "reviews" | "listing" | "specs";
}

export interface ConversionDriver {
  driver: string;
  kind: "driver" | "blocker";
  /** 1 = most relevant. */
  relevance: number;
  journey: Journey;
}

export interface LaunchInsights {
  source: "reviews" | "ai"; // "reviews" = grounded in real customer text
  review_insights: ReviewInsight[];
  product_features: ProductFeature[];
  conversion_drivers: ConversionDriver[];
}

const INSIGHTS_SHAPE = `Shape:
{
  "review_insights": [{ "insight": string, "sentiment": "positive"|"negative"|"neutral", "journey": "pre_purchase"|"post_purchase", "quotes": [string], "reliability": number }],
  "product_features": [{ "feature": string, "journey": "pre_purchase"|"post_purchase", "source": "reviews"|"listing"|"specs" }],
  "conversion_drivers": [{ "driver": string, "kind": "driver"|"blocker", "relevance": number, "journey": "pre_purchase"|"post_purchase" }]
}
- "insight"/"driver"/"feature": one concise sentence (<= 90 chars).
- "journey": pre_purchase = influences the buying decision; post_purchase = shows up after owning it.
- "reliability": 0-100, your confidence the insight holds across the whole review set.
- "relevance": rank starting at 1 = most decisive for conversion.
- 3-6 review_insights, 4-8 product_features, 3-6 conversion_drivers (mix drivers and blockers).`;

const INSIGHTS_SYSTEM = `You are a conversion researcher analyzing Amazon customer reviews for a product. Extract structured insight tables a listing team acts on.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
${INSIGHTS_SHAPE}
- "quotes": 1-4 SHORT supporting excerpts (<= 160 chars each) COPIED CHARACTER-FOR-CHARACTER from the reviews — same casing, punctuation, and typos. Never paraphrase, never merge two reviews, never invent. An insight with no verbatim quote must be omitted entirely.
- product_features with source "reviews" must be things customers actually describe; "listing"/"specs" come from the stated facts.`;

const INSIGHTS_AI_SYSTEM = `You are a conversion researcher. No customer reviews exist for this product yet, so infer LIKELY structured insights from the product facts and category norms.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
${INSIGHTS_SHAPE}
- "quotes": always an empty array — there are no reviews to quote. Never invent customer voice.
- "reliability": cap at 50 — these are estimates, not evidence.
- product_features source must be "listing" or "specs" only.`;

/** Normalize for quote matching: collapse whitespace, strip curly quotes. */
function norm(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

const asSentiment = (s: unknown): Sentiment => (s === "positive" || s === "negative" ? s : "neutral");
const asJourney = (s: unknown): Journey => (s === "post_purchase" ? "post_purchase" : "pre_purchase");
const clamp100 = (n: unknown, cap = 100): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(cap, Math.round(n))) : 0;

/**
 * Extract structured insights. With reviews: every quote is verified verbatim
 * against the stored review text and dropped if not found; an insight keeps
 * only verified quotes and is dropped when none survive — the model can never
 * smuggle invented customer voice through. review_count is COMPUTED: the
 * number of stored reviews containing at least one verified quote. Without
 * reviews: the AI-estimated tier, clearly labelled, quote-free.
 */
export async function extractInsights(
  env: AiEnv,
  input: { productName: string; category: string; features: string[]; reviews: Array<{ title: string | null; body: string }> },
): Promise<LaunchInsights> {
  const facts = [
    `Product: ${input.productName}`,
    input.category ? `Category: ${input.category}` : "",
    input.features.length ? `Stated features:\n- ${input.features.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  type RawInsights = {
    review_insights?: Array<{ insight?: string; sentiment?: string; journey?: string; quotes?: unknown[]; reliability?: number }>;
    product_features?: Array<{ feature?: string; journey?: string; source?: string }>;
    conversion_drivers?: Array<{ driver?: string; kind?: string; relevance?: number; journey?: string }>;
  };

  const grounded = input.reviews.length > 0;
  const corpus = grounded
    ? input.reviews
        .map((r, i) => `Review ${i + 1}:${r.title ? ` [${r.title}]` : ""} ${r.body}`)
        .join("\n---\n")
        .slice(0, 40000)
    : "";
  const normalizedReviews = input.reviews.map((r) => norm(`${r.title || ""} ${r.body}`));

  const content = await complete(
    env,
    grounded ? INSIGHTS_SYSTEM : INSIGHTS_AI_SYSTEM,
    grounded ? `${facts}\n\nCustomer reviews:\n${corpus}` : facts,
  );
  const parsed = parseJson(content) as RawInsights;

  const review_insights: ReviewInsight[] = (parsed.review_insights || [])
    .filter((x) => typeof x?.insight === "string" && x.insight.trim())
    .map((x) => {
      const quotes = (Array.isArray(x.quotes) ? x.quotes : [])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
        .filter((q) => normalizedReviews.some((r) => r.includes(norm(q)))); // verbatim only
      const review_count = normalizedReviews.filter((r) => quotes.some((q) => r.includes(norm(q)))).length;
      return {
        insight: x.insight!.trim(),
        sentiment: asSentiment(x.sentiment),
        journey: asJourney(x.journey),
        quotes,
        review_count,
        reliability: clamp100(x.reliability, grounded ? 100 : 50),
      };
    })
    // grounded tier: an insight with no surviving verbatim quote is dropped
    .filter((x) => !grounded || x.quotes.length > 0);

  const product_features: ProductFeature[] = (parsed.product_features || [])
    .filter((x) => typeof x?.feature === "string" && x.feature.trim())
    .map((x) => ({
      feature: x.feature!.trim(),
      journey: asJourney(x.journey),
      source: x.source === "reviews" && grounded ? "reviews" : x.source === "specs" ? "specs" : "listing",
    }));

  const conversion_drivers: ConversionDriver[] = (parsed.conversion_drivers || [])
    .filter((x) => typeof x?.driver === "string" && x.driver.trim())
    .map((x, i): ConversionDriver => ({
      driver: x.driver!.trim(),
      kind: x.kind === "blocker" ? "blocker" : "driver",
      relevance: typeof x.relevance === "number" && x.relevance >= 1 ? Math.round(x.relevance) : i + 1,
      journey: asJourney(x.journey),
    }))
    .sort((a, b) => a.relevance - b.relevance);

  return { source: grounded ? "reviews" : "ai", review_insights, product_features, conversion_drivers };
}

// ── Listing copy generation ──────────────────────────────────────────

const COPY_SYSTEM = `You are an expert Amazon listing copywriter. Write conversion-focused, policy-safe listing copy grounded in the product facts, brand voice, and customer insights provided.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
- Shape: { "title": string, "bullets": string[], "description": string, "backend_keywords": string }
- HARD LIMITS (Amazon): title <= ${LIMITS.title} characters. EXACTLY ${LIMITS.bulletCount} bullets, each <= ${LIMITS.bullet} characters. description <= ${LIMITS.description} characters. backend_keywords <= ${LIMITS.backendKeywordBytes} bytes.
- Title: brand + product + top differentiators + key attribute (size/count/material). Title Case, no promo language ("best", "sale", "free shipping"), no emojis, no ALL CAPS words.
- Bullets: each opens with a short BENEFIT PHRASE IN CAPS followed by a colon, then the supporting detail. Weave in the customers' own vocabulary and answer their objections.
- Description: 2-4 short paragraphs, plain text (no HTML). Story + use cases + reassurance.
- backend_keywords: space-separated search terms; no commas needed, no duplicates of words already in the title, no competitor brand names, no misspellings-only stuffing.
- Never invent claims (certifications, awards, measurements) not present in the product facts.`;

export interface CopyResult {
  copy: ListingCopy;
  enforced: boolean; // true if server-side truncation had to kick in
}

export async function generateListingCopy(
  env: AiEnv,
  input: {
    productName: string;
    category: string;
    features: string[];
    specs: Record<string, string>;
    brand: { name: string; tone: string; notes: string } | null;
    insights: LaunchInsights;
    kind: "launch" | "optimize";
  },
): Promise<CopyResult> {
  const ins = input.insights;
  const fmtReviewInsights = ins.review_insights.length
    ? `Review insights:\n${ins.review_insights
        .map((i) => `- [${i.sentiment}/${i.journey}] ${i.insight}${i.quotes.length ? ` (customers: ${i.quotes.map((q) => `"${q}"`).join(" · ")})` : ""}`)
        .join("\n")}`
    : "";
  const fmtDrivers = ins.conversion_drivers.length
    ? `Conversion drivers/blockers (ranked):\n${ins.conversion_drivers
        .map((d) => `${d.relevance}. [${d.kind}] ${d.driver}`)
        .join("\n")}`
    : "";

  const user = [
    `Product: ${input.productName}`,
    input.category ? `Category: ${input.category}` : "",
    input.features.length ? `Features:\n- ${input.features.join("\n- ")}` : "",
    Object.keys(input.specs).length
      ? `Specs:\n${Object.entries(input.specs).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : "",
    input.brand
      ? `Brand: ${input.brand.name}${input.brand.tone ? `\nBrand voice: ${input.brand.tone}` : ""}${input.brand.notes ? `\nBrand notes: ${input.brand.notes}` : ""}`
      : "",
    ins.source === "reviews"
      ? "Customer research (from real reviews — ground the copy in these, reuse the customers' own words, answer the blockers):"
      : "Estimated buyer research (no reviews yet — AI-estimated, use as soft guidance):",
    fmtReviewInsights,
    fmtDrivers,
    input.kind === "optimize"
      ? "This is an OPTIMIZE pass on an existing listing: prioritize sharper differentiation and objection handling."
      : "Write the listing copy now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  let lastCopy: ListingCopy | null = null;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await complete(env, COPY_SYSTEM, feedback ? `${user}\n\nYour previous output violated these limits — fix them:\n${feedback}` : user);
    const parsed = parseJson(content) as Partial<ListingCopy>;
    const copy: ListingCopy = {
      title: (parsed.title || "").trim(),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.map((b) => String(b).trim()) : [],
      description: (parsed.description || "").trim(),
      backend_keywords: (parsed.backend_keywords || "").trim(),
    };
    const errors = validateListingCopy(copy);
    if (errors.length === 0) return { copy, enforced: false };
    lastCopy = copy;
    feedback = errors.map((e) => `- ${e}`).join("\n");
  }
  // Model failed twice — hard-enforce so a launch never carries non-compliant copy.
  return { copy: enforceListingCopy(lastCopy!), enforced: true };
}
