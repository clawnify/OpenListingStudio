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
      "X-Title": "Open Listing Studio",
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

// ── Review insight extraction ────────────────────────────────────────

export interface Insight {
  point: string;
  quote: string | null; // verbatim from a stored review, verified server-side
}

export interface LaunchInsights {
  source: "reviews" | "ai"; // "reviews" = grounded in real customer text
  pains: Insight[];
  desires: Insight[];
  objections: Insight[];
  vocabulary: Insight[]; // customer phrases worth reusing in copy
}

const INSIGHTS_SYSTEM = `You are a conversion researcher analyzing Amazon customer reviews for a product. Extract the insights a listing copywriter needs.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
- Shape: { "pains": [{"point": string, "quote": string}], "desires": [...], "objections": [...], "vocabulary": [...] }
- "point": one concise sentence (<= 120 chars) naming the pain / desire / objection / customer phrase.
- "quote": a SHORT supporting excerpt (<= 160 chars) COPIED CHARACTER-FOR-CHARACTER from one review — same casing, punctuation, and typos. Never paraphrase, never merge two reviews, never invent. If no review supports the point, omit the point entirely.
- "pains": problems customers had before/without the product. "desires": outcomes they bought it for. "objections": doubts, complaints, or reasons for returns. "vocabulary": the exact words customers use to describe the product or its use.
- 2-5 items per category. Quality over quantity — every point must be evidenced.`;

const INSIGHTS_AI_SYSTEM = `You are a conversion researcher. No customer reviews exist for this product yet, so infer LIKELY buyer pains, desires, objections, and vocabulary from the product facts and category norms.

Output rules:
- Respond with ONLY a JSON object, no prose, no code fences.
- Shape: { "pains": [{"point": string}], "desires": [...], "objections": [...], "vocabulary": [...] }
- "point": one concise sentence (<= 120 chars). Do NOT include quotes — there are no reviews to quote. Never invent customer voice.
- 2-4 items per category, conservative and category-typical.`;

/** Normalize for quote matching: collapse whitespace, strip curly quotes. */
function norm(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract insights. With reviews: quotes are verified verbatim against the
 * stored review text (title + body) and dropped if not found — the model can
 * never smuggle an invented customer voice through. Without reviews: the AI
 * fallback tier, clearly labelled, quote-free.
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

  if (input.reviews.length === 0) {
    const content = await complete(env, INSIGHTS_AI_SYSTEM, facts);
    const parsed = parseJson(content) as Partial<Record<"pains" | "desires" | "objections" | "vocabulary", Array<{ point?: string }>>>;
    const take = (arr?: Array<{ point?: string }>): Insight[] =>
      (arr || [])
        .filter((x) => typeof x?.point === "string" && x.point.trim())
        .map((x) => ({ point: x.point!.trim(), quote: null }));
    return { source: "ai", pains: take(parsed.pains), desires: take(parsed.desires), objections: take(parsed.objections), vocabulary: take(parsed.vocabulary) };
  }

  const corpus = input.reviews
    .map((r, i) => `Review ${i + 1}:${r.title ? ` [${r.title}]` : ""} ${r.body}`)
    .join("\n---\n")
    .slice(0, 40000);
  const haystack = norm(input.reviews.map((r) => `${r.title || ""} ${r.body}`).join(" \n "));

  const content = await complete(env, INSIGHTS_SYSTEM, `${facts}\n\nCustomer reviews:\n${corpus}`);
  const parsed = parseJson(content) as Partial<Record<"pains" | "desires" | "objections" | "vocabulary", Array<{ point?: string; quote?: string }>>>;

  const verify = (arr?: Array<{ point?: string; quote?: string }>): Insight[] =>
    (arr || [])
      .filter((x) => typeof x?.point === "string" && x.point.trim())
      .map((x) => {
        const quote = typeof x.quote === "string" ? x.quote.trim() : "";
        const verbatim = quote.length > 0 && haystack.includes(norm(quote));
        return { point: x.point!.trim(), quote: verbatim ? quote : null };
      })
      // grounded tier: an unevidenced point is dropped, per the system prompt
      .filter((x) => x.quote !== null);

  return {
    source: "reviews",
    pains: verify(parsed.pains),
    desires: verify(parsed.desires),
    objections: verify(parsed.objections),
    vocabulary: verify(parsed.vocabulary),
  };
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
  const fmtInsight = (label: string, arr: Insight[]) =>
    arr.length ? `${label}:\n${arr.map((i) => `- ${i.point}${i.quote ? ` (customer: "${i.quote}")` : ""}`).join("\n")}` : "";

  const user = [
    `Product: ${input.productName}`,
    input.category ? `Category: ${input.category}` : "",
    input.features.length ? `Features:\n- ${input.features.join("\n- ")}` : "",
    Object.keys(input.specs).length
      ? `Specs:\n${Object.entries(input.specs).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : "",
    input.brand
      ? `Brand: ${input.brand.name}${input.brand.tone ? `\nBrand voice/tone: ${input.brand.tone}` : ""}${input.brand.notes ? `\nBrand notes: ${input.brand.notes}` : ""}`
      : "",
    input.insights.source === "reviews"
      ? "Customer insights (from real reviews — ground the copy in these):"
      : "Estimated buyer insights (no reviews yet — AI-estimated, use as soft guidance):",
    fmtInsight("Pains", input.insights.pains),
    fmtInsight("Desires", input.insights.desires),
    fmtInsight("Objections to answer", input.insights.objections),
    fmtInsight("Customer vocabulary to reuse", input.insights.vocabulary),
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
