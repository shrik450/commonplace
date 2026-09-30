import type { Child } from "./jsx-runtime";

// Inline Lucide icons. Each is decorative: the control it sits in carries the
// accessible name.

function Icon({ size, children }: { size: number; children?: Child }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return <Icon size={size}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>;
}

export function ScissorsIcon({ size = 13 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </Icon>
  );
}

export function PenIcon({ size = 15 }: { size?: number }) {
  return <Icon size={size}><path d="M12 20h9" /><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
}

export function SettingsIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

// A brass paperclip, drawn as two strokes so it reads as wire with a lit edge.
export function Paperclip() {
  const wire = "M8 50V12a5 5 0 0 1 10 0v40a8 8 0 0 1-16 0V16";
  return (
    <svg class="paperclip" viewBox="0 0 26 64" width="26" height="64" aria-hidden="true" focusable="false">
      <path d={wire} fill="none" stroke="var(--color-brass-deep)" stroke-width="3.8" stroke-linecap="round" />
      <path d={wire} fill="none" stroke="var(--color-brass)" stroke-width="2.4" stroke-linecap="round" />
    </svg>
  );
}
