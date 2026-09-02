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

// Uses a separate page to confirm token revocation without client-side dialog
// code.
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
        Apps using this token lose access immediately. You cannot restore the
        token, but your saved pages remain unchanged. Create another token if
        you need access later.
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
            Revoke token
          </button>
        </form>
        <a href="/settings" class={`text-sm ${LINK}`}>
          Cancel
        </a>
      </div>
    </Layout>
  );
}

// Shows a new token secret once because the store retains only its hash.
export function NewTokenPage({ name, secret }: { name: string; secret: string }) {
  return (
    <Layout title="New token">
      <PageHeading>Your new token</PageHeading>
      <p class="max-w-prose text-sm leading-relaxed">
        Copy this token now. Commonplace cannot display it again because the
        store retains only its hash.
      </p>
      <p
        class="cp-rule bg-base-100 mt-5 p-4 font-mono text-xs break-all select-all"
        translate="no"
      >
        {secret}
      </p>
      <p class="text-secondary mt-4 max-w-prose text-xs leading-relaxed">
        The token name is {name}. In your Shortcut, send the token in the
        Authorization header after the Bearer scheme and a space.
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
        An API token lets an iOS Shortcut save pages without an interactive
        sign-in. Anyone with the token can access your account. Revoke tokens
        that you no longer use.
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
          You have no API tokens. Create one to let an iOS Shortcut save pages.
        </p>
      ) : (
        <ul>{tokens.map((token) => (
          <TokenRow token={token} locale={locale} />
        ))}</ul>
      )}
    </Layout>
  );
}
