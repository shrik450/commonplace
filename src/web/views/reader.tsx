import type { Annotation, Item } from "../../contracts/item";
import {
  FONTS,
  LINE_SPACINGS,
  PARAGRAPH_SPACINGS,
  TEXT_SIZES,
  TEXT_WIDTHS,
  type UserSettings,
} from "../../contracts/settings";
import { raw } from "./jsx-runtime";
import { hostOf, readableDate } from "./library";
import { ACTION, LINK, Layout, SUBMIT } from "./layout";
import { SettingsSelect } from "./settings";

export type ReaderProps = {
  item: Item;
  html: string;
  annotations: Annotation[];
  locale: string;
  settings: UserSettings;
  interactive: boolean;
};

function noteCount(total: number): string {
  if (total === 0) return "No highlights yet";
  if (total === 1) return "1 highlight";
  return `${total} highlights`;
}

function SettingsPanel({ settings, itemId }: { settings: UserSettings; itemId: string }) {
  return (
    <details class="cp-rule mt-5 pb-5" data-cp-settings-details>
      <summary class={`cursor-pointer text-sm ${ACTION}`}>Page settings</summary>
      <form class="mt-4" action="/settings" method="post" data-cp-settings-form>
        <fieldset class="grid gap-4 sm:grid-cols-2">
          <legend class="sr-only">Page settings</legend>
          <input type="hidden" name="theme" value={settings.theme} />
          <input type="hidden" name="return_to" value={`/items/${itemId}`} />
          <SettingsSelect name="font" label="Font" values={FONTS} current={settings.font} compact />
          <SettingsSelect name="text_size" label="Text size" values={TEXT_SIZES} current={settings.text_size} compact />
          <SettingsSelect name="line_spacing" label="Line spacing" values={LINE_SPACINGS} current={settings.line_spacing} compact />
          <SettingsSelect name="paragraph_spacing" label="Paragraph spacing" values={PARAGRAPH_SPACINGS} current={settings.paragraph_spacing} compact />
          <SettingsSelect name="text_width" label="Text width" values={TEXT_WIDTHS} current={settings.text_width} compact />
        </fieldset>
        <div class="mt-4 flex flex-wrap items-center gap-5">
          <button type="submit" class={SUBMIT}>Save settings</button>
          <a href="/settings" class={`text-sm ${LINK}`}>All settings</a>
        </div>
        <p class="text-secondary mt-3 text-xs" aria-live="polite" data-cp-settings-status />
      </form>
      <a href={`/items/${itemId}`} class={`mt-3 inline-block text-sm ${ACTION}`}>Close without saving</a>
    </details>
  );
}

export function ReaderPageView({
  item,
  html,
  annotations,
  locale,
  settings,
  interactive,
}: ReaderProps) {
  const host = hostOf(item.url);
  return (
    <Layout title={item.title} settings={settings} settingsScript={interactive}>
      <article
        class="mx-auto pl-6"
        data-cp-reader
        data-cp-font={settings.font}
        data-cp-text-size={settings.text_size}
        data-cp-line-spacing={settings.line_spacing}
        data-cp-paragraph-spacing={settings.paragraph_spacing}
        data-cp-text-width={settings.text_width}
      >
        <header class="cp-rule pb-6">
          <h1 class="font-reading text-3xl leading-tight text-pretty">{item.title}</h1>
          <p class="text-secondary mt-3 text-xs break-words">
            {[item.author, host].filter((part) => part !== null && part !== "").join(" · ")}
            {item.author === null && host === null ? "" : " · "}
            <time datetime={item.created_at}>{readableDate(item.created_at, locale)}</time>
          </p>
          <nav aria-label="Other views of this page" class="text-secondary mt-4 flex flex-wrap gap-4 text-xs">
            <a class={LINK} href={`/items/${item.id}/raw`}>Structured text</a>
            <a class={LINK} href={`/items/${item.id}/capture`}>Saved copy</a>
            <a class={LINK} href={item.url} rel="noreferrer">Original page</a>
            <span>{noteCount(annotations.length)}</span>
          </nav>
          {interactive ? <SettingsPanel settings={settings} itemId={item.id} /> : null}
        </header>
        {/* The projection comes from the archived page rather than this interface. */}
        <div class="mt-8" data-cp-projected>{raw(html)}</div>
      </article>
    </Layout>
  );
}
