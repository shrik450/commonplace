import type { ApiToken } from "../../contracts/item";
import {
  FONTS,
  READING_RANGES,
  THEMES,
  type UserSettings,
} from "../../contracts/settings";
import { readableDate } from "./library";
import { ACTION, FIELD, LINK, Layout, PageHeading, RANGE_FIELD, SELECT_FIELD, SUBMIT } from "./layout";

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

function optionLabel(value: string): string {
  return value === "sans" ? "Sans serif" : value[0]!.toUpperCase() + value.slice(1);
}

function SettingsSelect({ name, label, values, current }: { name: string; label: string; values: readonly string[]; current: string }) {
  return (
    <label class="grid gap-1 text-sm">
      {label}
      <select name={name} class={SELECT_FIELD} autocomplete="off">
        {values.map((value) => <option value={value} selected={current === value}>{optionLabel(value)}</option>)}
      </select>
    </label>
  );
}

function SettingsRange({ name, label, current, unit }: { name: keyof typeof READING_RANGES; label: string; current: number; unit: string }) {
  const range = READING_RANGES[name];
  const outputId = `${name}-value`;
  return (
    <label class="grid gap-2 text-sm">
      <span class="flex justify-between gap-4">
        <span>{label}</span>
        <output id={outputId} for={name} class="text-secondary tabular-nums" data-cp-range-output data-cp-unit={unit}>{current}{unit}</output>
      </span>
      <input id={name} type="range" name={name} min={range.min} max={range.max} step={range.step} value={current} class={RANGE_FIELD} autocomplete="off" />
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
            <SettingsRange name="text_size" label="Text size" current={settings.text_size} unit=" px" />
            <SettingsRange name="line_spacing" label="Line spacing" current={settings.line_spacing} unit="%" />
            <SettingsRange name="paragraph_spacing" label="Paragraph spacing" current={settings.paragraph_spacing} unit="%" />
            <SettingsRange name="text_width" label="Text width" current={settings.text_width} unit=" ch" />
          </div>
          <article
            class="mt-8"
            data-cp-reader
            data-cp-font={settings.font}
            data-cp-text-size={settings.text_size}
            data-cp-line-spacing={settings.line_spacing}
            data-cp-paragraph-spacing={settings.paragraph_spacing}
            data-cp-text-width={settings.text_width}
            style={`--cp-text-size: ${settings.text_size}px; --cp-line-spacing: ${settings.line_spacing / 100}; --cp-paragraph-spacing: ${settings.paragraph_spacing / 100}em; --cp-text-width: ${settings.text_width}ch`}
          >
            <div class="cp-transcript">
              <h3>A quiet place to read</h3>
              <p class="cp-block">
                Good reading settings let the words take priority. This sample includes enough text to show the font, line length, and space between paragraphs.
              </p>
              <p class="cp-block">
                Change each control and watch this passage respond. Try a narrow column for focused reading, or add more space when dense pages feel crowded.
              </p>
              <blockquote class="cp-block">The best setting is the one that helps you keep reading.</blockquote>
              <ul class="cp-block">
                <li>Compare short and long lines.</li>
                <li>Check how separate paragraphs feel.</li>
              </ul>
            </div>
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
