import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, type Product, type BrandKit } from "../api";
import { Card, Zone, Eyebrow, Chip, PrimaryButton, SecondaryButton, Field, TextInput, PreviewBanner, EmptyState } from "../ui";

// Sample rows shown when the library is empty — the "Just a preview" convention.
const SAMPLE_ROWS = [
  { name: "Insulated Steel Water Bottle 32oz", category: "Kitchen & Dining", asin: "B0SAMPLE01", reviews: 48, launches: 2 },
  { name: "Bamboo Cutting Board Set (3-Piece)", category: "Kitchen & Dining", asin: "B0SAMPLE02", reviews: 31, launches: 1 },
  { name: "Ergonomic Memory-Foam Seat Cushion", category: "Home & Office", asin: "B0SAMPLE03", reviews: 87, launches: 3 },
];

export function ProductsView() {
  const nav = useNavigate();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", category: "", asin: "", brand_kit_id: "" });

  useEffect(() => {
    api.listProducts().then(setProducts).catch(() => setProducts([]));
    api.listBrandKits().then(setKits).catch(() => {});
  }, []);

  async function create() {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProduct({
        name: draft.name.trim(),
        category: draft.category,
        asin: draft.asin || undefined,
        brand_kit_id: draft.brand_kit_id || undefined,
      });
      nav(`/products/${p.id}`);
    } finally {
      setBusy(false);
    }
  }

  const empty = products !== null && products.length === 0;
  const kitName = (id: string) => kits.find((k) => k.id === id)?.name;

  return (
    <div>
      <header className="h-14 px-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Products</h1>
        <PrimaryButton onClick={() => setCreating(true)}>
          <Plus size={14} /> Add product
        </PrimaryButton>
      </header>

      <div className="p-6 max-w-[1100px]">
        {empty && <PreviewBanner />}

        <Card>
          <Zone first className="!p-0">
            <div className="px-5 pt-5 pb-3">
              <Eyebrow>
                Product library · {empty ? `${SAMPLE_ROWS.length} sample` : `${products?.length ?? 0}`}
              </Eyebrow>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-sunken text-muted text-[12px] font-semibold tracking-[0.04em] text-left">
                  <th className="px-5 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Brand kit</th>
                  <th className="px-3 py-2.5">ASIN</th>
                  <th className="px-3 py-2.5 text-right">Reviews</th>
                  <th className="px-5 py-2.5 text-right">Launches</th>
                </tr>
              </thead>
              <tbody>
                {empty
                  ? SAMPLE_ROWS.map((r) => (
                      <tr key={r.asin} className="border-t border-border text-faint">
                        <td className="px-5 py-2.5">
                          {r.name} <Chip className="ml-1">sample</Chip>
                        </td>
                        <td className="px-3 py-2.5">—</td>
                        <td className="px-3 py-2.5 tabular-nums">{r.asin}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{r.reviews}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{r.launches}</td>
                      </tr>
                    ))
                  : (products || []).map((p) => (
                      <tr
                        key={p.id}
                        className="border-t border-border hover:bg-sunken cursor-pointer"
                        onClick={() => nav(`/products/${p.id}`)}
                      >
                        <td className="px-5 py-2.5 font-medium">
                          {p.name}
                          {p.category && <span className="ml-2 text-[11px] text-faint">{p.category}</span>}
                        </td>
                        <td className="px-3 py-2.5">{kitName(p.brand_kit_id) ? <Chip>{kitName(p.brand_kit_id)}</Chip> : <span className="text-faint">—</span>}</td>
                        <td className="px-3 py-2.5 tabular-nums text-muted">{p.asin || "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{p.review_count ?? 0}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{p.launch_count ?? 0}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {empty && (
              <EmptyState action={<SecondaryButton onClick={() => setCreating(true)}><Plus size={14} /> Add your first product</SecondaryButton>}>
                The rows above are sample data. Add a product, pull in its reviews, and run your first launch.
              </EmptyState>
            )}
          </Zone>
        </Card>
      </div>

      {creating && (
        <div className="fixed inset-0 bg-black/30 z-20 flex items-center justify-center p-4" onClick={() => !busy && setCreating(false)}>
          <div className="bg-surface rounded-xl border border-border w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <Eyebrow>New product</Eyebrow>
            <div className="space-y-3">
              <Field label="NAME">
                <TextInput autoFocus placeholder="Insulated Steel Water Bottle 32oz" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="CATEGORY">
                <TextInput placeholder="Kitchen & Dining" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              </Field>
              <Field label="ASIN (OPTIONAL)">
                <TextInput placeholder="B0XXXXXXXX" value={draft.asin} onChange={(e) => setDraft({ ...draft, asin: e.target.value })} />
              </Field>
              <Field label="BRAND KIT">
                <select
                  className="w-full rounded-md border border-border bg-surface px-2.5 h-9 text-[13px]"
                  value={draft.brand_kit_id}
                  onChange={(e) => setDraft({ ...draft, brand_kit_id: e.target.value })}
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
            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton onClick={() => setCreating(false)}>Cancel</SecondaryButton>
              <PrimaryButton busy={busy} disabled={!draft.name.trim()} onClick={create}>
                Create product
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
