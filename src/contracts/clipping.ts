import { AppError } from "./errors";

// The product calls an annotation a clipping: a passage cut from a saved page,
// with an optional note.

export const NOTE_MAX_LENGTH = 2_000;

export type ClipSelection = { start: number; end: number };

function integerField(fields: URLSearchParams, name: string): number {
  const raw = fields.get(name) ?? "";
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(value)) {
    throw new AppError("VIEW_INVALID_VALUE", `The clipping's ${name} position is missing. Select the passage again.`, { field: name });
  }
  return value;
}

// Reads the offsets a reader's selection produced. Whether they make a valid
// clipping depends on the transcript, which `core/clip.ts` checks.
export function parseClipSelection(fields: URLSearchParams): ClipSelection {
  return { start: integerField(fields, "start"), end: integerField(fields, "end") };
}

function trimmedNote(raw: string | null): string {
  const note = (raw ?? "").trim();
  if (note.length > NOTE_MAX_LENGTH) {
    throw new AppError("VIEW_INVALID_VALUE", `Shorten the note to ${NOTE_MAX_LENGTH} characters or fewer, then save it again.`, { field: "note", length: note.length });
  }
  return note;
}

// A blank note is no note.
export function parseNote(raw: string | null): string | null {
  const note = trimmedNote(raw);
  return note === "" ? null : note;
}

// A page note is nothing but its text, so a blank one is refused. Removing a
// note is its own action, with a confirmation.
export function parsePageNote(raw: string | null): string {
  const note = trimmedNote(raw);
  if (note === "") {
    throw new AppError("VIEW_MISSING_FIELD", "Write something in the note, then save it again. To remove a note, choose “Remove note…”.", { field: "note" });
  }
  return note;
}
