import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import { asUserId, type UserId } from "../contracts/ids";
import type { UserSettings } from "../contracts/settings";
import { write } from "./db";

const COLUMNS = "user_id, theme, font, text_size, line_spacing, paragraph_spacing, text_width";

export function getUserSettings(db: Database, userId: UserId): UserSettings {
  const row = db.query<Omit<UserSettings, "user_id"> & { user_id: string }, [string]>(
    `SELECT ${COLUMNS} FROM user_settings WHERE user_id = ?`,
  ).get(userId);
  if (row === null) {
    throw new AppError("STORE_NOT_FOUND", "user settings do not exist", { user_id: userId });
  }
  return { ...row, user_id: asUserId(row.user_id) };
}

export function updateUserSettings(db: Database, settings: UserSettings): UserSettings {
  write(
    db,
    `INSERT INTO user_settings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme, font=excluded.font,
     text_size=excluded.text_size, line_spacing=excluded.line_spacing,
     paragraph_spacing=excluded.paragraph_spacing, text_width=excluded.text_width`,
    [settings.user_id, settings.theme, settings.font, settings.text_size,
      settings.line_spacing, settings.paragraph_spacing, settings.text_width],
    { user_id: settings.user_id },
  );
  return settings;
}
