/**
 * Image-stack template registry — the slot-template engine for the Launch
 * workflow. Each TemplateDef declares its size + the slots it fills from the
 * launch context (product facts, brand kit, generated copy, review insights)
 * and compiles to a SELF-CONTAINED HTML document that the managed screenshot
 * service renders to PNG (real Chrome, so Google Fonts load in-render).
 *
 * The brand kit is the visual system: colors and fonts flow into every
 * template, so two kits on the same product produce visibly different stacks.
 * Copy shown in templates comes from the product's stored features and the
 * generated listing copy — templates never invent claims.
 */

import type { LaunchInsights } from "./ai.js";
import type { ListingCopy } from "./amazon-limits.js";

export interface BrandStyle {
  name: string;
  colors: { primary: string; secondary: string; accent: string; background: string };
  fonts: { heading: string; body: string };
}

export const DEFAULT_BRAND: BrandStyle = {
  name: "",
  colors: { primary: "#1A202C", secondary: "#475569", accent: "#DD5164", background: "#F8F9FA" },
  fonts: { heading: "Inter", body: "Inter" },
};

export interface TemplateCtx {
  product: { name: string; category: string; features: string[]; specs: Record<string, string> };
  brand: BrandStyle;
  copy: ListingCopy | null;
  insights: LaunchInsights | null;
  /** First product photo as a data URI (or a neutral placeholder). */
  photoDataUri: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  group: "feed" | "aplus";
  size_label: string;
  width: number;
  height: number;
  description: string;
  buildHTML(ctx: TemplateCtx): string;
}

// ── helpers ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fontHref(families: string[]): string {
  const uniq = [...new Set(families.filter(Boolean))];
  return `https://fonts.googleapis.com/css2?${uniq
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600;700;800`)
    .join("&")}&display=swap`;
}

function shell(ctx: TemplateCtx, w: number, h: number, body: string, extraCss = ""): string {
  const { colors, fonts } = ctx.brand;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontHref([fonts.heading, fonts.body])}" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
  body { font-family: '${fonts.body}', sans-serif; background: ${colors.background}; color: ${colors.primary}; }
  .heading { font-family: '${fonts.heading}', sans-serif; }
  ${extraCss}
</style></head><body>${body}</body></html>`;
}

/** First N features, falling back to bullets' lead phrases when features are empty. */
function calloutLines(ctx: TemplateCtx, n: number): string[] {
  const feats = ctx.product.features.filter(Boolean);
  if (feats.length) return feats.slice(0, n);
  const bullets = ctx.copy?.bullets || [];
  return bullets
    .map((b) => b.split(":")[0].trim())
    .filter(Boolean)
    .slice(0, n);
}

function bestQuote(ctx: TemplateCtx): { quote: string; point: string } | null {
  const ins = ctx.insights;
  if (!ins || ins.source !== "reviews") return null;
  const pools = [ins.desires, ins.vocabulary, ins.pains];
  for (const pool of pools) {
    const hit = pool.find((i) => i.quote);
    if (hit?.quote) return { quote: hit.quote, point: hit.point };
  }
  return null;
}

const STAR = `<svg width="34" height="34" viewBox="0 0 24 24" fill="#FFA41C" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2z"/></svg>`;
const CHECK = (color: string) =>
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const DASH = `<span style="color:#B9C0C9;font-weight:700;font-size:24px;">—</span>`;

// ── Feed templates (1600×1600 listing / social images) ───────────────

const feedFeatures: TemplateDef = {
  id: "feed_features",
  name: "Feature Callouts",
  group: "feed",
  size_label: "Feed 1600×1600",
  width: 1600,
  height: 1600,
  description: "Product photo with brand-styled feature callouts — the workhorse infographic of the image stack.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const callouts = calloutLines(ctx, 4);
    const items = callouts
      .map(
        (c) => `<div style="display:flex;align-items:center;gap:22px;background:#fff;border:2px solid ${colors.primary}14;border-radius:20px;padding:26px 32px;box-shadow:0 6px 24px rgba(0,0,0,0.06);">
          <div style="flex-shrink:0;width:52px;height:52px;border-radius:50%;background:${colors.accent}1A;display:flex;align-items:center;justify-content:center;">${CHECK(colors.accent)}</div>
          <div style="font-size:34px;font-weight:600;line-height:1.25;color:${colors.primary};">${esc(c)}</div>
        </div>`,
      )
      .join("");
    return shell(
      ctx,
      1600,
      1600,
      `<div style="width:1600px;height:1600px;display:flex;flex-direction:column;padding:90px;">
        <div>
          ${ctx.brand.name ? `<div style="font-size:26px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${colors.accent};margin-bottom:18px;">${esc(ctx.brand.name)}</div>` : ""}
          <div class="heading" style="font-size:72px;font-weight:800;line-height:1.08;max-width:1300px;">${esc(ctx.product.name)}</div>
        </div>
        <div style="flex:1;display:flex;align-items:center;gap:70px;margin-top:50px;">
          <div style="flex:1.1;display:flex;align-items:center;justify-content:center;">
            <img src="${ctx.photoDataUri}" style="max-width:100%;max-height:1000px;object-fit:contain;filter:drop-shadow(0 30px 60px rgba(0,0,0,0.18));"/>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:28px;">${items}</div>
        </div>
      </div>`,
    );
  },
};

