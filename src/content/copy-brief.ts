// The "Copy as brief" action's clipboard write.
//
// It runs on the user's click, so navigator.clipboard.writeText needs no
// manifest permission (clipboardWrite is deliberately not requested), and the
// extension never reads the clipboard. test/brief.test.ts pins both.

export type ClipboardWriter = Pick<Clipboard, "writeText">;

/** Writes the text; false when the browser refuses or has no clipboard to write to. */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | null = typeof navigator === "undefined" ? null : (navigator.clipboard ?? null),
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** What the button says before a click, after a copy, and after a refusal. */
export const COPY_LABELS = { idle: "Copy", done: "Copied", failed: "Not copied" } as const;
