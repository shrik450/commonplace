// Every script the browser can load. Views name scripts from this list, the
// assets route serves only these, and the build bundles one file per name.
export const CLIENT_SCRIPTS = [
  "index-box",
  "book",
  "save-card",
  "submit-shortcut",
  "clip",
  "reading-settings",
] as const;

export type ClientScript = (typeof CLIENT_SCRIPTS)[number];

export function isClientScript(name: string): name is ClientScript {
  return CLIENT_SCRIPTS.some((script) => script === name);
}
