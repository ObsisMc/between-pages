/** Who an avatar stands for: a display name and, inside a space, their author slot. */
export type AvatarPerson = { name: string; slot: 1 | 2 | null };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first character of a display name, as the avatar shows it (unread-and-day-page D3):
 * the first grapheme, so an emoji or a combined letter stays whole, upper-cased for Latin
 * letters; "?" for a blank name.
 */
export function initialOf(name: string): string {
  const [first] = graphemes.segment(name.trim());
  return first ? first.segment.toLocaleUpperCase() : '?';
}

/**
 * A round avatar with the person's initial in their author color (the space slot's ink,
 * EDIT-13); hollow when they have a diary with no text yet. An image replaces the initial
 * once accounts have one; nothing else changes.
 */
export function Avatar({ person, hollow = false }: { person: AvatarPerson; hollow?: boolean }) {
  // The circle is the person's ink (`author-slot-N`, the soft ink outside a space); the
  // initial is paper on it, or the ink itself when hollow.
  const classes = [
    'inline-grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-current font-sans text-sm leading-none',
    person.slot ? `author-slot-${person.slot}` : 'text-ink-soft',
    hollow ? 'bg-transparent' : 'bg-current',
  ];
  return (
    <span
      className={classes.join(' ')}
      role="img"
      aria-label={hollow ? `${person.name}（还没有写字）` : person.name}
    >
      <span aria-hidden="true" className={hollow ? undefined : 'text-paper'}>
        {initialOf(person.name)}
      </span>
    </span>
  );
}
