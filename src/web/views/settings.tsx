import type { ApiToken } from "../../contracts/item";
import {
  FONTS,
  READING_RANGES,
  THEMES,
  type Font,
  type Theme,
} from "../../contracts/settings";
import { ACTION, FIELD, LINK, RANGE_FIELD, SELECT_FIELD, SUBMIT } from "./controls";
import { readableDate } from "./format";
import { Layout, type PageContext } from "./layout";
import { Sheet } from "./sheet";

function TokenRow({ token, locale }: { token: ApiToken; locale: string }) {
  return (
    <li class="token-row">
      <div class="min-w-0">
        <p class="token-name">{token.name}</p>
        <p class="sheet-note">
          Made <time datetime={token.created_at}>{readableDate(token.created_at, locale)}</time>
          {token.last_used_at === null ? " · never used" : (
            <> · last used <time datetime={token.last_used_at}>{readableDate(token.last_used_at, locale)}</time></>
          )}
        </p>
      </div>
      <a href={`/settings/tokens/${token.id}/revoke`} class={LINK}>Revoke…</a>
    </li>
  );
}

export function RevokeTokenPage({ token, context }: { token: ApiToken; context: PageContext }) {
  const locale = context.locale;
  return (
    <Layout title="Revoke token" context={context}>
      <Sheet labelledBy="revoke-title" narrow>
      <h1 id="revoke-title" class="sheet-title">Revoke {token.name}?</h1>
      <p class="sheet-lede">
        Apps using this token lose access immediately. You cannot restore the token, but your saved pages remain unchanged.
        Create another token if you need access later.
      </p>
      <p class="sheet-note">
        Made <time datetime={token.created_at}>{readableDate(token.created_at, locale)}</time>
        {token.last_used_at === null ? " · never used" : (
          <> · last used <time datetime={token.last_used_at}>{readableDate(token.last_used_at, locale)}</time></>
        )}
      </p>
      <div class="sheet-actions">
        <form action={`/settings/tokens/${token.id}/delete`} method="post">
          <button type="submit" class={SUBMIT}>Revoke token</button>
        </form>
        <a href="/settings" class={ACTION}>Cancel</a>
      </div>
      </Sheet>
    </Layout>
  );
}

export function NewTokenPage({ name, secret, context }: { name: string; secret: string; context: PageContext }) {
  return (
    <Layout title="New token" context={context}>
      <Sheet labelledBy="token-title" narrow>
        <h1 id="token-title" class="sheet-title">Your new token</h1>
        <p class="sheet-lede">
          Copy this token now. Commonplace cannot display it again because the store retains only its hash.
        </p>
        <p class="token-secret" translate="no">{secret}</p>
        <p class="sheet-note">
          The token name is {name}. Send the token in the Authorization header after the Bearer scheme and a space.
        </p>
        <p class="sheet-actions"><a href="/settings" class={ACTION}>Back to settings</a></p>
      </Sheet>
    </Layout>
  );
}

type SettingsOption = Font | Theme;

const OPTION_LABELS = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
  newsreader: "Newsreader",
  literata: "Literata",
  "source-serif": "Source Serif 4",
  atkinson: "Atkinson Hyperlegible Next",
  "system-sans": "System sans serif",
  "system-mono": "System monospace",
  "jetbrains-mono": "JetBrains Mono",
} satisfies Record<SettingsOption, string>;

function SettingsSelect({ name, label, values, current }: { name: string; label: string; values: readonly SettingsOption[]; current: SettingsOption }) {
  return (
    <label class="setting">
      <span class="setting-label">{label}</span>
      <select name={name} class={SELECT_FIELD} autocomplete="off">
        {values.map((value) => <option value={value} selected={current === value}>{OPTION_LABELS[value]}</option>)}
      </select>
    </label>
  );
}

function SettingsRange({ name, label, current, unit }: { name: keyof typeof READING_RANGES; label: string; current: number; unit: string }) {
  const range = READING_RANGES[name];
  const outputId = `${name}-value`;
  return (
    <label class="setting">
      <span class="setting-label">
        <span>{label}</span>
        <output id={outputId} for={name} class="setting-value" data-cp-range-output data-cp-unit={unit}>{current}{unit}</output>
      </span>
      <input id={name} type="range" name={name} min={range.min} max={range.max} step={range.step} value={current} class={RANGE_FIELD} autocomplete="off" />
    </label>
  );
}

export function SettingsPage({ tokens, context }: { tokens: ApiToken[]; context: PageContext }) {
  const { settings, locale } = context;
  return (
    <Layout title="Settings" context={context} scripts={["reading-settings"]}>
      <Sheet labelledBy="settings-title">
        <h1 id="settings-title" class="sheet-title">Settings</h1>
        <form action="/settings" method="post" class="settings-form" data-cp-settings-form>
          <section class="sheet-section">
            <h2 class="sheet-heading">Appearance</h2>
            <SettingsSelect name="theme" label="Theme" values={THEMES} current={settings.theme} />
          </section>
          <section class="sheet-section">
            <h2 class="sheet-heading">Reading</h2>
            <div class="settings-grid">
              <SettingsSelect name="font" label="Font" values={FONTS} current={settings.font} />
              <SettingsRange name="text_size" label="Text size" current={settings.text_size} unit=" px" />
              <SettingsRange name="line_spacing" label="Line spacing" current={settings.line_spacing} unit="%" />
              <SettingsRange name="paragraph_spacing" label="Paragraph spacing" current={settings.paragraph_spacing} unit="%" />
              <SettingsRange name="text_width" label="Text width" current={settings.text_width} unit=" ch" />
            </div>
            <article
              class="settings-sample"
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
          <p class="sheet-actions">
            <button type="submit" class={SUBMIT}>Save settings</button>
            <span class="sheet-note" aria-live="polite" data-cp-settings-status>Settings save when you submit this form.</span>
          </p>
        </form>
        <section class="sheet-section">
          <h2 class="sheet-heading">API tokens</h2>
          <p class="sheet-note">
            An API token lets another app save pages without interactive sign-in. Anyone with the token can access your account.
            Revoke tokens you no longer use.
          </p>
          <form action="/settings/tokens" method="post" class="inline-form">
            <input type="text" name="name" required aria-label="Name for the new token" autocomplete="off" spellcheck="false" placeholder="Name it after the device or app…" class={FIELD} />
            <button type="submit" class={SUBMIT}>Create token</button>
          </form>
          {tokens.length === 0 ? (
            <p class="sheet-note">You have no API tokens. Create one to let another app save pages.</p>
          ) : <ul class="token-list">{tokens.map((token) => <TokenRow token={token} locale={locale} />)}</ul>}
        </section>
        <section class="sheet-section">
          <h2 class="sheet-heading">Account</h2>
          <p><a href="/logout" class={ACTION}>Sign out</a></p>
        </section>
      </Sheet>
    </Layout>
  );
}
