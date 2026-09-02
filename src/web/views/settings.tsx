import { readableDate } from "./library";
import { Layout } from "./layout";
import type { ApiToken } from "../../contracts/item";

function TokenRow({ token }: { token: ApiToken }) {
  return (
    <li class="cp-rule flex items-center justify-between gap-4 py-3">
      <div>
        <p class="text-sm">{token.name}</p>
        <p class="text-secondary mt-1 text-xs">
          Created {readableDate(token.created_at)}
          {token.last_used_at === null
            ? " · never used"
            : ` · last used ${readableDate(token.last_used_at)}`}
        </p>
      </div>
      <form action={`/settings/tokens/${token.id}/delete`} method="post">
        <button type="submit" class="text-secondary hover:text-primary text-xs">
          Revoke
        </button>
      </form>
    </li>
  );
}

// The one page that ever shows a secret. It lists nothing else, so the secret
// is the only thing on screen worth copying, and no later page can show it
// again: the store keeps only its hash.
export function NewTokenPage({ name, secret }: { name: string; secret: string }) {
  return (
    <Layout title="New token">
      <h1 class="text-secondary mb-2 text-xs tracking-widest uppercase">
        New token
      </h1>
      <p class="text-sm">
        Copy this token now. Commonplace cannot show it again.
      </p>
      <p class="cp-rule bg-base-100 mt-4 p-4 font-mono text-xs break-all select-all">
        {secret}
      </p>
      <p class="text-secondary mt-4 text-xs">
        Saved as {name}. Put it in the Authorization header of your Shortcut, as
        a bearer token.
      </p>
      <p class="mt-6">
        <a href="/settings" class="text-primary text-sm">
          Back to settings
        </a>
      </p>
    </Layout>
  );
}

export function SettingsPage({ tokens }: { tokens: ApiToken[] }) {
  return (
    <Layout title="Settings">
      <h1 class="text-secondary mb-2 text-xs tracking-widest uppercase">
        Settings
      </h1>

      <h2 class="mt-6 mb-2 text-sm font-semibold">API tokens</h2>
      <p class="text-secondary mb-4 text-xs">
        A token saves a page from an iOS Shortcut. It acts as you, so treat it
        like a password.
      </p>
      <form
        action="/settings/tokens"
        method="post"
        class="cp-rule flex items-center gap-3 py-3"
      >
        <input
          type="text"
          name="name"
          required
          placeholder="Name this token"
          class="flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-secondary"
        />
        <button type="submit" class="text-primary text-sm">
          Create
        </button>
      </form>
      {tokens.length === 0 ? (
        <p class="text-secondary py-6 text-sm">No tokens yet.</p>
      ) : (
        <ul class="cp-rule border-t-0">{tokens.map((token) => (
          <TokenRow token={token} />
        ))}</ul>
      )}
    </Layout>
  );
}
