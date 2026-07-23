// Managed-render client. Takes a self-contained HTML doc + Bearer
// CLAWNIFY_TOKEN and returns the PNG bytes. Contract mirrors the live
// services worker (screenshot/render), same as other Clawnify templates.

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

async function errorDetail(res: Response): Promise<string> {
  let detail = `render service returned ${res.status}`;
  try {
    const j = (await res.json()) as { error?: string; detail?: string };
    detail = j.detail || j.error || detail;
  } catch {
    /* non-JSON error body */
  }
  return detail;
}

/** HTML → PNG via /screenshot/render (Cloudflare Browser Rendering). @2x. */
export async function renderStatic(a: {
  html: string;
  w: number;
  h: number;
  filename: string;
  token: string;
  servicesUrl?: string;
}): Promise<ArrayBuffer> {
  const res = await fetch(`${a.servicesUrl || DEFAULT_SERVICES_URL}/screenshot/render`, {
    method: "POST",
    headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      html: a.html,
      viewport: { width: a.w, height: a.h, deviceScaleFactor: 2 },
      type: "png",
      filename: a.filename,
    }),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.arrayBuffer();
}
