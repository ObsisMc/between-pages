import { MAX_MESSAGE_BYTES } from '@between-pages/contracts';

// The server's rule (packages/collab validate): no C0 control character except tab and
// newline, and no DEL. Text with one would be rejected and stop the whole send queue.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export function hasControlCharacter(text: string): boolean {
  return CONTROL.test(text);
}

/** Clipboard text as diary text: line endings become `\n`, other control characters go. */
export function plainText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(new RegExp(CONTROL.source, 'g'), '');
}

// The 1 MB cap counts the whole JSON submit message with the update in base64, so one
// operation must fit there alone (kernel ADR D13; apps/api README). The reserve covers the
// message's IDs and timestamps and the update's struct header.
const MESSAGE_RESERVE = 4096;
/** UTF-8 bytes of new text one operation may carry when it deletes nothing. */
export const MAX_PASTE_BYTES = Math.floor((MAX_MESSAGE_BYTES - MESSAGE_RESERVE) / 4) * 3;
// Each deleted run adds a delete-set entry: clock and length varints of at most five bytes.
const DELETED_RUN_BYTES = 10;

/**
 * Whether pasting `text` over `replacedRuns` runs of the user's own text yields an update
 * that fits one message; a larger paste is refused at input, never split (D13).
 */
export function pasteFits(text: string, replacedRuns: number): boolean {
  const bytes = new TextEncoder().encode(text).length + replacedRuns * DELETED_RUN_BYTES;
  return bytes <= MAX_PASTE_BYTES;
}
