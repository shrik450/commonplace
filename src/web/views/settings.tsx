import { readableDate } from "./library";
import { ACTION, FIELD, LINK, Layout, PageHeading, SUBMIT } from "./layout";
import type { ApiToken } from "../../contracts/item";

function TokenRow({ token, locale }: { token: ApiToken; locale: string }) {
  return (
    <li class="cp-rule flex items-center justify-between gap-4 py-4">
      <div class="min-w-0">
        <p class="text-sm break-words">{token.name}</p>
        <p class="text-secondary mt-1.5 text-xs">
          Made{" "}
          <time datetime={token.created_at}>
            {readableDate(token.created_at, locale)}
          </time>
          {token.last_used_at === null ? (
            " · never used"
          ) : (
            <>
              {" · last used "}
              <time datetime={token.last_used_at}>
                {readableDate(token.last_used_at, locale)}
              </time>
            </>
          )}
        </p>
      </div>
      <a
        href={`/settings/tokens/${token.id}/revoke`}
        class={`shrink-0 text-xs ${LINK}`}
      >
        Revoke…
      </a>
    </li>
  );
}

// Revoking cannot be undone, so it asks first. The question is a page rather
// than a dialog, because the app ships no script for a dialog to depend on.
export function RevokeTokenPage({
  token,
  locale,
}: {
  token: ApiToken;
  locale: string;
}) {
  return (
    <Layout title="Revoke token">
      <PageHeading>Revoke {token.name}?</PageHeading>
      <p class="max-w-prose text-sm leading-relaxed">
        Anything using this token stops saving pages at once, and you cannot
        undo this. Your saved pages stay where they are. Make a new token if
        you need one later.
      </p>
      <p class="text-secondary mt-3 text-xs">
        Made{" "}
        <time datetime={token.created_at}>
          {readableDate(token.created_at, locale)}
        </time>
        {token.last_used_at === null ? (
          " · never used"
        ) : (
          <>
            {" · last used "}
            <time datetime={token.last_used_at}>
              {readableDate(token.last_used_at, locale)}
            </time>
          </>
        )}
      </p>
      <div class="mt-8 flex items-center gap-6">
        <form action={`/settings/tokens/${token.id}/delete`} method="post">
          <button type="submit" class={SUBMIT}>
            Revoke this token
          </button>
        </form>
        <a href="/settings" class={`text-sm ${LINK}`}>
          Keep it
        </a>
      </div>
    </Layout>
  );
}

// The one page that ever shows a secret. It lists nothing else, so the secret
// is the only thing on screen worth copying, and no later page can show it
// again: the store keeps only its hash.
export function NewTokenPage({ name, secret }: { name: string; secret: string }) {
  return (
    <Layout title="New token">
      <PageHeading>Your new token</PageHeading>
      <p class="max-w-prose text-sm leading-relaxed">
        Copy this token now. Commonplace shows it once, then keeps only a hash
        of it, so this is your only chance.
      </p>
      <p
        class="cp-rule bg-base-100 mt-5 p-4 font-mono text-xs break-all select-all"
        translate="no"
      >
        {secret}
      </p>
      <p class="text-secondary mt-4 max-w-prose text-xs leading-relaxed">
        Saved as {name}. In your Shortcut, send it as the Authorization header:
        the word Bearer, a space, then the token.
      </p>
      <p class="mt-8">
        <a href="/settings" class={`text-sm ${ACTION}`}>
          Back to settings
        </a>
      </p>
    </Layout>
  );
}

export function SettingsPage({
  tokens,
  locale,
}: {
  tokens: ApiToken[];
  locale: string;
}) {
  return (
    <Layout title="Settings">
      <PageHeading>Settings</PageHeading>

      <h2 class="cp-rule mt-10 mb-3 pb-2 text-base font-semibold">
        Access tokens
      </h2>
      <p class="text-secondary mb-5 max-w-prose text-xs leading-relaxed">
        A token lets an iOS Shortcut save pages to your library without signing
        in. It acts as you, so guard it like your password. Revoke any token
        you no longer use.
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
          aria-label="Name for the new token"
          autocomplete="off"
          spellcheck="false"
          placeholder="Name it after the device, like iPhone Shortcut…"
          class={`min-w-0 flex-1 ${FIELD}`}
        />
        <button type="submit" class={SUBMIT}>
          Create token
        </button>
      </form>
      {tokens.length === 0 ? (
        <p class="text-secondary max-w-prose py-6 text-sm">
          You have no tokens. Name one above to let a Shortcut save pages for
          you.
        </p>
      ) : (
        <ul>{tokens.map((token) => (
          <TokenRow token={token} locale={locale} />
        ))}</ul>
      )}
    </Layout>
  );
}
