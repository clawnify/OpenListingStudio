import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Upload, Rocket, Star, Trash2, FileUp, Globe, ClipboardPaste, X, Scissors, Loader2 } from "lucide-react";
import { api, parseJson, parsePhotos, type Product, type BrandKit, type Review, type Launch, type LaunchConfig, type Health, type PhotoRef, type PhotoRole } from "../api";
import { Card, Zone, Eyebrow, Chip, PrimaryButton, SecondaryButton, Field, TextInput, TextArea, EmptyState, statusBadge } from "../ui";

export function ProductDetailView() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchModal, setLaunchModal] = useState<"launch" | "optimize" | null>(null);
  const [config, setConfig] = useState<LaunchConfig>({ image_type: "full", qty: 3, format: "1:1" });
  const [msg, setMsg] = useState<string | null>(null);
  const [featuresText, setFeaturesText] = useState("");
  const csvRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const cutoutRef = useRef<HTMLInputElement>(null);
  const [cutoutBusy, setCutoutBusy] = useState<string | null>(null);
  /** Per-photo flip: show the transparent cutout instead of the raw photo. */
  const [showCutout, setShowCutout] = useState<Record<string, boolean>>({});

  const reload = () => {
    api.getProduct(id).then((p) => {
      setProduct(p);
      setFeaturesText(parseJson<string[]>(p.features, []).join("\n"));
    });
    api.listReviews(id).then(setReviews);
    api.listLaunches(id).then(setLaunches);
  };

  useEffect(() => {
    reload();
    api.listBrandKits().then(setKits).catch(() => {});
    api.health().then(setHealth).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!product) return <div className="p-6 text-[13px] text-muted">Loading…</div>;

  const photos = parsePhotos(product.image_r2_keys);

  function applyPhotos(next: PhotoRef[]) {
    // Optimistic: patch the local product row without a refetch.
    setProduct((p) => (p ? { ...p, image_r2_keys: JSON.stringify(next) } : p));
  }

  async function removePhoto(r2_key: string) {
    applyPhotos(photos.filter((p) => p.r2_key !== r2_key));
    try {
      const { photos: next } = await api.deletePhoto(id, r2_key);
      applyPhotos(next);
    } catch {
      reload();
    }
  }

  async function regenCutout(photo: PhotoRef) {
    setCutoutBusy(photo.r2_key);
    setMsg(null);
    try {
      const { photos: next } = await api.regenerateCutout(id, photo.r2_key);
      applyPhotos(next);
      setShowCutout((s) => ({ ...s, [photo.r2_key]: true }));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCutoutBusy(null);
    }
  }

  async function uploadOwnCutout(photo: PhotoRef, file: File) {
    setCutoutBusy(photo.r2_key);
    setMsg(null);
    try {
      const { photos: next } = await api.uploadCutout(id, photo.r2_key, file);
      applyPhotos(next);
      setShowCutout((s) => ({ ...s, [photo.r2_key]: true }));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCutoutBusy(null);
    }
  }

  const ROLE_CYCLE: PhotoRole[] = ["main", "angle", "detail"];
  async function cycleRole(photo: PhotoRef) {
    const next = ROLE_CYCLE[(ROLE_CYCLE.indexOf(photo.role) + 1) % ROLE_CYCLE.length];
    applyPhotos(photos.map((p) => (p.r2_key === photo.r2_key ? { ...p, role: next } : next === "main" && p.role === "main" ? { ...p, role: "angle" } : p)));
    try {
      const { photos: fresh } = await api.setPhotoRole(id, photo.r2_key, next);
      applyPhotos(fresh);
    } catch {
      reload();
    }
  }

  async function saveDetails(patch: Partial<{ name: string; category: string; asin: string | null; brand_kit_id: string; features: string[] }>) {
    const p = await api.updateProduct(id, patch);
    setProduct(p);
  }

  async function importPaste() {
    if (!pasteText.trim()) return;
    setPasteBusy(true);
    setMsg(null);
    try {
      const { imported } = await api.pasteReviews(id, pasteText);
      setMsg(`Imported ${imported} review${imported === 1 ? "" : "s"} from paste.`);
      setPasteText("");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPasteBusy(false);
    }
  }

  async function importCsv(file: File) {
    setCsvBusy(true);
    setMsg(null);
    try {
      const { imported } = await api.uploadReviewsCsv(id, file);
      setMsg(`Imported ${imported} review${imported === 1 ? "" : "s"} from CSV.`);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCsvBusy(false);
    }
  }

  async function importLive() {
    setLiveBusy(true);
    setMsg(null);
    try {
      const { imported, asin } = await api.importLiveReviews(id);
      setMsg(`Imported ${imported} live review snippet${imported === 1 ? "" : "s"} for ASIN ${asin}.`);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  }

  async function startLaunch() {
    if (!launchModal) return;
    setLaunchBusy(true);
    try {
      const l = await api.createLaunch({ product_id: id, kind: launchModal, config });
      nav(`/launches/${l.id}`);
    } finally {
      setLaunchBusy(false);
    }
  }

  return (
    <div>
      <header className="h-14 px-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/" className="p-1.5 rounded-md text-muted hover:bg-sunken">
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-[20px] font-bold tracking-[-0.01em] truncate">{product.name}</h1>
          {product.asin && <Chip>{product.asin}</Chip>}
        </div>
        <PrimaryButton busy={launchBusy} onClick={() => setLaunchModal("launch")} title="Run the packaged launch workflow">
          <Rocket size={14} /> Launch listing
        </PrimaryButton>
      </header>

      <div className="p-6 grid gap-5 lg:grid-cols-[1fr_380px] max-w-[1250px]">
        <div className="space-y-5 min-w-0">
          {/* Reviews */}
          <Card>
            <Zone first>
              <Eyebrow>
                Reviews · {reviews.length}
              </Eyebrow>
              <div className="flex flex-wrap gap-2 items-start">
                <div className="flex-1 min-w-[260px]">
                  <TextArea
                    rows={3}
                    placeholder={"Paste reviews — one per line, or a free-text dump (the AI splits it verbatim)."}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2 flex-wrap">
                    <SecondaryButton busy={pasteBusy} disabled={!pasteText.trim()} onClick={importPaste}>
                      <ClipboardPaste size={14} /> Import paste
                    </SecondaryButton>
                    <SecondaryButton busy={csvBusy} onClick={() => csvRef.current?.click()}>
                      <FileUp size={14} /> Upload CSV
                    </SecondaryButton>
                    <input
                      ref={csvRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
                    />
                    <SecondaryButton
                      busy={liveBusy}
                      disabled={!health?.reviews_live.ready}
                      title={
                        health?.reviews_live.ready
                          ? "Pull live review snippets from Amazon via SerpAPI"
                          : "Set SERPAPI_API_KEY to enable live Amazon import"
                      }
                      onClick={importLive}
                    >
                      <Globe size={14} /> Import from Amazon {health?.reviews_live.ready ? "" : "(needs key)"}
                    </SecondaryButton>
                  </div>
                  {msg && <p className="mt-2 text-[12px] text-muted">{msg}</p>}
                </div>
              </div>
            </Zone>
            <Zone className="!p-0">
              {reviews.length === 0 ? (
                <EmptyState>No reviews yet. Paste, upload a CSV, or import live — the launch grounds its copy in them.</EmptyState>
              ) : (
                <div className="max-h-[380px] overflow-y-auto">
                  {reviews.map((r) => (
                    <div key={r.id} className="px-5 py-3 border-t border-border first:border-t-0 flex gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {r.rating != null && (
                            <span className="inline-flex items-center gap-0.5 text-[12px] text-warning font-semibold tabular-nums">
                              <Star size={12} fill="currentColor" /> {r.rating}
                            </span>
                          )}
                          {r.title && <span className="text-[13px] font-semibold truncate">{r.title}</span>}
                          <Chip>{r.source}</Chip>
                        </div>
                        <p className="mt-1 text-[13px] text-muted leading-relaxed">{r.body}</p>
                      </div>
                      <button
                        className="self-start p-1.5 rounded-md text-faint hover:text-danger hover:bg-danger-tint"
                        onClick={async () => {
                          await api.deleteReview(r.id);
                          reload();
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </Card>

          {/* Launches */}
          <Card>
            <Zone first>
              <div className="flex items-center justify-between">
                <Eyebrow>Launches · {launches.length}</Eyebrow>
                <SecondaryButton busy={launchBusy} onClick={() => setLaunchModal("optimize")} className="h-8">
                  Optimize existing listing
                </SecondaryButton>
              </div>
              {launches.length === 0 ? (
                <EmptyState>
                  No launches yet. "Launch listing" turns this product's reviews and brand kit into copy, an image stack, and A+
                  modules.
                </EmptyState>
              ) : (
                <div className="divide-y divide-border -mx-5 -mb-5 mt-2">
                  {launches.map((l) => (
                    <Link key={l.id} to={`/launches/${l.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-sunken">
                      <Rocket size={14} className="text-muted" />
                      <span className="text-[13px] font-medium capitalize">{l.kind}</span>
                      {statusBadge(l.status)}
                      <span className="ml-auto text-[12px] text-faint tabular-nums">{l.created_at.slice(0, 16)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Zone>
          </Card>
        </div>

        {/* Right rail: facts + photos */}
        <div className="space-y-5">
          <Card>
            <Zone first>
              <Eyebrow>Details</Eyebrow>
              <div className="space-y-3">
                <Field label="CATEGORY">
                  <TextInput
                    defaultValue={product.category}
                    onBlur={(e) => e.target.value !== product.category && saveDetails({ category: e.target.value })}
                  />
                </Field>
                <Field label="ASIN">
                  <TextInput
                    defaultValue={product.asin || ""}
                    placeholder="B0XXXXXXXX"
                    onBlur={(e) => (e.target.value || null) !== product.asin && saveDetails({ asin: e.target.value || null })}
                  />
                </Field>
                <Field label="BRAND KIT">
                  <select
                    className="w-full rounded-md border border-border bg-surface px-2.5 h-9 text-[13px]"
                    value={product.brand_kit_id}
                    onChange={(e) => saveDetails({ brand_kit_id: e.target.value })}
                  >
                    <option value="">No brand kit</option>
                    {kits.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Zone>
            <Zone>
              <Field label="FEATURES (ONE PER LINE)" meta={`${featuresText.split("\n").filter((f) => f.trim()).length} features`}>
                <TextArea
                  rows={5}
                  value={featuresText}
                  placeholder={"Keeps drinks cold 24h\nBPA-free stainless steel\nFits car cup holders"}
                  onChange={(e) => setFeaturesText(e.target.value)}
                  onBlur={() => saveDetails({ features: featuresText.split("\n").map((f) => f.trim()).filter(Boolean) })}
                />
              </Field>
            </Zone>
          </Card>

          <Card>
            <Zone first>
              <div className="flex items-center justify-between">
                <Eyebrow>Photos · {photos.length}</Eyebrow>
                <SecondaryButton className="h-8" onClick={() => photoRef.current?.click()}>
                  <Upload size={13} /> Upload
                </SecondaryButton>
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      await api.uploadPhoto(id, f);
                      reload();
                    }
                  }}
                />
                <input
                  ref={cutoutRef}
                  type="file"
                  accept="image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const key = cutoutRef.current?.getAttribute("data-photo");
                    const photo = photos.find((x) => x.r2_key === key);
                    const f = e.target.files?.[0];
                    if (photo && f) uploadOwnCutout(photo, f);
                    e.target.value = "";
                  }}
                />
              </div>
              {photos.length === 0 ? (
                <EmptyState>No photos yet. The `main` photo drives the image stack and the directed-edit tools.</EmptyState>
              ) : (
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {photos.map((p) => {
                    const flipped = !!p.cutout_r2_key && !!showCutout[p.r2_key];
                    const busy = cutoutBusy === p.r2_key;
                    return (
                      <div
                        key={p.r2_key}
                        className={`group relative aspect-square rounded-md overflow-hidden border ${p.role === "main" ? "border-primary" : "border-border"}`}
                        // checkerboard behind the cutout so the alpha is visible
                        style={flipped ? { background: "repeating-conic-gradient(#e8ecf1 0% 25%, #ffffff 0% 50%) 0 0 / 14px 14px" } : undefined}
                      >
                        <img
                          src={`/api/uploads/${flipped ? p.cutout_r2_key : p.r2_key}`}
                          className={`size-full ${flipped ? "object-contain" : "object-cover"}`}
                        />
                        {busy && (
                          <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                            <Loader2 size={16} className="animate-spin text-white" />
                          </div>
                        )}
                        <button
                          className="absolute bottom-1 left-1 rounded bg-surface/90 px-1.5 text-[10px] font-semibold hover:bg-surface"
                          title="Click to change role (main → angle → detail)"
                          onClick={() => cycleRole(p)}
                        >
                          {p.role}
                        </button>
                        {p.cutout_r2_key && (
                          <button
                            className={`absolute bottom-1 right-1 rounded px-1.5 text-[10px] font-semibold ${flipped ? "bg-primary text-white" : "bg-surface/90 hover:bg-surface"}`}
                            title={flipped ? "Show the original photo" : "Show the transparent cutout templates composite"}
                            onClick={() => setShowCutout((s) => ({ ...s, [p.r2_key]: !s[p.r2_key] }))}
                          >
                            cutout
                          </button>
                        )}
                        <div className="absolute top-1 left-1 hidden group-hover:flex gap-1">
                          <button
                            className="size-5 rounded-full bg-surface/90 text-muted hover:text-foreground hover:bg-surface flex items-center justify-center"
                            title={health?.fal ? "Regenerate cutout (BiRefNet)" : "Regenerate cutout — needs FAL_API_KEY"}
                            disabled={busy || !health?.fal}
                            onClick={() => regenCutout(p)}
                          >
                            <Scissors size={11} />
                          </button>
                          <button
                            className="size-5 rounded-full bg-surface/90 text-muted hover:text-foreground hover:bg-surface flex items-center justify-center"
                            title="Upload your own transparent cutout (PNG with alpha)"
                            disabled={busy}
                            onClick={() => {
                              cutoutRef.current?.setAttribute("data-photo", p.r2_key);
                              cutoutRef.current?.click();
                            }}
                          >
                            <Upload size={11} />
                          </button>
                        </div>
                        <button
                          className="absolute top-1 right-1 size-5 rounded-full bg-surface/90 text-muted hover:text-danger hover:bg-surface items-center justify-center hidden group-hover:flex"
                          title="Remove photo"
                          onClick={() => removePhoto(p.r2_key)}
                        >
                          <X size={12} strokeWidth={2.5} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Zone>
          </Card>
        </div>
      </div>

      {/* Launch generation config */}
      {launchModal && (
        <div className="fixed inset-0 bg-black/30 z-20 flex items-center justify-center p-4" onClick={() => !launchBusy && setLaunchModal(null)}>
          <div className="bg-surface rounded-xl border border-border w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <Eyebrow>{launchModal === "optimize" ? "Optimize existing listing" : "Launch listing"}</Eyebrow>

            <div className="space-y-4">
              <div>
                <label className="text-[12px] font-semibold tracking-[0.04em] text-muted">IMAGE TYPE</label>
                <div className="mt-1.5 flex gap-1.5">
                  {(
                    [
                      { v: "full", label: "Full stack" },
                      { v: "listing", label: "Listing" },
                      { v: "aplus", label: "A+ Content" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.v}
                      className={`rounded-md border px-3 h-8 text-[13px] font-medium ${
                        config.image_type === t.v ? "border-primary text-primary bg-primary/5" : "border-border text-muted hover:bg-sunken"
                      }`}
                      onClick={() => setConfig({ ...config, image_type: t.v })}
                    >
                      {t.label}
                    </button>
                  ))}
                  <button className="rounded-md border border-border px-3 h-8 text-[13px] text-faint cursor-not-allowed" disabled title="Coming soon">
                    Ads
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] font-semibold tracking-[0.04em] text-muted">QTY (FEED IMAGES)</label>
                  <div className="mt-1.5 flex gap-1.5">
                    {([1, 2, 3] as const).map((q) => (
                      <button
                        key={q}
                        disabled={config.image_type === "aplus"}
                        className={`size-8 rounded-md border text-[13px] font-medium tabular-nums disabled:opacity-40 ${
                          config.qty === q ? "border-primary text-primary bg-primary/5" : "border-border text-muted hover:bg-sunken"
                        }`}
                        onClick={() => setConfig({ ...config, qty: q })}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[12px] font-semibold tracking-[0.04em] text-muted">FORMAT</label>
                  <select
                    className="mt-1.5 w-full rounded-md border border-border bg-surface px-2.5 h-8 text-[13px]"
                    value={config.format}
                    onChange={(e) => setConfig({ ...config, format: e.target.value })}
                  >
                    <option value="1:1">Gallery 1:1</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[12px] font-semibold tracking-[0.04em] text-muted">PRODUCT REFERENCES</label>
                <div className="mt-1.5 flex gap-2">
                  {(["main", "angle", "detail"] as const).map((role) => {
                    const p = photos.find((x) => x.role === role);
                    return (
                      <div key={role} className="flex-1 text-center">
                        <div className={`aspect-square rounded-md border ${p ? "border-border" : "border-dashed border-border"} overflow-hidden bg-sunken flex items-center justify-center`}>
                          {p ? <img src={`/api/uploads/${p.r2_key}`} className="size-full object-cover" /> : <span className="text-[11px] text-faint capitalize">{role}</span>}
                        </div>
                        <span className="text-[10px] text-faint capitalize">{role}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-faint">
                  {photos.length ? `${Math.min(photos.length, 3)}/3 active — set roles on the photos card.` : "No photos yet — the image stack will use a placeholder."}
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton onClick={() => setLaunchModal(null)}>Cancel</SecondaryButton>
              <PrimaryButton busy={launchBusy} onClick={startLaunch}>
                <Rocket size={14} /> Generate
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
