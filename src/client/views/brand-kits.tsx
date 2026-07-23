import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { api, parseJson, type BrandKit, type BrandColors, type BrandFonts } from "../api";
import { Card, Zone, Eyebrow, Chip, PrimaryButton, SecondaryButton, Field, TextInput, TextArea, EmptyState } from "../ui";

const DEFAULT_COLORS: Required<BrandColors> = { primary: "#1A202C", secondary: "#475569", accent: "#DD5164", background: "#F8F9FA" };
const DEFAULT_FONTS: Required<BrandFonts> = { heading: "Inter", body: "Inter" };

type Draft = {
  id?: string;
  name: string;
  colors: Required<BrandColors>;
  fonts: Required<BrandFonts>;
  tone: string;
  notes: string;
};

function emptyDraft(): Draft {
  return { name: "", colors: { ...DEFAULT_COLORS }, fonts: { ...DEFAULT_FONTS }, tone: "", notes: "" };
}

function toDraft(k: BrandKit): Draft {
  return {
    id: k.id,
    name: k.name,
    colors: { ...DEFAULT_COLORS, ...parseJson<BrandColors>(k.colors, {}) },
    fonts: { ...DEFAULT_FONTS, ...parseJson<BrandFonts>(k.fonts, {}) },
    tone: k.tone,
    notes: k.notes,
  };
}

export function BrandKitsView() {
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => api.listBrandKits().then(setKits).catch(() => setKits([]));
  useEffect(() => {
    reload();
  }, []);

  async function save() {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      const body = { name: draft.name.trim(), colors: draft.colors, fonts: draft.fonts, tone: draft.tone, notes: draft.notes };
      if (draft.id) await api.updateBrandKit(draft.id, body);
      else await api.createBrandKit(body);
      setDraft(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="h-14 px-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Brand kits</h1>
        <PrimaryButton onClick={() => setDraft(emptyDraft())}>
          <Plus size={14} /> New brand kit
        </PrimaryButton>
      </header>

      <div className="p-6 max-w-[1000px]">
        <p className="text-[13px] text-muted mb-4">
          Every generation reads from the product's brand kit — colors and fonts style the image stack, the tone steers the copy.
        </p>

        {kits && kits.length === 0 && !draft && (
          <EmptyState action={<SecondaryButton onClick={() => setDraft(emptyDraft())}><Plus size={14} /> Create your first kit</SecondaryButton>}>
            No brand kits yet. A kit is the voice and visual system your listings are generated with.
          </EmptyState>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {(kits || []).map((k) => {
            const d = toDraft(k);
            return (
              <Card key={k.id}>
                <Zone first>
                  <Eyebrow>Brand</Eyebrow>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[15px] font-semibold">{k.name}</div>
                      <div className="mt-1 flex gap-1.5 flex-wrap">
                        <Chip>{d.fonts.heading}</Chip>
                        {d.fonts.body !== d.fonts.heading && <Chip>{d.fonts.body}</Chip>}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button className="p-1.5 rounded-md text-muted hover:bg-sunken" title="Edit" onClick={() => setDraft(d)}>
                        <Pencil size={14} />
                      </button>
                      <button
                        className="p-1.5 rounded-md text-danger hover:bg-danger-tint"
                        title="Delete"
                        onClick={async () => {
                          await api.deleteBrandKit(k.id);
                          reload();
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </Zone>
                <Zone>
                  <Eyebrow>Palette</Eyebrow>
                  <div className="flex gap-2">
                    {(["primary", "secondary", "accent", "background"] as const).map((c) => (
                      <div key={c} className="flex-1">
                        <div className="h-9 rounded-md border border-border" style={{ background: d.colors[c] }} />
                        <div className="mt-1 text-[11px] text-faint">{c}</div>
                      </div>
                    ))}
                  </div>
                </Zone>
                {k.tone && (
                  <Zone>
                    <Eyebrow>Tone</Eyebrow>
                    <p className="text-[13px] text-muted line-clamp-2">{k.tone}</p>
                  </Zone>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* Editor */}
      {draft && (
        <div className="fixed inset-0 bg-black/30 z-20 flex items-center justify-center p-4" onClick={() => !busy && setDraft(null)}>
          <div className="bg-surface rounded-xl border border-border w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-border">
              <Eyebrow>{draft.id ? "Edit brand kit" : "New brand kit"}</Eyebrow>
              <Field label="NAME">
                <TextInput
                  value={draft.name}
                  autoFocus
                  placeholder="Acme Home Goods"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
            </div>
            <div className="p-5 border-b border-border">
              <Eyebrow>Colors</Eyebrow>
              <div className="grid grid-cols-2 gap-3">
                {(["primary", "secondary", "accent", "background"] as const).map((c) => (
                  <Field key={c} label={c.toUpperCase()}>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={draft.colors[c]}
                        onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, [c]: e.target.value } })}
                        className="h-9 w-10 rounded-md border border-border bg-surface cursor-pointer"
                      />
                      <TextInput
                        value={draft.colors[c]}
                        onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, [c]: e.target.value } })}
                      />
                    </div>
                  </Field>
                ))}
              </div>
            </div>
            <div className="p-5 border-b border-border">
              <Eyebrow>Fonts (web-safe or Google Fonts)</Eyebrow>
              <div className="grid grid-cols-2 gap-3">
                <Field label="HEADING">
                  <TextInput
                    value={draft.fonts.heading}
                    placeholder="Poppins"
                    onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: e.target.value } })}
                  />
                </Field>
                <Field label="BODY">
                  <TextInput
                    value={draft.fonts.body}
                    placeholder="Inter"
                    onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, body: e.target.value } })}
                  />
                </Field>
              </div>
            </div>
            <div className="p-5">
              <div className="space-y-3">
                <Field label="TONE OF VOICE">
                  <TextArea
                    rows={2}
                    value={draft.tone}
                    placeholder="Warm, direct, no hype. Talks like a helpful friend who knows the category."
                    onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                  />
                </Field>
                <Field label="NOTES">
                  <TextArea
                    rows={2}
                    value={draft.notes}
                    placeholder="Anything the copywriter should always respect."
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  />
                </Field>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <SecondaryButton onClick={() => setDraft(null)}>Cancel</SecondaryButton>
                <PrimaryButton busy={busy} disabled={!draft.name.trim()} onClick={save}>
                  {draft.id ? "Save changes" : "Create kit"}
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
