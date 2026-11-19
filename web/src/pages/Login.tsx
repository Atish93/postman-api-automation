// Logging in, and setting the password the first time (with the setup code from the server's log).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { Button, ErrorNote, Field, Icon, Spinner, inputClass } from "../ui.tsx";

// Only paths on this site, so a crafted link can't send you elsewhere after logging in.
const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-page px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink"><Icon name="check" size={18} /></span>QA Dashboard
        </div>
        <div className="rounded-xl border border-line bg-card p-6 shadow-sm">
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage({ setup }: { setup?: boolean }) {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["auth"], queryFn: api.authStatus });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const done = () => {
    qc.clear();
    // A report link is a server page, not part of the app: load it fully.
    if (next.startsWith("/api/")) location.assign(next);
    else navigate(next, { replace: true });
  };
  const login = useMutation({ mutationFn: () => api.login(password), onSuccess: done });
  const create = useMutation({ mutationFn: () => api.setup(code, password), onSuccess: done });

  if (status.isPending) return <div className="grid min-h-screen place-items-center text-muted"><Spinner size={24} /></div>;
  const s = status.data;
  if (s && (!s.enabled || s.logged_in)) return <Navigate to={next} replace />;
  if (s?.setup_needed && !setup) return <Navigate to={`/setup?next=${encodeURIComponent(next)}`} replace />;
  if (s && !s.setup_needed && setup) return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;

  if (setup) {
    const mismatch = repeat.length > 0 && repeat !== password;
    return (
      <Shell title="Set a password">
        <p className="mb-4 text-sm text-ink-2">This dashboard has no password yet. To prove you run it, enter the setup code printed in the server's log (the terminal where you ran <code className="font-mono">npm start</code>, or <code className="font-mono">docker compose logs</code>).</p>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!mismatch) create.mutate(); }}>
          <Field label="Setup code"><input className={`${inputClass} font-mono uppercase`} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoFocus /></Field>
          <Field label="New password" hint="At least 10 characters. A few random words work well.">
            <input className={inputClass} type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Repeat it" error={mismatch ? "The two passwords don't match." : undefined}>
            <input className={inputClass} type="password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
          </Field>
          <ErrorNote error={create.error} />
          <Button type="submit" variant="primary" className="w-full" busy={create.isPending} disabled={mismatch || password.length < 10}>Set password and continue</Button>
        </form>
      </Shell>
    );
  }
  return (
    <Shell title="Log in">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <Field label="Password"><input className={inputClass} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
        <ErrorNote error={login.error} />
        <Button type="submit" variant="primary" className="w-full" busy={login.isPending}>Log in</Button>
      </form>
      <p className="mt-4 text-xs text-muted">Forgot it? On the server, run <code className="font-mono">npm run reset-password</code> in the server folder, then set a new one.</p>
    </Shell>
  );
}
