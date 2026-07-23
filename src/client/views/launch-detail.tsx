import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  RefreshCw,
  ImageIcon,
  Loader2,
  Wand2,
  Play,
  Download,
  Circle,
  CircleCheck,
  CircleX,
  ScanEye,
} from "lucide-react";
import {
  api,
  assetUrl,
  parseJson,
  parseInsights,
  parsePhotos,
  type Launch,
  type LaunchInsights,
  type LaunchStep,
  type ListingCopy,
  type Asset,
  type AssetQa,
  type Product,
} from "../api";
import { Card, Zone, Eyebrow, Chip, Badge, PrimaryButton, SecondaryButton, Field, TextInput, TextArea, statusBadge, counter } from "../ui";

const EMPTY_COPY: ListingCopy = { title: "", bullets: ["", "", "", "", ""], description: "", backend_keywords: "" };

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="p-1.5 rounded-md text-muted hover:bg-sunken"
      title="Copy to clipboard"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={13} strokeWidth={2.5} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

// ── Client-side exports (CSV / JSON) ─────────────────────────────────

function downloadBlob(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = Array.isArray(v) ? v.join(" | ") : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

function ExportButtons({ name, rows }: { name: string; rows: Array<Record<string, unknown>> }) {
  if (!rows.length) return null;
  return (
    <div className="flex items-center gap-1">
      <button
        className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
        onClick={() => downloadBlob(`${name}.csv`, "text/csv", toCsv(rows))}
      >
        <Download size={11} /> CSV
      </button>
      <span className="text-faint text-[11px]">·</span>
      <button
        className="text-[11px] text-muted hover:text-foreground"
        onClick={() => downloadBlob(`${name}.json`, "application/json", JSON.stringify(rows, null, 2))}
      >
        JSON
      </button>
    </div>
  );
}

// ── Agentic workflow timeline ────────────────────────────────────────

function StepIcon({ status }: { status: LaunchStep["status"] }) {
  if (status === "done") return <CircleCheck size={16} className="text-success" />;
  if (status === "failed") return <CircleX size={16} className="text-danger" />;
  if (status === "active") return <Loader2 size={16} className="animate-spin text-warning" />;
  return <Circle size={16} className="text-faint" />;
}

function Timeline({ steps }: { steps: LaunchStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => (
        <li key={s.step} className="relative pl-7 pb-4 last:pb-0">
          {i < steps.length - 1 && <span className="absolute left-[7px] top-5 bottom-0 w-px bg-border" />}
          <span className="absolute left-0 top-0.5">
            <StepIcon status={s.status} />
          </span>
          <div className={`text-[13px] font-medium ${s.status === "pending" ? "text-faint" : ""}`}>{s.label}</div>
          {s.meta.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {s.meta.map((m) => (
                <Chip key={m}>{m}</Chip>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Before / after compare slider (optimize kind) ────────────────────

function CompareSlider({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="relative rounded-md overflow-hidden border border-border select-none aspect-square bg-sunken">
      <img src={before} className="absolute inset-0 size-full object-contain" draggable={false} />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={after} className="absolute inset-0 size-full object-contain bg-sunken" draggable={false} />
      </div>
      <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow" style={{ left: `${pos}%` }} />
      <span className="absolute top-2 left-2 rounded-full bg-surface/90 px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em]">AFTER</span>
      <span className="absolute top-2 right-2 rounded-full bg-surface/90 px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em]">BEFORE</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-x-0 bottom-0 top-0 w-full opacity-0 cursor-ew-resize"
        aria-label="Drag to compare before and after"
      />
      <span className="absolute bottom-1.5 inset-x-0 text-center text-[10px] tracking-[0.08em] text-muted">DRAG TO COMPARE</span>
    </div>
  );
}

// ── Insight tables ───────────────────────────────────────────────────

const sentimentTone = { positive: "success", negative: "danger", neutral: "neutral" } as const;

function JourneyBadge({ j }: { j: "pre_purchase" | "post_purchase" }) {
  return <Badge tone={j === "pre_purchase" ? "warning" : "neutral"}>{j === "pre_purchase" ? "Pre-Purchase" : "Post-Purchase"}</Badge>;
}

function InsightTables({ insights }: { insights: LaunchInsights }) {
  const [openQuotes, setOpenQuotes] = useState<number | null>(null);
  return (
    <Card>
      <Zone first>
        <div className="flex items-center justify-between">
          <Eyebrow>Review insights · {insights.review_insights.length}</Eyebrow>
          <div className="flex items-center gap-3">
            {insights.source === "reviews" ? (
              <Badge tone="success">grounded in reviews</Badge>
            ) : (
              <Badge tone="warning">AI-estimated · no reviews</Badge>
            )}
            <ExportButtons name="review-insights" rows={insights.review_insights as unknown as Array<Record<string, unknown>>} />
          </div>
        </div>
        {insights.review_insights.length === 0 ? (
          <p className="text-[13px] text-muted">No review insights yet.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-muted text-[12px] font-semibold tracking-[0.04em] text-left border-b border-border">
                <th className="py-2 pr-2 w-8">#</th>
                <th className="py-2 pr-2">Reviews</th>
                <th className="py-2 pr-2">Review insight</th>
                <th className="py-2 pr-2">Sentiment</th>
                <th className="py-2 pr-2">Journey</th>
                <th className="py-2 text-right">Reliability</th>
              </tr>
            </thead>
            <tbody>
              {insights.review_insights.map((r, i) => (
                <>
                  <tr
                    key={i}
                    className="border-b border-border last:border-b-0 hover:bg-sunken cursor-pointer"
                    onClick={() => setOpenQuotes(openQuotes === i ? null : i)}
                    title={r.quotes.length ? "Click to see the verbatim quotes" : undefined}
                  >
                    <td className="py-2.5 pr-2 text-faint tabular-nums">{i + 1}</td>
                    <td className="py-2.5 pr-2">
                      <Chip>{r.review_count}x</Chip>
                    </td>
                    <td className="py-2.5 pr-2 font-medium">{r.insight}</td>
                    <td className="py-2.5 pr-2">
                      <Badge tone={sentimentTone[r.sentiment]}>{r.sentiment}</Badge>
                    </td>
                    <td className="py-2.5 pr-2">
                      <JourneyBadge j={r.journey} />
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{r.reliability}%</td>
                  </tr>
                  {openQuotes === i && r.quotes.length > 0 && (
                    <tr key={`q${i}`} className="border-b border-border last:border-b-0 bg-sunken">
                      <td />
                      <td colSpan={5} className="py-2 pr-2">
                        {r.quotes.map((q, qi) => (
                          <p key={qi} className="text-[12px] text-muted italic py-0.5">
                            &ldquo;{q}&rdquo;
                          </p>
                        ))}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </Zone>

      {insights.product_features.length > 0 && (
        <Zone>
          <div className="flex items-center justify-between">
            <Eyebrow>Product features · {insights.product_features.length}</Eyebrow>
            <ExportButtons name="product-features" rows={insights.product_features as unknown as Array<Record<string, unknown>>} />
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-muted text-[12px] font-semibold tracking-[0.04em] text-left border-b border-border">
                <th className="py-2 pr-2">Product feature</th>
                <th className="py-2 pr-2">Journey</th>
                <th className="py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {insights.product_features.map((f, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  <td className="py-2.5 pr-2 font-medium">{f.feature}</td>
                  <td className="py-2.5 pr-2">
                    <JourneyBadge j={f.journey} />
                  </td>
                  <td className="py-2.5">
                    <Chip>{f.source}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Zone>
      )}

      {insights.conversion_drivers.length > 0 && (
        <Zone>
          <div className="flex items-center justify-between">
            <Eyebrow>Conversion drivers · {insights.conversion_drivers.length}</Eyebrow>
            <ExportButtons name="conversion-drivers" rows={insights.conversion_drivers as unknown as Array<Record<string, unknown>>} />
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-muted text-[12px] font-semibold tracking-[0.04em] text-left border-b border-border">
                <th className="py-2 pr-2 w-20">Relevance</th>
                <th className="py-2 pr-2">Conversion driver</th>
                <th className="py-2 pr-2">Kind</th>
                <th className="py-2">Journey</th>
              </tr>
            </thead>
            <tbody>
              {insights.conversion_drivers.map((d, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  <td className="py-2.5 pr-2 tabular-nums text-muted">#{d.relevance}</td>
                  <td className="py-2.5 pr-2 font-medium">{d.driver}</td>
                  <td className="py-2.5 pr-2">
                    <Badge tone={d.kind === "driver" ? "success" : "danger"}>{d.kind}</Badge>
                  </td>
                  <td className="py-2.5">
                    <JourneyBadge j={d.journey} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Zone>
      )}
    </Card>
  );
}

// ── The view ─────────────────────────────────────────────────────────

export function LaunchDetailView() {
  const { id = "" } = useParams();
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [copy, setCopy] = useState<ListingCopy>(EMPTY_COPY);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [rendering, setRendering] = useState<Set<string>>(new Set());
  const [qaBusy, setQaBusy] = useState<Set<string>>(new Set());
  const generateFired = useRef(false);
  const autoRendered = useRef(false);
  const copyDirty = useRef(false); // user has unsaved edits — polling must not clobber them

  const load = useCallback(async () => {
    const l = await api.getLaunch(id);
    setLaunch(l);
    const c = parseJson<ListingCopy | null>(l.listing_copy, null);
    if (c && !copyDirty.current) setCopy({ ...c, bullets: [...c.bullets, "", "", "", "", ""].slice(0, 5) });
    return l;
  }, [id]);

  function editCopy(next: ListingCopy) {
    copyDirty.current = true;
    setCopy(next);
  }

  // On mount: load; if newly created (`generating`, no copy yet), fire the
  // in-request text generation once, then reload.
  useEffect(() => {
    generateFired.current = false;
    autoRendered.current = false;
    (async () => {
      const l = await load();
      api.getProduct(l.product_id).then(setProduct).catch(() => {});
      if (l.status === "generating" && !generateFired.current) {
        generateFired.current = true;
        await api.generateLaunch(id).catch(() => {});
        await load();
      }
    })();
  }, [id, load]);

  // Live polling: while the launch is generating or any asset is still
  // pending/rendering, refresh every 3s so the timeline + asset grid animate
  // without manual reloads (the server's stale guard resolves stuck renders).
  const active =
    !!launch &&
    (launch.status === "generating" ||
      (launch.assets || []).some((a) => a.status === "pending" || a.status === "rendering"));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      load().catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  // The render pattern is client-driven (pending rows + per-asset POST): once
  // generation lands a fresh, fully-unrendered stack, fire the renders
  // automatically in parallel — no manual "Render all" needed.
  useEffect(() => {
    if (!launch || autoRendered.current) return;
    const assets = launch.assets || [];
    if (launch.status === "ready" && assets.length > 0 && assets.every((a) => a.status === "pending")) {
      autoRendered.current = true;
      renderAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch]);

  async function saveCopy() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveCopy(id, copy);
      copyDirty.current = false;
      setSaveMsg("Saved — copy passes Amazon limits.");
      await load();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function renderOne(asset: Asset) {
    setRendering((s) => new Set(s).add(asset.id));
    try {
      await api.renderAsset(asset.id);
    } finally {
      setRendering((s) => {
        const n = new Set(s);
        n.delete(asset.id);
        return n;
      });
      await load();
    }
  }

  // Render the whole stack in parallel — each asset renders in its own request.
  async function renderAll() {
    const targets = (launch?.assets || []).filter((a) => a.status !== "done");
    setRendering(new Set(targets.map((a) => a.id)));
    await Promise.allSettled(targets.map((a) => api.renderAsset(a.id)));
    setRendering(new Set());
    await load();
  }

  async function runQa(asset: Asset) {
    setQaBusy((s) => new Set(s).add(asset.id));
    try {
      await api.qaAsset(asset.id);
    } finally {
      setQaBusy((s) => {
        const n = new Set(s);
        n.delete(asset.id);
        return n;
      });
      await load();
    }
  }

  if (!launch) return <div className="p-6 text-[13px] text-muted">Loading…</div>;

  const insights = parseInsights(launch.insights);
  const steps = parseJson<LaunchStep[]>(launch.steps, []);
  const assets = launch.assets || [];
  const doneCount = assets.filter((a) => a.status === "done").length;
  const generating = launch.status === "generating";
  const fullText = [
    `TITLE\n${copy.title}`,
    `BULLETS\n${copy.bullets.map((b) => `• ${b}`).join("\n")}`,
    `DESCRIPTION\n${copy.description}`,
    `BACKEND KEYWORDS\n${copy.backend_keywords}`,
  ].join("\n\n");

  // Optimize kind: compare the existing listing photo against the first
  // rendered generation.
  const beforePhoto = product ? parsePhotos(product.image_r2_keys).find((p) => p.role === "main") : null;
  const afterAsset = assets.find((a) => a.status === "done" && a.r2_key && a.template_id !== "main_image") || assets.find((a) => a.status === "done" && a.r2_key);
  const showCompare = launch.kind === "optimize" && beforePhoto && afterAsset;

  return (
    <div>
      <header className="h-14 px-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link to={`/products/${launch.product_id}`} className="p-1.5 rounded-md text-muted hover:bg-sunken">
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-[20px] font-bold tracking-[-0.01em] capitalize">{launch.kind}</h1>
          {statusBadge(launch.status)}
          {launch.error && <span className="text-[12px] text-danger truncate max-w-[380px]" title={launch.error}>{launch.error}</span>}
        </div>
        <div className="flex items-center gap-2">
          {launch.status === "ready" && (
            <SecondaryButton onClick={async () => { await api.markExported(id); load(); }}>Mark exported</SecondaryButton>
          )}
          <PrimaryButton
            busy={generating}
            onClick={async () => {
              copyDirty.current = false; // regenerated copy replaces local edits
              autoRendered.current = false;
              await api.generateLaunch(id);
              await load();
            }}
            title="Re-run insights + copy generation"
          >
            <RefreshCw size={14} /> {generating ? "Generating…" : "Regenerate"}
          </PrimaryButton>
        </div>
      </header>

      <div className="p-6 grid gap-5 xl:grid-cols-[340px_1fr] max-w-[1500px]">
        {/* Left rail: workflow timeline + compare — sticky beneath the 56px
            header so progress stays in view while the long content column
            scrolls; scrolls internally if taller than the viewport. */}
        <div className="space-y-5 self-start xl:sticky xl:top-[72px] xl:max-h-[calc(100vh-88px)] xl:overflow-y-auto">
          <Card>
            <Zone first>
              <Eyebrow>Agentic workflow</Eyebrow>
              {steps.length ? (
                <Timeline steps={steps} />
              ) : (
                <p className="text-[13px] text-muted">The workflow timeline appears once generation starts.</p>
              )}
            </Zone>
          </Card>

          {showCompare && (
            <Card>
              <Zone first>
                <Eyebrow>Before / after</Eyebrow>
                <CompareSlider before={`/api/uploads/${beforePhoto!.r2_key}`} after={assetUrl(afterAsset!)!} />
              </Zone>
            </Card>
          )}
        </div>

        <div className="space-y-5 min-w-0">
          {insights && <InsightTables insights={insights} />}

          {/* Copy editor */}
          <Card>
            <Zone first>
              <div className="flex items-center justify-between">
                <Eyebrow>Listing copy</Eyebrow>
                <div className="flex items-center gap-1">
                  <CopyBtn text={fullText} />
                  <span className="text-[11px] text-faint">copy all</span>
                </div>
              </div>
              <div className="space-y-4">
                <Field label="TITLE" meta={counter(copy.title.length, 200)}>
                  <div className="flex gap-1 items-center">
                    <TextInput value={copy.title} onChange={(e) => editCopy({ ...copy, title: e.target.value })} />
                    <CopyBtn text={copy.title} />
                  </div>
                </Field>
                {copy.bullets.map((b, i) => (
                  <Field key={i} label={`BULLET ${i + 1}`} meta={counter(b.length, 250)}>
                    <div className="flex gap-1 items-start">
                      <TextArea
                        rows={2}
                        value={b}
                        onChange={(e) => editCopy({ ...copy, bullets: copy.bullets.map((x, j) => (j === i ? e.target.value : x)) })}
                      />
                      <CopyBtn text={b} />
                    </div>
                  </Field>
                ))}
                <Field label="DESCRIPTION" meta={counter(copy.description.length, 2000)}>
                  <div className="flex gap-1 items-start">
                    <TextArea rows={6} value={copy.description} onChange={(e) => editCopy({ ...copy, description: e.target.value })} />
                    <CopyBtn text={copy.description} />
                  </div>
                </Field>
                <Field label="BACKEND KEYWORDS" meta={counter(bytes(copy.backend_keywords), 249, " bytes")}>
                  <div className="flex gap-1 items-start">
                    <TextArea rows={2} value={copy.backend_keywords} onChange={(e) => editCopy({ ...copy, backend_keywords: e.target.value })} />
                    <CopyBtn text={copy.backend_keywords} />
                  </div>
                </Field>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <SecondaryButton busy={saving} onClick={saveCopy}>
                  Save copy
                </SecondaryButton>
                {saveMsg && <span className="text-[12px] text-muted">{saveMsg}</span>}
              </div>
            </Zone>
          </Card>

          {/* Image stack */}
          <Card>
            <Zone first>
              <div className="flex items-center justify-between">
                <Eyebrow>
                  Image stack · {doneCount} / {assets.length} rendered
                </Eyebrow>
                <div className="flex gap-2">
                  <Link to="/tools" className="inline-flex items-center gap-1.5 rounded-md bg-surface border border-border text-[13px] font-medium px-3 h-8 hover:bg-sunken">
                    <Wand2 size={13} /> Directed edits
                  </Link>
                  <SecondaryButton
                    className="h-8"
                    busy={rendering.size > 0}
                    disabled={assets.length === 0 || generating}
                    onClick={renderAll}
                  >
                    <Play size={13} /> Render all
                  </SecondaryButton>
                </div>
              </div>
              {assets.length === 0 ? (
                <p className="text-[13px] text-muted">The image stack is planned during generation — regenerate to create it.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mt-1">
                  {assets.map((a) => {
                    const url = assetUrl(a);
                    const busy = rendering.has(a.id) || a.status === "rendering";
                    const qa = parseJson<AssetQa | null>(a.qa, null);
                    return (
                      <div key={a.id} className="rounded-md border border-border overflow-hidden">
                        <div className="aspect-square bg-sunken flex items-center justify-center relative">
                          {url ? (
                            <img src={url} className="size-full object-contain" />
                          ) : (
                            <ImageIcon size={22} className="text-faint" />
                          )}
                          {busy && (
                            <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                              <Loader2 size={18} className="animate-spin text-white" />
                            </div>
                          )}
                        </div>
                        <div className="px-3 py-2 border-t border-border">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[12px] font-semibold truncate">
                              {a.template_id === "main_image" ? "Main image concept" : a.template_id.replace(/^tool:/, "").replace(/_/g, " ")}
                            </span>
                            {statusBadge(a.status)}
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <div className="flex items-center gap-1">
                              <Chip>{a.size_label}</Chip>
                              {qa && (
                                <Badge tone={qa.status === "pass" ? "success" : "danger"}>
                                  QA {qa.status}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              {url && (
                                <a href={url} download className="text-[11px] text-muted hover:underline">
                                  download
                                </a>
                              )}
                              {a.status === "done" && (
                                <button
                                  className="p-1 rounded text-muted hover:bg-sunken disabled:opacity-40"
                                  title="Vision QA — check the render against the brand + copy"
                                  disabled={qaBusy.has(a.id)}
                                  onClick={() => runQa(a)}
                                >
                                  {qaBusy.has(a.id) ? <Loader2 size={13} className="animate-spin" /> : <ScanEye size={13} />}
                                </button>
                              )}
                              <button
                                className="p-1 rounded text-muted hover:bg-sunken disabled:opacity-40"
                                title={a.status === "done" ? "Re-render" : "Render"}
                                disabled={busy || generating}
                                onClick={() => renderOne(a)}
                              >
                                <RefreshCw size={13} />
                              </button>
                            </div>
                          </div>
                          {qa?.status === "fail" && qa.issues.length > 0 && (
                            <p className="mt-1 text-[11px] text-danger leading-snug" title={qa.issues.join("\n")}>
                              {qa.issues[0]}
                            </p>
                          )}
                          {a.error && (
                            <p className="mt-1 text-[11px] text-danger leading-snug" title={a.error}>
                              {a.error.slice(0, 120)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Zone>
          </Card>
        </div>
      </div>
    </div>
  );
}
