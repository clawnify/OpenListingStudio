import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Upload, Rocket, Star, Trash2, FileUp, Globe, ClipboardPaste } from "lucide-react";
import { api, parseJson, type Product, type BrandKit, type Review, type Launch, type Health } from "../api";
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
  const [msg, setMsg] = useState<string | null>(null);
  const [featuresText, setFeaturesText] = useState("");
  const csvRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

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

  const photos = parseJson<string[]>(product.image_r2_keys, []);

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

  async function startLaunch(kind: "launch" | "optimize") {
    setLaunchBusy(true);
    try {
      const l = await api.createLaunch({ product_id: id, kind });
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
        <PrimaryButton busy={launchBusy} onClick={() => startLaunch("launch")} title="Run the packaged launch workflow">
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
                <SecondaryButton busy={launchBusy} onClick={() => startLaunch("optimize")} className="h-8">
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
              </div>
              {photos.length === 0 ? (
                <EmptyState>No photos yet. The first photo drives the image stack and the directed-edit tools.</EmptyState>
              ) : (
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {photos.map((k, i) => (
                    <div key={k} className={`relative aspect-square rounded-md overflow-hidden border ${i === 0 ? "border-primary" : "border-border"}`}>
                      <img src={`/api/uploads/${k}`} className="size-full object-cover" />
                      {i === 0 && <span className="absolute bottom-1 left-1 rounded bg-surface/90 px-1.5 text-[10px] font-semibold">main</span>}
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </Card>
        </div>
      </div>
    </div>
  );
}
