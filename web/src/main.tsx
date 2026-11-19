import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { Layout } from "./Layout.tsx";
import { ToastProvider } from "./ui.tsx";
import { DashboardPage } from "./pages/Dashboard.tsx";
import { CollectionsPage, CollectionPage } from "./pages/Collections.tsx";
import { EnvironmentsPage, EnvironmentEditPage } from "./pages/Environments.tsx";
import { ComparePage } from "./pages/Compare.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { RunPage } from "./pages/Run.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { KnownBugsPage } from "./pages/KnownBugs.tsx";
import { ChangesPage } from "./pages/Changes.tsx";
import { SchedulesPage } from "./pages/Schedules.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/collections", element: <CollectionsPage /> },
      { path: "/collections/:id", element: <CollectionPage /> },
      { path: "/environments", element: <EnvironmentsPage /> },
      { path: "/environments/new", element: <EnvironmentEditPage /> },
      { path: "/environments/compare", element: <ComparePage /> },
      { path: "/environments/:id", element: <EnvironmentEditPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/:id", element: <RunPage /> },
      { path: "/known-bugs", element: <KnownBugsPage /> },
      { path: "/changes", element: <ChangesPage /> },
      { path: "/schedules", element: <SchedulesPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
