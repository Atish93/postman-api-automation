import { Link } from "react-router";
import { Button, EmptyState } from "../ui.tsx";

export function NotFoundPage() {
  return (
    <EmptyState icon="alert" title="Page not found" action={<Link to="/"><Button>Go to the dashboard</Button></Link>}>
      This page doesn't exist. It may have been a link to something that was deleted.
    </EmptyState>
  );
}
