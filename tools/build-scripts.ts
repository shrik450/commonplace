import { join } from "node:path";

import { CLIENT_SCRIPTS } from "../src/web/client/scripts";

// Bundles one browser script per name in CLIENT_SCRIPTS into public/scripts.
const root = join(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: CLIENT_SCRIPTS.map((name) => join(root, "src", "web", "client", `${name}.ts`)),
  outdir: join(root, "public", "scripts"),
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
