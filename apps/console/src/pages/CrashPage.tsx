import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";

/**
 * Crash page rendered by react-router's `errorElement` — the "Unexpected
 * Application Error!" red-screen-of-death surfaces only when there's NO
 * error boundary in the tree. Wiring this as the route `errorElement`
 * (and keeping the top-level <ErrorBoundary> for render-time throws
 * outside the router) gives every page a styled fallback instead of the
 * default overlay.
 *
 * It lives inside <AppShell>, so the sidebar + breadcrumb stay put and
 * the user can navigate away without a full reload. A reset key isn't
 * needed here — react-router remounts the route on `reload()` / nav.
 */
export function CrashPage() {
  const error = useRouteError();
  const navigate = useNavigate();

  let title = "Something broke on this page";
  let detail = "An unexpected error occurred while rendering this view.";

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    const data = error.data as { message?: string } | null;
    detail = data?.message ?? "The request returned an error response.";
  } else if (error instanceof Error) {
    detail = error.message || detail;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-fg-subtle text-xs font-mono mb-3 tracking-wider">
        [ ERR ]
      </div>
      <h2 className="font-display text-lg font-semibold mb-1">{title}</h2>
      <p className="text-sm text-fg-muted mb-6 max-w-md break-words">
        {detail}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => navigate(0)}>Try again</Button>
        <Button variant="ghost" onClick={() => navigate("/agents")}>
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
