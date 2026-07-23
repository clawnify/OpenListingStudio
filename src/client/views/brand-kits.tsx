import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Pencil, Upload, X } from "lucide-react";
import { api, parseJson, parseTone, type BrandKit, type BrandColors, type BrandFonts } from "../api";
import { Card, Zone, Eyebrow, Chip, PrimaryButton, SecondaryButton, Field, TextInput, TextArea, EmptyState } from "../ui";

const DEFAULT_COLORS: Required<BrandColors> = { primary: "#1A202C", secondary: "#475569", accent: "#DD5164", background: "#F8F9FA" };
const DEFAULT_FONTS: Required<BrandFonts> = { heading: "Inter", body: "Inter" };
const SUGGESTED_VOICES = ["bold", "punchy", "playful", "direct", "warm", "premium", "technical", "minimal"];

type Draft = {
  id?: string;
  name: string;
  colors: Required<BrandColors>;
  palette: string[];
  fonts: Required<BrandFonts>;
  tone: string[];
  notes: string;
};

function emptyDraft(): Draft {
  return { name: "", colors: { ...DEFAULT_COLORS }, palette: [], fonts: { ...DEFAULT_FONTS }, tone: [], notes: "" };
}

function toDraft(k: BrandKit): Draft {
  const colors = parseJson<BrandColors & { palette?: string[] }>(k.colors, {});
  return {
    id: k.id,
    name: k.name,
    colors: { ...DEFAULT_COLORS, ...colors },
    palette: Array.isArray(colors.palette) ? colors.palette : [],
    fonts: { ...DEFAULT_FONTS, ...parseJson<BrandFonts>(k.fonts, {}) },
    tone: parseTone(k.tone),
    notes: k.notes,
  };
}

