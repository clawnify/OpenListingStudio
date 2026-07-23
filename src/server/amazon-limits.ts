/**
 * Amazon listing-copy limits — one place for the validators the Launch
 * workflow enforces. These are the platform's hard/recommended caps:
 *   • title        ≤ 200 characters
 *   • bullets      exactly 5, each ≤ 250 characters
 *   • description  ≤ 2000 characters
 *   • backend (search terms) ≤ 249 BYTES (Amazon counts bytes, not chars)
 */

export const LIMITS = {
  title: 200,
  bullet: 250,
  bulletCount: 5,
  description: 2000,
  backendKeywordBytes: 249,
} as const;

export interface ListingCopy {
  title: string;
  bullets: string[];
  description: string;
  backend_keywords: string;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Returns a list of violations — empty means the copy is Amazon-compliant. */
export function validateListingCopy(copy: ListingCopy): string[] {
  const errors: string[] = [];
  if (!copy.title?.trim()) errors.push("title is empty");
  else if (copy.title.length > LIMITS.title)
    errors.push(`title is ${copy.title.length} chars (max ${LIMITS.title})`);

  if (!Array.isArray(copy.bullets) || copy.bullets.length !== LIMITS.bulletCount)
    errors.push(`must have exactly ${LIMITS.bulletCount} bullets (got ${copy.bullets?.length ?? 0})`);
  else
    copy.bullets.forEach((b, i) => {
      if (!b?.trim()) errors.push(`bullet ${i + 1} is empty`);
      else if (b.length > LIMITS.bullet)
        errors.push(`bullet ${i + 1} is ${b.length} chars (max ${LIMITS.bullet})`);
    });

  if (!copy.description?.trim()) errors.push("description is empty");
  else if (copy.description.length > LIMITS.description)
    errors.push(`description is ${copy.description.length} chars (max ${LIMITS.description})`);

  const kwBytes = byteLength(copy.backend_keywords || "");
  if (kwBytes > LIMITS.backendKeywordBytes)
    errors.push(`backend keywords are ${kwBytes} bytes (max ${LIMITS.backendKeywordBytes})`);

  return errors;
}

/** Truncate a string to a maximum UTF-8 byte length without splitting words. */
function truncateBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const words = s.split(/\s+/);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (byteLength(next) > maxBytes) break;
    out = next;
  }
  return out;
}

/**
 * Last-resort hard enforcement after the model failed to self-correct: trims
 * to the caps so a launch can never carry non-compliant copy. Word-boundary
 * truncation; bullets padded/cut to exactly five.
 */
export function enforceListingCopy(copy: ListingCopy): ListingCopy {
  const cut = (s: string, max: number) => {
    if ((s || "").length <= max) return s || "";
    const sliced = s.slice(0, max);
    const lastSpace = sliced.lastIndexOf(" ");
    return (lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced).trim();
  };
  const bullets = (copy.bullets || []).filter((b) => b?.trim()).map((b) => cut(b, LIMITS.bullet));
  while (bullets.length < LIMITS.bulletCount) bullets.push("");
  return {
    title: cut(copy.title || "", LIMITS.title),
    bullets: bullets.slice(0, LIMITS.bulletCount),
    description: cut(copy.description || "", LIMITS.description),
    backend_keywords: truncateBytes(copy.backend_keywords || "", LIMITS.backendKeywordBytes),
  };
}
