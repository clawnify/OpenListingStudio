/**
 * The directed-edit tool registry — the single source of truth for:
 *   1. the UI grid (GET /api/tools serves the public shape),
 *   2. the agent-callable actions (same shape, in the public OpenAPI spec),
 *   3. the prompt actually sent to the image model (`buildPrompt`, server-only).
 *
 * Each tool is a *directed edit*: a preset instruction applied to a source
 * product photo. Every tool keeps the PRODUCT itself — its shape, colors,
 * labels, text, and proportions — pixel-faithful and changes only the one
 * thing named. That's what keeps output honest for a marketplace listing
 * instead of hallucinating a different product.
 *
 * Add a capability by adding one entry here. Nothing else needs to change.
 */

export type ToolInput = {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export type ToolDef = {
  id: string;
  label: string;
  category: "listing" | "lifestyle" | "polish";
  icon: string; // lucide-react icon name
  description: string; // shown in the UI card AND to the agent
  inputs: ToolInput[];
  /** Resolves the model prompt from the user's input values. Server-only. */
  buildPrompt: (params: Record<string, string>) => string;
  /** Honesty note returned with the result where AI edits could mislead. */
  disclaimer?: string;
  /** Tool is unavailable without FAL_API_KEY (no model fallback exists). */
  requiresFal?: boolean;
};

/** Prepended to every edit so the model treats the product as ground truth. */
const KEEP_PRODUCT =
  "Keep the product itself exactly as photographed — same shape, colors, materials, label text, logos, and proportions. Never redraw, restyle, or replace the product. Photorealistic result with consistent lighting and shadows.";

const CLAIM_DISCLAIMER =
  "AI edits preserve the product's look, not reality. Review the result before publishing — never let an edit imply a feature, size, or accessory the product doesn't have.";

const SCENES = [
  "Kitchen counter",
  "Living room",
  "Bathroom shelf",
  "Home office desk",
  "Outdoor patio",
  "Gym",
  "Bedroom nightstand",
  "Picnic table",
];

export const TOOLS: ToolDef[] = [
  {
    id: "white_background",
    label: "White Background",
    category: "listing",
    icon: "square",
    description:
      "Clean pure-white background for the Amazon main image: product isolated, centered, softly grounded. Marketplace-compliant hero shot.",
    inputs: [
      { name: "notes", label: "Extra direction (optional)", type: "text", placeholder: "slight 3/4 angle, fill more of the frame" },
    ],
    buildPrompt: (p) =>
      `${KEEP_PRODUCT} Isolate the product on a pure white background (RGB 255,255,255), centered, filling roughly 85% of the frame, with a soft natural contact shadow beneath it. Remove every other object, prop, and texture.${p.notes ? ` Additional direction: ${p.notes}.` : ""}`,
  },
  {
    id: "lifestyle_scene",
    label: "Lifestyle Scene",
    category: "lifestyle",
    icon: "sofa",
    description:
      "Place the product in a realistic in-use setting — the scroll-stopping context shot for the image stack and ads.",
    inputs: [
      { name: "scene", label: "Setting", type: "select", options: SCENES, required: true },
      { name: "notes", label: "Extra direction (optional)", type: "text", placeholder: "morning light, a hand reaching for it" },
    ],
    buildPrompt: (p) =>
      `${KEEP_PRODUCT} Place the product naturally in a realistic ${(p.scene || "home").toLowerCase()} scene with believable scale, perspective, and lighting. The product stays the hero of the frame.${p.notes ? ` Additional direction: ${p.notes}.` : ""}`,
    disclaimer: CLAIM_DISCLAIMER,
  },
  {
    id: "background_swap",
    label: "Background Swap",
    category: "lifestyle",
    icon: "replace",
    description:
      "Swap only the background to any described surface or backdrop — seasonal refreshes and brand-color backdrops without a reshoot.",
    inputs: [
      { name: "background", label: "New background", type: "text", required: true, placeholder: "warm oak tabletop with soft window light" },
    ],
    buildPrompt: (p) =>
      `${KEEP_PRODUCT} Replace only the background with: ${p.background}. The product's position, angle, and scale stay identical; match the new background's lighting direction in the product's shadows.`,
    disclaimer: CLAIM_DISCLAIMER,
  },
  {
    id: "infographic_overlay",
    label: "Infographic Overlay",
    category: "listing",
    icon: "list-checks",
    description:
      "Add clean feature-callout text and lines over the photo — the classic Amazon infographic image, built from your product's real features.",
    inputs: [
      { name: "headline", label: "Headline", type: "text", required: true, placeholder: "Built For Daily Use" },
      { name: "callouts", label: "Feature callouts (one per line or ; separated)", type: "text", required: true, placeholder: "BPA-free; Keeps drinks cold 24h; Fits car cup holders" },
      { name: "accent", label: "Accent color (optional)", type: "text", placeholder: "#DD5164 or 'forest green'" },
    ],
    buildPrompt: (p) => {
      const callouts = (p.callouts || "")
        .split(/;|\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      return `${KEEP_PRODUCT} Turn this into a professional e-commerce infographic image: keep the product photo as the centerpiece and overlay clean, modern graphic design — a bold headline reading "${p.headline}" and ${callouts.length} short feature callouts with thin pointer lines to the relevant part of the product: ${callouts.map((c) => `"${c}"`).join(", ")}. Flat design, generous whitespace, legible sans-serif type${p.accent ? `, accent color ${p.accent}` : ""}. Text must be spelled exactly as given.`;
    },
    disclaimer: CLAIM_DISCLAIMER,
  },
  {
    id: "remove_background",
    label: "Remove Background",
    category: "listing",
    icon: "scissors",
    description:
      "Cut the product out to a transparent PNG (BiRefNet matting) — clean compositing on any backdrop, no white box.",
    inputs: [],
    // True alpha matting, not a generative edit — the prompt is unused; the
    // dispatcher routes this straight to fal BiRefNet.
    buildPrompt: () => "",
    requiresFal: true,
  },
  {
    id: "upscale",
    label: "Enhance & Upscale",
    category: "polish",
    icon: "sparkles",
    description:
      "Sharpen and boost a photo to listing quality. Uses fal.ai upscaling when a FAL key is set; falls back to a model enhance pass.",
    inputs: [],
    buildPrompt: () =>
      `${KEEP_PRODUCT} Enhance to a crisp, professional, high-resolution product photograph: improve sharpness, clarity, dynamic range, and color accuracy. Do not add or remove objects.`,
  },
];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** Client/agent-safe shape — omits the server-only `buildPrompt`. */
export function publicTool(t: ToolDef) {
  const { buildPrompt, ...rest } = t;
  return rest;
}
