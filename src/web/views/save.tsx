import type { FetchRequest } from "../../contracts/item";
import { MAX_ATTEMPTS } from "../../store/queue";
import { ACTION, CONTENT_LINK, Layout, PageHeading } from "./layout";

export function saveStateLabel(request: FetchRequest): string {
  if (request.state === "queued") return "Waiting to save…";
  if (request.state === "claimed") return "Saving a local copy…";
  if (request.state === "failed") return "Save failed";
  return "Saved";
}

function attemptDetail(request: FetchRequest): string | null {
  if (request.state === "claimed") {
    return `Attempt ${request.attempts} of ${MAX_ATTEMPTS}.`;
  }
  if (request.state === "queued" && request.attempts > 0) {
    return `Attempt ${Math.min(request.attempts + 1, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS} will start next.`;
  }
  if (request.state === "failed") {
    return `Stopped after ${request.attempts} of ${MAX_ATTEMPTS} attempts.`;
  }
  return null;
}

export function SaveRequestRow({ request }: { request: FetchRequest }) {
  const detail = attemptDetail(request);
  return (
    <li class="cp-rule py-4">
      <a href={`/saves/${request.id}`} class={`block ${CONTENT_LINK}`}>
        <span class="block break-words" translate="no">
          {request.url}
        </span>
        <span class="text-secondary mt-1.5 block text-xs break-words">
          {saveStateLabel(request)}
          {detail === null ? null : ` · ${detail}`}
          {request.error_code === null ? null : ` · Error code: ${request.error_code}`}
        </span>
      </a>
    </li>
  );
}

export function SaveStatusPage({ request }: { request: FetchRequest }) {
  const active = request.state === "queued" || request.state === "claimed";
  const detail = attemptDetail(request);
  return (
    <Layout title="Save status" refreshSeconds={active ? 2 : undefined}>
      <PageHeading>Save status</PageHeading>
      <section class="cp-rule pb-6">
        <h2 class="text-base font-semibold">{saveStateLabel(request)}</h2>
        <p class="text-secondary mt-3 max-w-prose text-sm break-words" translate="no">
          {request.url}
        </p>
        {detail === null ? null : (
          <p class="text-secondary mt-3 text-xs">{detail}</p>
        )}
        {request.state === "failed" ? (
          <p class="mt-4 max-w-prose text-sm leading-relaxed">
            Check that the address is still reachable, then return to your
            library and submit it again.
          </p>
        ) : null}
        {request.error_code === null ? null : (
          <p class="text-secondary mt-4 font-mono text-xs" translate="no">
            Error code: {request.error_code}
          </p>
        )}
      </section>
      <p class="mt-8">
        <a href="/library" class={`text-sm ${ACTION}`}>
          Back to your library
        </a>
      </p>
    </Layout>
  );
}