function VoiceChipsEditor({ tone, onChange }: { tone: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = (t: string) => {
    const v = t.trim().toLowerCase();
    if (v && !tone.includes(v)) onChange([...tone, v]);
    setInput("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tone.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-sunken border border-border px-2 py-1 text-[12px]">
            {t}
            <button className="text-faint hover:text-danger" onClick={() => onChange(tone.filter((x) => x !== t))}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="rounded-md border border-border bg-surface px-2 h-7 text-[12px] w-28 placeholder:text-faint focus:outline-none focus:border-[#2563EB]"
          placeholder="add trait ⏎"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            }
          }}
          onBlur={() => input && add(input)}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {SUGGESTED_VOICES.filter((s) => !tone.includes(s)).map((s) => (
          <button key={s} className="text-[11px] text-faint hover:text-foreground" onClick={() => add(s)}>
            +{s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BrandKitsView() {
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const moodRef = useRef<HTMLInputElement>(null);
  const [moodBusy, setMoodBusy] = useState(false);

  const reload = () => api.listBrandKits().then(setKits).catch(() => setKits([]));
  useEffect(() => {
    reload();
  }, []);

  async function save() {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      const body = {
        name: draft.name.trim(),
        colors: { ...draft.colors, palette: draft.palette },
        fonts: draft.fonts,
        tone: draft.tone,
        notes: draft.notes,
      };
      if (draft.id) await api.updateBrandKit(draft.id, body);
      else await api.createBrandKit(body);
      setDraft(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function uploadMood(kit: BrandKit, file: File) {
    setMoodBusy(true);
    try {
      await api.uploadMoodBoard(kit.id, file);
      reload();
    } finally {
      setMoodBusy(false);
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

      <div className="p-6 max-w-[1100px]">
        <p className="text-[13px] text-muted mb-4">
          Every generation reads from the product's brand kit — colors and fonts style the image stack, the voice steers the copy,
          the mood board pins the direction.
        </p>

        {kits && kits.length === 0 && !draft && (
          <EmptyState action={<SecondaryButton onClick={() => setDraft(emptyDraft())}><Plus size={14} /> Create your first kit</SecondaryButton>}>
            No brand kits yet. A kit is the voice and visual system your listings are generated with.
          </EmptyState>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {(kits || []).map((k) => {
            const d = toDraft(k);
            const mood = parseJson<string[]>(k.mood_board_r2_keys, []);
            const swatches = [d.colors.primary, d.colors.secondary, d.colors.accent, d.colors.background, ...d.palette];
            return (
              <Card key={k.id}>
                <Zone first>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Eyebrow>Brand</Eyebrow>
                      <div className="text-[15px] font-semibold">{k.name}</div>
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

                <Zone className="grid grid-cols-2 gap-5">
                  <div>
                    <Eyebrow>Typography</Eyebrow>
                    <div className="text-[34px] leading-none font-bold" style={{ fontFamily: `'${d.fonts.heading}', sans-serif` }}>
                      Aa
                    </div>
                    <p className="mt-2 text-[13px] text-muted" style={{ fontFamily: `'${d.fonts.body}', sans-serif` }}>
                      The quick brown fox jumps.
                    </p>
                    <p className="mt-2 text-[10px] tracking-[0.1em] text-faint uppercase">
                      Display + Body · {d.fonts.heading}
                      {d.fonts.body !== d.fonts.heading ? ` / ${d.fonts.body}` : ""}
                    </p>
                  </div>
                  <div>
                    <Eyebrow>Brand voice</Eyebrow>
                    {d.tone.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {d.tone.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[12px] text-faint">No voice traits set.</p>
                    )}
                    <p className="mt-2 text-[10px] tracking-[0.1em] text-faint uppercase">Tone · locked</p>
                  </div>
                </Zone>

                <Zone className="grid grid-cols-2 gap-5">
                  <div>
                    <div className="flex items-center justify-between">
                      <Eyebrow>Mood board</Eyebrow>
                      <button
                        className="text-[11px] text-muted hover:text-foreground inline-flex items-center gap-1"
                        onClick={() => {
                          moodRef.current?.setAttribute("data-kit", k.id);
                          moodRef.current?.click();
                        }}
                      >
                        <Upload size={11} /> {moodBusy ? "…" : "pin"}
                      </button>
                    </div>
                    {mood.length ? (
                      <div className="grid grid-cols-3 gap-1.5">
                        {mood.map((m) => (
                          <div key={m} className="group relative aspect-square rounded overflow-hidden border border-border">
                            <img src={`/api/uploads/${m}`} className="size-full object-cover" />
                            <button
                              className="absolute top-0.5 right-0.5 size-4 rounded-full bg-surface/90 text-muted hover:text-danger items-center justify-center hidden group-hover:flex"
                              onClick={async () => {
                                await api.deleteMoodBoard(k.id, m);
                                reload();
                              }}
                            >
                              <X size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[12px] text-faint">Pin inspiration images.</p>
                    )}
                    <p className="mt-2 text-[10px] tracking-[0.1em] text-faint uppercase">Inspiration · pinned</p>
                  </div>
                  <div>
                    <Eyebrow>Brand colors</Eyebrow>
                    <div className="flex flex-wrap gap-2">
                      {swatches.map((c, i) => (
                        <div
                          key={`${c}${i}`}
                          className="size-9 rounded-full border border-border"
                          style={{ background: c }}
                          title={c}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] tracking-[0.1em] text-faint uppercase">Palette · hex</p>
                  </div>
                </Zone>
              </Card>
            );
          })}
        </div>
        <input
          ref={moodRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const kitId = moodRef.current?.getAttribute("data-kit");
            const kit = kits?.find((x) => x.id === kitId);
            const f = e.target.files?.[0];
            if (kit && f) uploadMood(kit, f);
            e.target.value = "";
          }}
        />
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
              <div className="mt-3">
                <Field label="EXTRA PALETTE (OPTIONAL)">
                  <div className="flex flex-wrap items-center gap-2">
                    {draft.palette.map((c, i) => (
                      <span key={`${c}${i}`} className="relative group">
                        <span className="block size-8 rounded-full border border-border" style={{ background: c }} title={c} />
                        <button
                          className="absolute -top-1 -right-1 size-4 rounded-full bg-surface border border-border text-muted hover:text-danger items-center justify-center hidden group-hover:flex"
                          onClick={() => setDraft({ ...draft, palette: draft.palette.filter((_, j) => j !== i) })}
                        >
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                    <input
                      type="color"
                      className="h-8 w-9 rounded-md border border-border bg-surface cursor-pointer"
                      title="Add a palette color"
                      onChange={(e) => setDraft({ ...draft, palette: [...draft.palette, e.target.value] })}
                    />
                  </div>
                </Field>
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
              <div className="space-y-4">
                <Field label="BRAND VOICE">
                  <VoiceChipsEditor tone={draft.tone} onChange={(tone) => setDraft({ ...draft, tone })} />
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
