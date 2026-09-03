import type { ApiToken } from "../../contracts/item";
import {
  FONTS,
  LINE_SPACINGS,
  PARAGRAPH_SPACINGS,
  TEXT_SIZES,
  TEXT_WIDTHS,
  THEMES,
  type UserSettings,
} from "../../contracts/settings";
import { readableDate } from "./library";
import { ACTION, FIELD, LINK, Layout, PageHeading, SELECT_FIELD, SUBMIT } from "./layout";

function TokenRow({ token, locale }: { token: ApiToken; locale: string }) {
  return (
    <li class="cp-rule flex items-center justify-between gap-4 py-4">
      <div class="min-w-0">
        <p class="text-sm break-words">{token.name}</p>
        <p class="text-secondary mt-1.5 text-xs">
          Made <time datetime={token.created_at}>{readableDate(token.created_at, locale)}</time>
          {token.last_used_at === null ? " · never used" : (
            <> · last used <time datetime={token.last_used_at}>{readableDate(token.last_used_at, locale)}</time></>
          )}
        </p>
      </div>
      <a href={`/settings/tokens/${token.id}/revoke`} class={`shrink-0 text-xs ${LINK}`}>Revoke…</a>
    </li>
  );
}

export function RevokeTokenPage({ token, locale, settings }: { token: ApiToken; locale: string; settings?: UserSettings }) {
  return (
    <Layout title="Revoke token" settings={settings}>
      <PageHeading>Revoke {token.name}?</PageHeading>
      <p class="max-w-prose text-sm leading-relaxed">
        Apps using this token lose access immediately. You cannot restore the token, but your saved pages remain unchanged.
        Create another token if you need access later.
      </p>
      <p class="text-secondary mt-3 text-xs">
        Made <time datetime={token.created_at}>{readableDate(token.created_at, locale)}</time>
        {token.last_used_at === null ? " · never used" : (
          <> · last used <time datetime={token.last_used_at}>{readableDate(token.last_used_at, locale)}</time></>
        )}
      </p>
      <div class="mt-8 flex items-center gap-6">
        <form action={`/settings/tokens/${token.id}/delete`} method="post">
          <button type="submit" class={SUBMIT}>Revoke token</button>
        </form>
        <a href="/settings" class={`text-sm ${LINK}`}>Cancel</a>
      </div>
    </Layout>
  );
}

export function NewTokenPage({ name, secret, settings }: { name: string; secret: string; settings?: UserSettings }) {
  return (
    <Layout title="New token" settings={settings}>
      <PageHeading>Your new token</PageHeading>
      <p class="max-w-prose text-sm leading-relaxed">
        Copy this token now. Commonplace cannot display it again because the store retains only its hash.
      </p>
      <p class="cp-rule bg-base-100 mt-5 p-4 font-mono text-xs break-all select-all" translate="no">{secret}</p>
      <p class="text-secondary mt-4 max-w-prose text-xs leading-relaxed">
        The token name is {name}. Send the token in the Authorization header after the Bearer scheme and a space.
      </p>
      <p class="mt-8"><a href="/settings" class={`text-sm ${ACTION}`}>Back to settings</a></p>
    </Layout>
  );
}

export function SettingsSelect({ name, label, values, current, compact = false }: { name: string; label: string; values: readonly string[]; current: string; compact?: boolean }) {
  return (
    <label class={`grid gap-1 ${compact ? "text-xs" : "text-sm"}`}>
      {label}
      <select name={name} class={SELECT_FIELD} autocomplete="off">
        {values.map((value) => <option value={value} selected={current === value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}
      </select>
    </label>
  );
}

export function SettingsPage({ tokens, locale, settings }: { tokens: ApiToken[]; locale: string; settings: UserSettings }) {
  return (
    <Layout title="Settings" settings={settings} settingsScript>
      <PageHeading>Settings</PageHeading>
      <form action="/settings" method="post" class="cp-rule grid gap-6 pb-8" data-cp-settings-form>
        <section>
          <h2 class="mb-3 text-base font-semibold">Appearance</h2>
          <SettingsSelect name="theme" label="Theme" values={THEMES} current={settings.theme} />
        </section>
        <section>
          <h2 class="mb-3 text-base font-semibold">Reading</h2>
          <div class="grid gap-5 sm:grid-cols-2">
            <SettingsSelect name="font" label="Font" values={FONTS} current={settings.font} />
            <SettingsSelect name="text_size" label="Text size" values={TEXT_SIZES} current={settings.text_size} />
            <SettingsSelect name="line_spacing" label="Line spacing" values={LINE_SPACINGS} current={settings.line_spacing} />
            <SettingsSelect name="paragraph_spacing" label="Paragraph spacing" values={PARAGRAPH_SPACINGS} current={settings.paragraph_spacing} />
            <SettingsSelect name="text_width" label="Text width" values={TEXT_WIDTHS} current={settings.text_width} />
          </div>
          <article
            class="mt-8"
            data-cp-reader
            data-cp-font={settings.font}
            data-cp-text-size={settings.text_size}
            data-cp-line-spacing={settings.line_spacing}
            data-cp-paragraph-spacing={settings.paragraph_spacing}
            data-cp-text-width={settings.text_width}
          >
            <p class="cp-transcript">This short passage shows how your reading settings will look.</p>
          </article>
        </section>
        <button type="submit" class={SUBMIT}>Save settings</button>
        <p class="text-secondary text-xs" aria-live="polite" data-cp-settings-status>Settings save when you submit this form.</p>
      </form>
      <h2 class="cp-rule mt-10 mb-3 pb-2 text-base font-semibold">API tokens</h2>
      <p class="text-secondary mb-5 max-w-prose text-xs leading-relaxed">
        An API token lets another app save pages without interactive sign-in. Anyone with the token can access your account.
        Revoke tokens you no longer use.
      </p>
      <form action="/settings/tokens" method="post" class="cp-rule flex items-center gap-3 py-3">
        <input type="text" name="name" required aria-label="Name for the new token" autocomplete="off" spellcheck="false" placeholder="Name it after the device or app…" class={`min-w-0 flex-1 ${FIELD}`} />
        <button type="submit" class={SUBMIT}>Create token</button>
      </form>
      {tokens.length === 0 ? (
        <p class="text-secondary max-w-prose py-6 text-sm">You have no API tokens. Create one to let another app save pages.</p>
      ) : <ul>{tokens.map((token) => <TokenRow token={token} locale={locale} />)}</ul>}
    </Layout>
  );
}
