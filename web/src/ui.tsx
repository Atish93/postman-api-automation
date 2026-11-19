// Shared building blocks: buttons, cards, dialogs, fields, status badges, notifications, icons.
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RunStatus } from "./api.ts";

// ---------- Icons (stroke icons, 16px by default) ----------
const paths: Record<string, ReactNode> = {
  check: <path d="M4 10.5l3.5 3.5L16 6" />,
  x: <path d="M5 5l10 10M15 5L5 15" />,
  bug: <><path d="M7 7h6v4a3 3 0 01-6 0V7z" /><path d="M8 7V5.5a2 2 0 014 0V7M4 9h3M13 9h3M4.5 14l2.5-1.5M15.5 14L13 12.5M10 11v4" /></>,
  plug: <><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 01-10 0V7zM10 14v3" /><path d="M3 3l14 14" /></>,
  pause: <path d="M7 5v10M13 5v10" />,
  alert: <><path d="M10 3l8 14H2L10 3z" /><path d="M10 8v4M10 14.5v.5" /></>,
  ban: <><circle cx="10" cy="10" r="7" /><path d="M5 15L15 5" /></>,
  clock: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></>,
  play: <path d="M7 4.5l8 5.5-8 5.5v-11z" />,
  plus: <path d="M10 4v12M4 10h12" />,
  upload: <path d="M10 13V3M6 7l4-4 4 4M4 13v3h12v-3" />,
  download: <path d="M10 3v10M6 9l4 4 4-4M4 13v3h12v-3" />,
  refresh: <path d="M15.5 8A6 6 0 104 10.5M16 4v4h-4" />,
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />,
  home: <path d="M3 9.5L10 4l7 5.5V16h-5v-4H8v4H3V9.5z" />,
  folder: <path d="M3 5h5l2 2h7v9H3V5z" />,
  globe: <><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2 2 3 4.5 3 7s-1 5-3 7c-2-2-3-4.5-3-7s1-5 3-7z" /></>,
  list: <path d="M7 5h10M7 10h10M7 15h10M3 5h.5M3 10h.5M3 15h.5" />,
  gear: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>,
  sun: <><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></>,
  moon: <path d="M15.5 12.5A6.5 6.5 0 017.5 4.5a6.5 6.5 0 108 8z" />,
  monitor: <><rect x="3" y="4" width="14" height="10" rx="1.5" /><path d="M7 17h6M10 14v3" /></>,
  sparkle: <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3z" />,
  chevron: <path d="M7 4l6 6-6 6" />,
  key: <><circle cx="7" cy="12" r="3.5" /><path d="M9.5 9.5L16 3M13.5 5.5l2 2" /></>,
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  table: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 8h14M3 12h14M8 4v12" /></>,
  columns: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M8 4v12M12 4v12" /></>,
  copy: <><rect x="7" y="7" width="9" height="9" rx="1.5" /><path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-6A1.5 1.5 0 004 5.5v6A1.5 1.5 0 005.5 13H7" /></>,
  lock: <><rect x="4.5" y="9" width="11" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 016 0V9" /></>,
  minus: <path d="M5 10h10" />,
  equal: <path d="M5 8h10M5 12h10" />,
};
export function Icon({ name, size = 16, className = "" }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="animate-spin" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M17 10a7 7 0 00-7-7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------- Run status: colour + icon + label, never colour alone ----------
export const STATUS: Record<RunStatus, { label: string; color: string; icon: string }> = {
  queued: { label: "Queued", color: "var(--status-neutral)", icon: "clock" },
  running: { label: "Running", color: "var(--accent)", icon: "spinner" },
  passed: { label: "Passed", color: "var(--status-good)", icon: "check" },
  passed_with_known_bugs: { label: "Passed, known bugs", color: "var(--status-warning)", icon: "bug" },
  failed: { label: "Failed", color: "var(--status-critical)", icon: "x" },
  server_issue: { label: "Server issue", color: "var(--status-serious)", icon: "plug" },
  circuit_breaker: { label: "Breaker tripped", color: "var(--status-serious)", icon: "pause" },
  error: { label: "Error", color: "var(--status-neutral)", icon: "alert" },
  cancelled: { label: "Cancelled", color: "var(--status-neutral)", icon: "ban" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? STATUS.error;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium text-ink"
      style={{ background: `color-mix(in srgb, ${s.color} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${s.color} 40%, transparent)` }}
    >
      <span style={{ color: s.color }} className="inline-flex">
        {s.icon === "spinner" ? <Spinner size={12} /> : <Icon name={s.icon} size={12} />}
      </span>
      {s.label}
    </span>
  );
}

export function KindBadge({ kind, mode }: { kind: "plain" | "ai"; mode?: "regression" | "build" | null }) {
  return kind === "ai" ? (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-2"><Icon name="sparkle" size={12} className="text-accent" />{mode === "build" ? "AI build" : "AI"}</span>
  ) : (
    <span className="inline-flex items-center rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-2">Plain</span>
  );
}

export function MethodBadge({ method }: { method: string }) {
  return <span className="inline-block w-14 shrink-0 rounded bg-raised px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-ink-2 ring-1 ring-line">{method}</span>;
}

// ---------- Layout pieces ----------
export function Card({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-line bg-card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-raised p-3 text-muted ring-1 ring-line"><Icon name={icon} size={22} /></div>
      <h3 className="font-medium">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-ink" style={{ borderColor: "color-mix(in srgb, var(--status-critical) 45%, transparent)", background: "color-mix(in srgb, var(--status-critical) 9%, transparent)" }}>
      <Icon name="alert" className="mt-0.5 shrink-0 text-critical" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

// ---------- Controls ----------
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; icon?: string; busy?: boolean; size?: "sm" | "md" };
export function Button({ variant = "secondary", icon, busy, size = "md", children, className = "", disabled, ...rest }: ButtonProps) {
  const look = {
    primary: "bg-accent text-accent-ink hover:brightness-110",
    secondary: "bg-raised text-ink ring-1 ring-line hover:bg-page",
    ghost: "text-ink-2 hover:bg-raised hover:text-ink",
    danger: "bg-raised text-bad-ink ring-1 ring-line hover:bg-page",
  }[variant];
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${look} ${pad} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

// A labelled form field. The label names the control; the hint (or error) describes it
// (aria-describedby), so screen readers announce "Password" and then the hint, not one long name.
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  const id = useId();
  const note = error ?? hint;
  const control = isValidElement(children) && note ? cloneElement(children as React.ReactElement<any>, { "aria-describedby": `${id}-note` }) : children;
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{label}</span>
        {control}
      </label>
      {note && <span id={`${id}-note`} className={`mt-1 block text-xs ${error ? "text-bad-ink" : "text-muted"}`}>{note}</span>}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-raised px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl border border-line bg-card p-0 text-ink shadow-2xl backdrop:bg-black/40`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded p-1 text-muted hover:text-ink" aria-label="Close"><Icon name="x" /></button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// ---------- Notifications ----------
type Toast = { id: number; kind: "ok" | "error"; text: string };
const ToastContext = createContext<(kind: Toast["kind"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm shadow-lg">
            <Icon name={t.kind === "ok" ? "check" : "alert"} className={`mt-0.5 shrink-0 ${t.kind === "ok" ? "text-good" : "text-critical"}`} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- Theme ----------
export type Theme = "system" | "light" | "dark";
export function useTheme(): [Theme, (t: Theme) => void] {
  const read = (): Theme => {
    try {
      const t = localStorage.getItem("theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  };
  const [theme, setTheme] = useState<Theme>(read);
  const set = (t: Theme) => {
    setTheme(t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch {}
  };
  return [theme, set];
}
