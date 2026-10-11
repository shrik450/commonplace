import type { Child } from "./jsx-runtime";

// A sheet of paper on the desk: the surface for reading, forms, and messages.
export function Sheet({
  labelledBy,
  narrow = false,
  children,
}: {
  labelledBy: string;
  narrow?: boolean;
  children?: Child;
}) {
  return (
    <article class={narrow ? "sheet sheet-narrow" : "sheet"} aria-labelledby={labelledBy}>
      {children}
    </article>
  );
}

// The shadow of a folded sheet: the sheet's outline, blank, behind it. A
// shadow filter on the sheet itself would have to redraw all of its text.
export function SheetBacking() {
  return <span class="sheet-backing" aria-hidden="true" />;
}
