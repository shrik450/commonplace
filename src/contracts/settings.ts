import { AppError } from "./errors";
import type { UserId } from "./ids";

export const THEMES = ["auto", "light", "dark"] as const;
export const FONTS = [
  "newsreader",
  "literata",
  "source-serif",
  "atkinson",
  "system-sans",
  "system-mono",
  "jetbrains-mono",
] as const;

export const READING_RANGES = {
  text_size: { min: 16, max: 24, step: 1 },
  line_spacing: { min: 140, max: 200, step: 5 },
  paragraph_spacing: { min: 50, max: 150, step: 5 },
  text_width: { min: 52, max: 84, step: 2 },
} as const;

export type Theme = (typeof THEMES)[number];
export type Font = (typeof FONTS)[number];

export type UserSettings = {
  user_id: UserId;
  theme: Theme;
  font: Font;
  text_size: number;
  line_spacing: number;
  paragraph_spacing: number;
  text_width: number;
};

export type SettingsFields = Readonly<Record<string, string>>;

export function parseSettings(userId: UserId, fields: SettingsFields): UserSettings {
  const readOption = <T extends string>(name: string, values: readonly T[]): T => {
    const value = fields[name];
    // SAFETY: the form value is checked against the corresponding option list.
    if (value === undefined || !values.includes(value as T)) {
      throw new AppError("VIEW_INVALID_VALUE", `Choose a valid ${name.replaceAll("_", " ")} value, then submit again.`, { field: name });
    }
    // SAFETY: the preceding condition throws unless value is in values.
    return value as T;
  };
  const readRange = (name: keyof typeof READING_RANGES): number => {
    const value = Number(fields[name]);
    const range = READING_RANGES[name];
    if (!Number.isInteger(value) || value < range.min || value > range.max || (value - range.min) % range.step !== 0) {
      throw new AppError("VIEW_INVALID_VALUE", `Choose a valid ${name.replaceAll("_", " ")} value, then submit again.`, { field: name });
    }
    return value;
  };
  return {
    user_id: userId,
    theme: readOption("theme", THEMES),
    font: readOption("font", FONTS),
    text_size: readRange("text_size"),
    line_spacing: readRange("line_spacing"),
    paragraph_spacing: readRange("paragraph_spacing"),
    text_width: readRange("text_width"),
  };
}

export const DEFAULT_SETTINGS: Omit<UserSettings, "user_id"> = {
  theme: "auto",
  font: "newsreader",
  text_size: 18,
  line_spacing: 170,
  paragraph_spacing: 90,
  text_width: 68,
};

