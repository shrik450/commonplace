import { AppError } from "./errors";
import type { UserId } from "./ids";

export const THEMES = ["auto", "light", "dark"] as const;
export const FONTS = ["serif", "sans"] as const;
export const TEXT_SIZES = ["small", "medium", "large"] as const;
export const LINE_SPACINGS = ["compact", "comfortable", "loose"] as const;
export const PARAGRAPH_SPACINGS = ["compact", "comfortable", "loose"] as const;
export const TEXT_WIDTHS = ["narrow", "comfortable", "wide"] as const;

export type Theme = (typeof THEMES)[number];
export type Font = (typeof FONTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type LineSpacing = (typeof LINE_SPACINGS)[number];
export type ParagraphSpacing = (typeof PARAGRAPH_SPACINGS)[number];
export type TextWidth = (typeof TEXT_WIDTHS)[number];

export type UserSettings = {
  user_id: UserId;
  theme: Theme;
  font: Font;
  text_size: TextSize;
  line_spacing: LineSpacing;
  paragraph_spacing: ParagraphSpacing;
  text_width: TextWidth;
};

export type SettingsFields = Readonly<Record<string, string>>;

export function parseSettings(userId: UserId, fields: SettingsFields): UserSettings {
  const read = <T extends string>(name: string, values: readonly T[]): T => {
    const value = fields[name];
    // SAFETY: the form value is checked against the corresponding option list.
    if (value === undefined || !values.includes(value as T)) {
      throw new AppError("VIEW_INVALID_VALUE", `Choose a valid ${name.replaceAll("_", " ")} value, then submit again.`, { field: name });
    }
    // SAFETY: the preceding condition throws unless value is in values.
    return value as T;
  };
  return {
    user_id: userId,
    theme: read("theme", THEMES),
    font: read("font", FONTS),
    text_size: read("text_size", TEXT_SIZES),
    line_spacing: read("line_spacing", LINE_SPACINGS),
    paragraph_spacing: read("paragraph_spacing", PARAGRAPH_SPACINGS),
    text_width: read("text_width", TEXT_WIDTHS),
  };
}

export const DEFAULT_SETTINGS: Omit<UserSettings, "user_id"> = {
  theme: "auto",
  font: "serif",
  text_size: "medium",
  line_spacing: "comfortable",
  paragraph_spacing: "comfortable",
  text_width: "comfortable",
};

