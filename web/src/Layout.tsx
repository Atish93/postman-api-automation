// The app shell: navigation (a sidebar on wide screens, a top bar on phones) and the theme switch.
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { Icon, Spinner, useTheme, type Theme } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Dashboard", icon: "home", end: true },
  { to: "/collections", label: "Collections", icon: "folder" },
  { to: "/environments", label: "Environments", icon: "globe" },
  { to: "/runs", label: "Runs", icon: "list" },
  { to: "/schedules", label: "Schedules", icon: "clock" },
  { to: "/known-bugs", label: "Known bugs", icon: "bug" },
  { to: "/changes", label: "AI changes", icon: "sparkle" },
  { to: "/audit", label: "Audit log", icon: "shield" },
  { to: "/settings", label: "Settings", icon: "gear" },
];

function LogoutButton({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const out = async () => {
    await api.logout().catch(() => {});
    qc.clear();
    location.assign("/login");
  };
  return (
    <button onClick={out} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-raised hover:text-ink" title="Log out">
      <Icon name="logout" size={14} />{compact ? <span className="sr-only">Log out</span> : "Log out"}
    </button>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: "system", icon: "monitor", label: "Match system" },
    { value: "light", icon: "sun", label: "Light" },
    { value: "dark", icon: "moon", label: "Dark" },
  ];
  return (
    <div className="inline-flex rounded-lg bg-page p-0.5 ring-1 ring-line" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme === o.value}
          title={o.label}
          onClick={() => setTheme(o.value)}
          className={`rounded-md p-1.5 ${theme === o.value ? "bg-raised text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"}`}
        >
          <Icon name={o.icon} size={14} />
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const Logo = () => (
  <div className="flex items-center gap-2 font-semibold">
    <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-ink"><Icon name="check" size={16} /></span>
    QA Dashboard
  </div>
);

export function Layout() {
  // Every page needs a login (when the server has logins on).
  const auth = useQuery({ queryKey: ["auth"], queryFn: api.authStatus, staleTime: 60_000 });
  const here = useLocation();
  const next = encodeURIComponent(here.pathname + here.search);
  if (auth.isPending) return <div className="grid min-h-screen place-items-center text-muted"><Spinner size={24} /></div>;
  if (auth.data?.setup_needed) return <Navigate to={`/setup?next=${next}`} replace />;
  if (auth.data && !auth.data.logged_in) return <Navigate to={`/login?next=${next}`} replace />;
  const loginsOn = auth.data?.enabled ?? false;
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${isActive ? "bg-raised font-medium text-ink ring-1 ring-line" : "text-ink-2 hover:bg-raised hover:text-ink"}`;
  return (
    <div className="min-h-screen md:flex">
      {/* Sidebar on wide screens */}
      <div className="hidden w-56 shrink-0 border-r border-line bg-card md:block">
      <aside className="sticky top-0 flex h-screen flex-col px-3 py-4">
        <div className="px-2 pb-6"><Logo /></div>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={link}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between gap-2 px-2"><ThemeSwitch />{loginsOn && <LogoutButton />}</div>
      </aside>
      </div>

      {/* Top bar on phones */}
      <header className="sticky top-0 z-10 border-b border-line bg-card md:hidden">
        <div className="flex items-center justify-between px-4 py-3"><Logo /><div className="flex items-center gap-1"><ThemeSwitch />{loginsOn && <LogoutButton compact />}</div></div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={link}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
        </nav>
      </header>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl"><Outlet /></div>
      </main>
    </div>
  );
}
