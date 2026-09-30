import type { FetchRequest } from "../../contracts/item";
import { MAX_ATTEMPTS } from "../../store/queue";
import { ACTION, FIELD, LINK, SUBMIT } from "./controls";
import { Layout, type PageContext } from "./layout";
import { Sheet } from "./sheet";

export function saveStateLabel(request: FetchRequest): string {
  if (request.state === "queued") return "Waiting to save…";
  if (request.state === "claimed") return "Saving a local copy…";
  if (request.state === "failed") return "Save failed";
  return "Saved";
}

export function attemptDetail(request: FetchRequest): string | null {
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

// The save form as a page of its own, for phones and for readers without
// scripts.
export function SavePage({ context }: { context: PageContext }) {
  return (
    <Layout title="Save a page" context={context}>
      <Sheet labelledBy="save-title" narrow>
        <form class="save-form" action="/items" method="post">
          <h1 id="save-title" class="sheet-title">Save a page</h1>
          <label class="save-card-label" for="save-url">Link</label>
          <input
            id="save-url"
            class={FIELD}
            type="url"
            name="url"
            required
            autocomplete="url"
            spellcheck="false"
            placeholder="https://example.com/an-essay…"
          />
          <p>
            <button type="submit" class={SUBMIT}>Save page</button>
          </p>
          <p class="sheet-note">
            Commonplace keeps a full copy and files it in your library. You can close this page while it saves.
          </p>
        </form>
      </Sheet>
    </Layout>
  );
}

export function SaveStatusPage({ request, removable, context }: { request: FetchRequest; removable: boolean; context: PageContext }) {
  const active = request.state === "queued" || request.state === "claimed";
  const detail = attemptDetail(request);
  return (
    <Layout title="Save status" context={context} refreshSeconds={active ? 2 : undefined}>
      <Sheet labelledBy="status-title" narrow>
        <p class="sheet-kicker">Save status</p>
        <h1 id="status-title" class="sheet-title">{saveStateLabel(request)}</h1>
        <p class="sheet-lede sheet-url" translate="no">{request.url}</p>
        {detail === null ? null : <p class="sheet-note">{detail}</p>}
        {request.state === "failed" ? (
          <p class="sheet-lede">
            Check that the address is still reachable, then return to your
            library and submit it again.
          </p>
        ) : null}
        {request.error_code === null ? null : (
          <p class="sheet-code" translate="no">Error code: {request.error_code}</p>
        )}
        <p class="sheet-actions">
          <a href="/library" class={ACTION}>Back to your library</a>
          {removable ? <a href={`/saves/${request.id}/delete`} class={LINK}>Remove save…</a> : null}
        </p>
      </Sheet>
    </Layout>
  );
}
