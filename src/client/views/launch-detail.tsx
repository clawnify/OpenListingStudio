import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Copy, Check, RefreshCw, ImageIcon, Quote, Loader2, Wand2, Play } from "lucide-react";
import { api, assetUrl, parseJson, type Launch, type LaunchInsights, type ListingCopy, type Asset, type Insight } from "../api";
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

function InsightList({ label, items }: { label: string; items: Insight[] }) {
  if (!items.length) return null;
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <ul className="space-y-2.5">
        {items.map((i, idx) => (
          <li key={idx} className="text-[13px]">
            <span className="font-medium">{i.point}</span>
            {i.quote && (
              <div className="mt-1 flex gap-1.5 text-muted">
                <Quote size={12} className="shrink-0 mt-0.5 text-faint" />
                <span className="italic">&ldquo;{i.quote}&rdquo;</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LaunchDetailView() {
  const { id = "" } = useParams();
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [copy, setCopy] = useState<ListingCopy>(EMPTY_COPY);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [rendering, setRendering] = useState<Set<string>>(new Set());
  const generateFired = useRef(false);

  const load = useCallback(async () => {
    const l = await api.getLaunch(id);
    setLaunch(l);
    const c = parseJson<ListingCopy | null>(l.listing_copy, null);
    if (c) setCopy({ ...c, bullets: [...c.bullets, "", "", "", "", ""].slice(0, 5) });
    return l;
  }, [id]);

  // On mount: load; if newly created (`generating`, no copy yet), fire the
  // in-request text generation once, then reload.
  useEffect(() => {
    generateFired.current = false;
    (async () => {
      const l = await load();
      if (l.status === "generating" && !generateFired.current) {
        generateFired.current = true;
        await api.generateLaunch(id).catch(() => {});
        await load();
      }
    })();
  }, [id, load]);

  async function saveCopy() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveCopy(id, copy);
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

  if (!launch) return <div className="p-6 text-[13px] text-muted">Loading…</div>;

  const insights = parseJson<LaunchInsights | null>(launch.insights, null);
  const assets = launch.assets || [];
  const doneCount = assets.filter((a) => a.status === "done").length;
  const generating = launch.status === "generating";
  const fullText = [
    `TITLE\n${copy.title}`,
    `BULLETS\n${copy.bullets.map((b) => `• ${b}`).join("\n")}`,
    `DESCRIPTION\n${copy.description}`,
    `BACKEND KEYWORDS\n${copy.backend_keywords}`,
  ].join("\n\n");

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
              await api.generateLaunch(id);
              await load();
            }}
            title="Re-run insights + copy generation"
          >
            <RefreshCw size={14} /> {generating ? "Generating…" : "Regenerate"}
          </PrimaryButton>
        </div>
      </header>

      {generating && (
        <div className="px-6 py-3 bg-warning-tint text-warning text-[13px] flex items-center gap-2 border-b border-border">
          <Loader2 size={14} className="animate-spin" /> Extracting review insights and writing the listing copy…
        </div>
      )}

      <div className="p-6 grid gap-5 xl:grid-cols-[400px_1fr] max-w-[1400px]">
        {/* Insights */}
        <Card className="self-start">
          <Zone first>
            <div className="flex items-center justify-between">
              <Eyebrow>Review insights</Eyebrow>
              {insights &&
                (insights.source === "reviews" ? (
                  <Badge tone="success">grounded in reviews</Badge>
                ) : (
                  <Badge tone="warning">AI-estimated · no reviews</Badge>
                ))}
            </div>
            {!insights ? (
              <p className="text-[13px] text-muted">Insights appear here after generation.</p>
            ) : (
              <div className="space-y-5">
                <InsightList label="Pains" items={insights.pains} />
                <InsightList label="Desires" items={insights.desires} />
                <InsightList label="Objections" items={insights.objections} />
                <InsightList label="Customer vocabulary" items={insights.vocabulary} />
                {insights.source === "reviews" && (
                  <p className="text-[11px] text-faint">Every quote is verbatim customer text, verified against the stored reviews.</p>
                )}
              </div>
            )}
          </Zone>
        </Card>

        <div className="space-y-5 min-w-0">
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
                    <TextInput value={copy.title} onChange={(e) => setCopy({ ...copy, title: e.target.value })} />
                    <CopyBtn text={copy.title} />
                  </div>
                </Field>
                {copy.bullets.map((b, i) => (
                  <Field key={i} label={`BULLET ${i + 1}`} meta={counter(b.length, 250)}>
                    <div className="flex gap-1 items-start">
                      <TextArea
                        rows={2}
                        value={b}
                        onChange={(e) => setCopy({ ...copy, bullets: copy.bullets.map((x, j) => (j === i ? e.target.value : x)) })}
                      />
                      <CopyBtn text={b} />
                    </div>
                  </Field>
                ))}
                <Field label="DESCRIPTION" meta={counter(copy.description.length, 2000)}>
                  <div className="flex gap-1 items-start">
                    <TextArea rows={6} value={copy.description} onChange={(e) => setCopy({ ...copy, description: e.target.value })} />
                    <CopyBtn text={copy.description} />
                  </div>
                </Field>
                <Field label="BACKEND KEYWORDS" meta={counter(bytes(copy.backend_keywords), 249, " bytes")}>
                  <div className="flex gap-1 items-start">
                    <TextArea rows={2} value={copy.backend_keywords} onChange={(e) => setCopy({ ...copy, backend_keywords: e.target.value })} />
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
                              {a.template_id === "main_image" ? "Main image concept" : a.template_id.replace(/_/g, " ")}
                            </span>
                            {statusBadge(a.status)}
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <Chip>{a.size_label}</Chip>
                            <div className="flex items-center gap-1">
                              {url && (
                                <a href={url} download className="text-[11px] text-muted hover:underline">
                                  download
                                </a>
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
