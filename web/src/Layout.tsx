// The app shell: navigation (a sidebar on wide screens, a top bar on phones) and the theme switch.
import { NavLink, Outlet } from "react-router";
import { Icon, useTheme, type Theme } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Dashboard", icon: "home", end: true },
  { to: "/collections", label: "Collections", icon: "folder" },
  { to: "/environments", label: "Environments", icon: "globe" },
  { to: "/runs", label: "Runs", icon: "list" },
  { to: "/known-bugs", label: "Known bugs", icon: "bug" },
  { to: "/changes", label: "AI changes", icon: "sparkle" },
  { to: "/settings", label: "Settings", icon: "gear" },
];

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
        <div className="mt-auto px-2"><ThemeSwitch /></div>
      </aside>
      </div>

      {/* Top bar on phones */}
      <header className="sticky top-0 z-10 border-b border-line bg-card md:hidden">
        <div className="flex items-center justify-between px-4 py-3"><Logo /><ThemeSwitch /></div>
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