const feedReview: TemplateDef = {
  id: "feed_review",
  name: "Customer Voice",
  group: "feed",
  size_label: "Feed 1600×1600",
  width: 1600,
  height: 1600,
  description: "A verbatim customer quote as social proof over the product photo. Skipped gracefully when no review quote exists.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const q = bestQuote(ctx);
    const stars = `<div style="display:flex;gap:8px;">${STAR.repeat(5)}</div>`;
    const quoteBlock = q
      ? `${stars}
         <div class="heading" style="font-size:58px;font-weight:700;line-height:1.25;margin-top:34px;">&ldquo;${esc(q.quote)}&rdquo;</div>
         <div style="font-size:28px;color:${colors.secondary};margin-top:26px;">— Verified customer review</div>`
      : `<div class="heading" style="font-size:64px;font-weight:800;line-height:1.15;">${esc(ctx.copy?.title || ctx.product.name)}</div>`;
    return shell(
      ctx,
      1600,
      1600,
      `<div style="width:1600px;height:1600px;display:flex;flex-direction:column;">
        <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:80px;background:${colors.primary};">
          <img src="${ctx.photoDataUri}" style="max-width:82%;max-height:760px;object-fit:contain;filter:drop-shadow(0 30px 60px rgba(0,0,0,0.35));"/>
        </div>
        <div style="height:600px;background:${colors.background};padding:80px 100px;display:flex;flex-direction:column;justify-content:center;">
          ${quoteBlock}
        </div>
        <div style="height:26px;background:${colors.accent};"></div>
      </div>`,
    );
  },
};

const feedBenefit: TemplateDef = {
  id: "feed_benefit",
  name: "Hero Benefit",
  group: "feed",
  size_label: "Feed 1600×1600",
  width: 1600,
  height: 1600,
  description: "One bold benefit headline from the generated copy with the product front and center.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const lead = ctx.copy?.bullets?.[0]?.split(":") || [];
    const headline = lead[0]?.trim() || ctx.product.name;
    const sub = lead.slice(1).join(":").trim() || ctx.product.category;
    return shell(
      ctx,
      1600,
      1600,
      `<div style="width:1600px;height:1600px;display:flex;flex-direction:column;align-items:center;text-align:center;padding:100px 110px;background:linear-gradient(180deg, ${colors.background} 0%, #FFFFFF 100%);">
        ${ctx.brand.name ? `<div style="font-size:26px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${colors.accent};">${esc(ctx.brand.name)}</div>` : ""}
        <div class="heading" style="font-size:88px;font-weight:800;line-height:1.05;margin-top:30px;max-width:1350px;">${esc(headline)}</div>
        ${sub ? `<div style="font-size:36px;color:${colors.secondary};margin-top:34px;max-width:1200px;line-height:1.4;">${esc(sub)}</div>` : ""}
        <div style="flex:1;display:flex;align-items:center;justify-content:center;margin-top:40px;">
          <img src="${ctx.photoDataUri}" style="max-width:100%;max-height:860px;object-fit:contain;filter:drop-shadow(0 34px 70px rgba(0,0,0,0.2));"/>
        </div>
      </div>`,
    );
  },
};

// ── A+ content modules (standard Amazon A+ sizes) ────────────────────

const aplusHero: TemplateDef = {
  id: "aplus_hero",
  name: "A+ Hero Banner",
  group: "aplus",
  size_label: "A+ 1464×600",
  width: 1464,
  height: 600,
  description: "Full-width A+ hero: brand block, product name, and headline benefit beside the product photo.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const headline = ctx.copy?.bullets?.[0]?.split(":")[0]?.trim() || ctx.product.category || "Made for every day";
    return shell(
      ctx,
      1464,
      600,
      `<div style="width:1464px;height:600px;display:flex;background:${colors.primary};">
        <div style="flex:1.2;padding:70px 80px;display:flex;flex-direction:column;justify-content:center;">
          ${ctx.brand.name ? `<div style="font-size:22px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:${colors.accent};margin-bottom:20px;">${esc(ctx.brand.name)}</div>` : ""}
          <div class="heading" style="font-size:56px;font-weight:800;line-height:1.1;color:#FFFFFF;">${esc(ctx.product.name)}</div>
          <div style="font-size:28px;color:#FFFFFFB8;margin-top:22px;line-height:1.4;">${esc(headline)}</div>
        </div>
        <div style="flex:1;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg, ${colors.accent}26, transparent);">
          <img src="${ctx.photoDataUri}" style="max-width:86%;max-height:480px;object-fit:contain;filter:drop-shadow(0 24px 48px rgba(0,0,0,0.35));"/>
        </div>
      </div>`,
    );
  },
};

