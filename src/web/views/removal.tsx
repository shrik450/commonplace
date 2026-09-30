import type { FetchRequest } from "../../contracts/item";
import type { Card } from "../../services/library";
import { ACTION, SUBMIT } from "./controls";
import { entryCount } from "./format";
import { Layout, type PageContext } from "./layout";
import { Sheet } from "./sheet";

// What leaves with a page, named only when it has any.
function goesWith({ clippings, pageNotes }: Card): string {
  if (clippings === 0 && pageNotes === 0) return "";
  return `This will also remove the ${entryCount(clippings, pageNotes)} you made on it. `;
}

export function RemovePagePage({ card, context }: { card: Card; context: PageContext }) {
  const { item } = card;
  const path = `/items/${item.id}`;
  return (
    <Layout title="Remove page" context={context} current="library">
      <Sheet labelledBy="remove-title" narrow>
        <h1 id="remove-title" class="sheet-title">Remove “{item.title}” from your library?</h1>
        <p class="sheet-lede sheet-url" translate="no">{item.url}</p>
        <p class="sheet-lede">
          {goesWith(card)}This cannot be undone. If there was an issue with saving the page, you can try saving its address again; Commonplace will replace the copy but keep your clippings and notes.
        </p>
        <div class="sheet-actions">
          <form action={`${path}/delete`} method="post">
            <button type="submit" class={SUBMIT}>Remove page</button>
          </form>
          <a class={ACTION} href={path}>Cancel</a>
        </div>
      </Sheet>
    </Layout>
  );
}

// What removing a save does, for each state a save can be removed in.
function consequence(save: FetchRequest): string {
  if (save.state === "failed") {
    return "This will remove the failed save from your library. Commonplace didn’t keep anything from this address. You can try saving it again at any time.";
  }
  if (save.state === "claimed") {
    return "This will stop Commonplace saving the page and remove the save from your library. Nothing captured so far will be kept. You can save the address again at any time.";
  }
  return "This will cancel the save and remove it from your library. Commonplace hasn’t kept anything from this address yet. You can save it again at any time.";
}

export function RemoveSavePage({ save, context }: { save: FetchRequest; context: PageContext }) {
  const path = `/saves/${save.id}`;
  return (
    <Layout title="Remove save" context={context} current="library">
      <Sheet labelledBy="remove-title" narrow>
        <h1 id="remove-title" class="sheet-title">Remove this save?</h1>
        <p class="sheet-lede sheet-url" translate="no">{save.url}</p>
        <p class="sheet-lede">{consequence(save)}</p>
        <div class="sheet-actions">
          <form action={`${path}/delete`} method="post">
            <button type="submit" class={SUBMIT}>Remove save</button>
          </form>
          <a class={ACTION} href={path}>Cancel</a>
        </div>
      </Sheet>
    </Layout>
  );
}
