import { useEffect, useMemo, useState } from "react";
import {
  Square,
  Sofa,
  Replace,
  ListChecks,
  Scissors,
  Sparkles,
  Upload,
  Loader2,
  AlertTriangle,
  Download,
  CornerUpLeft,
  type LucideIcon,
} from "lucide-react";
import { api, assetUrl, parsePhotos, type Tool, type Asset, type Product, type Health } from "../api";

const ICONS: Record<string, LucideIcon> = {
  square: Square,
  sofa: Sofa,
  replace: Replace,
  "list-checks": ListChecks,
  scissors: Scissors,
  sparkles: Sparkles,
};

const CATEGORY_ORDER = ["listing", "lifestyle", "polish"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  listing: "Listing images",
  lifestyle: "Lifestyle",
  polish: "Polish",
};

type Selected = { url: string; label: string; sub?: string; disclaimer?: string | null };

export function ToolsView() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [active, setActive] = useState<Tool | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTools().then(setTools).catch(() => {});
    api.listProducts().then(setProducts).catch(() => {});
    api.health().then(setHealth).catch(() => {});
  }, []);

  const grouped = useMemo(
    () => CATEGORY_ORDER.map((cat) => ({ cat, items: tools.filter((t) => t.category === cat) })).filter((g) => g.items.length),
    [tools],
  );

  async function onUpload(file: File) {
    setUploading(true);
    try {
      const { url } = await api.upload(file);
      setSource(url);
      setSelected({ url, label: "Source" });
    } finally {
      setUploading(false);
    }
  }

  function useProductPhoto(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    const photos = p ? parsePhotos(p.image_r2_keys) : [];
    const main = photos.find((x) => x.role === "main") ?? photos[0];
    if (main) {
      const url = `/api/uploads/${main.r2_key}`;
      setSource(url);
      setSelected({ url, label: p!.name });
    }
  }

  function openTool(tool: Tool) {
    const init: Record<string, string> = {};
    for (const i of tool.inputs) if (i.type === "select" && i.options?.length) init[i.name] = i.options[0];
    setParams(init);
    setActive(tool);
  }

  async function runTool() {
    if (!active || !selected) return;
    const tool = active;
    setBusy(true);
    try {
      const asset = await api.runTool({ tool_id: tool.id, source_image_url: selected.url, params, product_id: productId || undefined });
      setResults((prev) => [asset, ...prev]);
      const url = assetUrl(asset);
      if (asset.status === "done" && url) {
        setSelected({ url, label: tool.label, sub: Object.values(params).filter(Boolean).join(" · "), disclaimer: tool.disclaimer });
      }
      setActive(null);
    } finally {
      setBusy(false);
    }
  }

  const canRun = active?.inputs.every((i) => !i.required || (params[i.name] || "").trim().length > 0) ?? false;
  const strip = [
    ...(source ? [{ key: "src", failed: false, url: source, label: "Source" }] : []),
    ...results.map((a) => ({
      key: a.id,
      failed: a.status !== "done",
      url: assetUrl(a) || undefined,
      label: tools.find((t) => t.id === a.template_id.replace("tool:", ""))?.label ?? a.template_id,
    })),
  ];

  return (
    <div className="h-screen flex flex-col">
      <header className="h-14 shrink-0 px-6 border-b border-border bg-surface flex items-center justify-between">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Image tools</h1>
        <div className="flex items-center gap-2">
          <select
            className="rounded-md border border-border bg-surface px-2.5 h-9 text-[13px] max-w-[220px]"
            value={productId}
            onChange={(e) => useProductPhoto(e.target.value)}
            title="Use a product's main photo"
          >
            <option value="">Pick a product photo…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-md bg-primary text-white text-[13px] font-medium px-3 h-9 hover:bg-primary-hover">
            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {source ? "Replace photo" : "Upload photo"}
          </label>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_300px]">
        {/* Canvas */}
        <section className="min-h-0 flex flex-col bg-sunken">
          <div className="flex-1 min-h-0 flex items-center justify-center p-6">
            {!selected ? (
              <label className="cursor-pointer w-full max-w-xl rounded-2xl border-2 border-dashed border-border bg-surface flex flex-col items-center justify-center gap-3 py-24 text-muted hover:border-primary transition-colors">
                <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                <span className="text-sm">{uploading ? "Uploading…" : "Upload a product photo (or pick a product above) to begin"}</span>
              </label>
            ) : (
              <div className="relative max-h-full max-w-full">
                <div className="absolute top-3 left-3 z-10 flex gap-2">
                  <span className="rounded-full bg-surface/90 backdrop-blur px-3 py-1 text-xs font-medium shadow-sm">{selected.label}</span>
                  {selected.sub && <span className="rounded-full bg-surface/90 backdrop-blur px-3 py-1 text-xs text-muted shadow-sm">{selected.sub}</span>}
                </div>
                <img src={selected.url} alt={selected.label} className="max-h-[70vh] max-w-full rounded-xl shadow-lg object-contain" />
                {busy && (
                  <div className="absolute inset-0 rounded-xl bg-black/40 flex items-center justify-center text-white gap-2 text-sm">
                    <Loader2 className="animate-spin" size={18} /> Rendering…
                  </div>
                )}
              </div>
            )}
          </div>

          {selected && (
            <div className="shrink-0 border-t border-border bg-surface">
              {selected.disclaimer && (
                <div className="px-4 pt-2 text-[11px] text-faint flex items-start gap-1.5">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {selected.disclaimer}
                </div>
              )}
              <div className="flex items-center gap-2 px-4 py-2">
                <a href={selected.url} download className="flex items-center gap-1.5 text-sm rounded-lg border border-border px-3 py-1.5 hover:bg-sunken">
                  <Download size={15} /> Download
                </a>
                {selected.url !== source && (
                  <button
                    onClick={() => setSource(selected.url)}
                    className="flex items-center gap-1.5 text-sm rounded-lg border border-border px-3 py-1.5 hover:bg-sunken"
                    title="Continue editing from this result"
                  >
                    <CornerUpLeft size={15} /> Use as source
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2 overflow-x-auto max-w-[60%]">
                  {strip.map((t) => {
                    const isSel = !!t.url && selected.url === t.url;
                    const cls = `shrink-0 size-12 rounded-lg overflow-hidden border-2 ${isSel ? "border-primary" : "border-border"}`;
                    if (t.failed || !t.url) {
                      return (
                        <div key={t.key} className={`${cls} bg-sunken flex items-center justify-center`} title={`${t.label} — failed`}>
                          <AlertTriangle size={15} className="text-primary" />
                        </div>
                      );
                    }
                    return (
                      <button key={t.key} onClick={() => setSelected({ url: t.url!, label: t.label })} className={cls} title={t.label}>
                        <img src={t.url} alt={t.label} className="size-full object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Tools rail */}
        <aside className="min-h-0 border-l border-border bg-surface overflow-y-auto">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Directed edits</h2>
            <p className="text-[11px] text-muted mt-0.5">Applied to the image in the canvas. Also callable by your agent via /api/v1.</p>
          </div>
          {grouped.map(({ cat, items }) => (
            <div key={cat} className="px-2 py-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{CATEGORY_LABEL[cat]}</div>
              {items.map((tool) => {
                const Icon = ICONS[tool.icon] ?? Sparkles;
                const needsFal = !!tool.requiresFal && health !== null && !health.fal;
                return (
                  <button
                    key={tool.id}
                    disabled={!selected || needsFal}
                    onClick={() => openTool(tool)}
                    title={needsFal ? "Requires FAL_API_KEY — set it in the app environment" : tool.description}
                    className="w-full flex items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-sunken disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Icon size={18} className="text-primary mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {tool.label}
                        {needsFal && <span className="ml-1.5 text-[10px] text-faint font-normal">needs FAL key</span>}
                      </span>
                      <span className="block text-[11px] text-muted line-clamp-1">{tool.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
      </div>

      {/* Param panel */}
      {active && (
        <div className="fixed inset-0 bg-black/30 z-20 flex items-end sm:items-center justify-center p-4" onClick={() => !busy && setActive(null)}>
          <div className="bg-surface rounded-2xl border border-border w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              {(() => {
                const Icon = ICONS[active.icon] ?? Sparkles;
                return <Icon size={18} className="text-primary" />;
              })()}
              <h3 className="font-semibold">{active.label}</h3>
            </div>
            <p className="text-sm text-muted mt-1">{active.description}</p>

            <div className="mt-4 space-y-3">
              {active.inputs.map((input) => (
                <div key={input.name}>
                  <label className="text-xs font-medium text-muted">{input.label}</label>
                  {input.type === "select" ? (
                    <select
                      className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                      value={params[input.name] ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, [input.name]: e.target.value }))}
                    >
                      {input.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                      placeholder={input.placeholder}
                      value={params[input.name] ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, [input.name]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
              {active.inputs.length === 0 && <p className="text-sm text-muted">No options — just run it.</p>}
            </div>

            {active.disclaimer && (
              <p className="mt-3 text-[11px] text-faint flex gap-1.5">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                {active.disclaimer}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button className="px-3 py-2 text-sm text-muted" onClick={() => !busy && setActive(null)}>
                Cancel
              </button>
              <button
                disabled={!canRun || busy}
                onClick={runTool}
                className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 flex items-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {busy ? "Rendering…" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