const aplusFeatureGrid: TemplateDef = {
  id: "aplus_feature_grid",
  name: "A+ Feature Grid",
  group: "aplus",
  size_label: "A+ 970×600",
  width: 970,
  height: 600,
  description: "Three-column feature module built from the product's stated features.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const feats = calloutLines(ctx, 3);
    const cols = feats
      .map(
        (f, i) => `<div style="flex:1;background:#FFFFFF;border:1px solid ${colors.primary}14;border-radius:16px;padding:34px 30px;display:flex;flex-direction:column;gap:18px;">
          <div style="width:56px;height:56px;border-radius:14px;background:${colors.accent}1A;display:flex;align-items:center;justify-content:center;font-family:inherit;">
            <span class="heading" style="font-size:26px;font-weight:800;color:${colors.accent};">${i + 1}</span>
          </div>
          <div style="font-size:24px;font-weight:600;line-height:1.35;color:${colors.primary};">${esc(f)}</div>
        </div>`,
      )
      .join("");
    return shell(
      ctx,
      970,
      600,
      `<div style="width:970px;height:600px;padding:56px 60px;display:flex;flex-direction:column;background:${colors.background};">
        <div class="heading" style="font-size:40px;font-weight:800;">Why ${esc(ctx.brand.name || ctx.product.name)}</div>
        <div style="width:64px;height:6px;border-radius:3px;background:${colors.accent};margin:20px 0 34px;"></div>
        <div style="flex:1;display:flex;gap:26px;">${cols}</div>
      </div>`,
    );
  },
};

const aplusComparison: TemplateDef = {
  id: "aplus_comparison",
  name: "A+ At-a-Glance Chart",
  group: "aplus",
  size_label: "A+ 970×600",
  width: 970,
  height: 600,
  description: "Check-mark chart of the product's own features vs. a generic alternative column — built only from stated features.",
  buildHTML(ctx) {
    const { colors } = ctx.brand;
    const feats = calloutLines(ctx, 4);
    const rows = feats
      .map(
        (f, i) => `<div style="display:flex;align-items:center;padding:22px 30px;background:${i % 2 ? "#FFFFFF" : colors.primary + "08"};border-radius:12px;">
          <div style="flex:1;font-size:24px;font-weight:600;color:${colors.primary};">${esc(f)}</div>
          <div style="width:170px;display:flex;justify-content:center;">${CHECK(colors.accent)}</div>
          <div style="width:170px;display:flex;justify-content:center;">${DASH}</div>
        </div>`,
      )
      .join("");
    return shell(
      ctx,
      970,
      600,
      `<div style="width:970px;height:600px;padding:50px 60px;display:flex;flex-direction:column;background:${colors.background};">
        <div style="display:flex;align-items:flex-end;padding:0 30px 18px;">
          <div style="flex:1;" class="heading"><span style="font-size:38px;font-weight:800;">At a glance</span></div>
          <div style="width:170px;text-align:center;font-size:20px;font-weight:800;color:${colors.accent};text-transform:uppercase;letter-spacing:0.06em;">${esc(ctx.brand.name || "This one")}</div>
          <div style="width:170px;text-align:center;font-size:20px;font-weight:700;color:${colors.secondary};text-transform:uppercase;letter-spacing:0.06em;">Typical</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:12px;">${rows}</div>
      </div>`,
    );
  },
};

// ── Registry ─────────────────────────────────────────────────────────

export const TEMPLATES: TemplateDef[] = [
  feedFeatures,
  feedReview,
  feedBenefit,
  aplusHero,
  aplusFeatureGrid,
  aplusComparison,
];

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * The main-image concept is NOT an HTML template — it's a directed image edit
 * (white-background hero) executed by the image engine against the product
 * photo. It lives in the same asset stack under this id.
 */
export const MAIN_IMAGE_TEMPLATE_ID = "main_image";

export const PLACEHOLDER_PHOTO =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="100%" height="100%" fill="#E2E8F0"/><text x="400" y="410" font-family="sans-serif" font-size="34" fill="#94A3B8" text-anchor="middle">Product photo</text></svg>`,
  );
