// Small shared primitives following DESIGN.md: zoned cards opened by
// eyebrows, one coral CTA per screen, chips for facts, badges for signals.

import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-surface border border-border rounded-lg ${className}`}>{children}</div>;
}

export function Zone({ children, className = "", first = false }: { children: ReactNode; className?: string; first?: boolean }) {
  return <div className={`p-5 ${first ? "" : "border-t border-border"} ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted mb-3">{children}</div>;
}

export function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-sunken border border-border px-2 py-1 text-[11px] text-muted ${className}`}>
      {children}
    </span>
  );
}

const BADGE_TONES: Record<string, string> = {
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  neutral: "bg-sunken text-muted",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold tracking-[0.04em] ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function statusBadge(status: string) {
  const tone =
    status === "done" || status === "ready" || status === "exported"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "generating" || status === "rendering"
          ? "warning"
          : "neutral";
  return <Badge tone={tone as keyof typeof BADGE_TONES}>{status}</Badge>;
}

export function PrimaryButton({ busy, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-md bg-primary text-white text-[13px] font-medium px-3 h-9 hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

export function SecondaryButton({ busy, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-md bg-surface border border-border text-[13px] font-medium px-3 h-9 hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, children, meta }: { label: string; children: ReactNode; meta?: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-[12px] font-semibold tracking-[0.04em] text-muted">{label}</label>
        {meta && <span className="text-[11px] text-faint tabular-nums h-4">{meta}</span>}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-border bg-surface px-2.5 h-9 text-[13px] placeholder:text-faint focus:outline-none focus:border-[#2563EB] ${props.className || ""}`}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] placeholder:text-faint focus:outline-none focus:border-[#2563EB] ${props.className || ""}`}
    />
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-14 text-center">
      <p className="text-[13px] text-muted">{children}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function PreviewBanner() {
  return (
    <div className="mb-4 rounded-md border border-border bg-warning-tint text-warning px-4 py-2.5 text-[13px]">
      <span className="font-semibold">Just a preview.</span> This is sample data so you can see how the studio works — add your
      first brand kit and product to start.
    </div>
  );
}

/** Counter meta for a char-limited field: “142 / 200”. Turns red past the cap. */
export function counter(len: number, max: number, unit = "") {
  return <span className={len > max ? "text-danger font-semibold" : ""}>{len} / {max}{unit}</span>;
}
