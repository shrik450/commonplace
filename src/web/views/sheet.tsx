import type { Child } from "./jsx-runtime";

// A sheet of paper on the desk: the surface for reading, forms, and messages.
// A folded sheet has its top corner turned down, like the reader's page.
export function Sheet({
  labelledBy,
  folded = false,
  narrow = false,
  children,
}: {
  labelledBy: string;
  folded?: boolean;
  narrow?: boolean;
  children?: Child;
}) {
  const classes = ["sheet", folded ? "sheet-folded" : "", narrow ? "sheet-narrow" : ""].filter(Boolean).join(" ");
  const sheet = (
    <article class={classes} aria-labelledby={labelledBy}>
      {folded ? <span class="sheet-fold" aria-hidden="true" /> : null}
      {children}
    </article>
  );
  // A folded sheet's corner is cut away, which would cut its shadow too, so
  // an empty shape behind it casts the shadow instead.
  return folded ? <div class="sheet-frame"><SheetBacking />{sheet}</div> : sheet;
}

// The shadow of a folded sheet: the sheet's outline, blank, behind it. A
// shadow filter on the sheet itself would have to redraw all of its text.
export function SheetBacking() {
  return <span class="sheet-backing" aria-hidden="true" />;
}
