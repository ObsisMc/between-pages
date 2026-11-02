/** Who an avatar stands for: a display name and, inside a space, their author slot. */
export type AvatarPerson = { name: string; slot: 1 | 2 | null };

/**
 * A rounded mascot in the person's author color (the space slot's, EDIT-13; book-surface
 * D4), only its outline when they have a diary with no text yet. It never stands alone for
 * the person: its name is the display name, which the page also writes beside it.
 */
export function Avatar({ person, hollow = false }: { person: AvatarPerson; hollow?: boolean }) {
  const classes = [
    'avatar',
    person.slot ? `author-slot-${person.slot}` : '',
    hollow ? 'hollow' : '',
  ];
  return (
    <svg
      className={classes.filter(Boolean).join(' ')}
      viewBox="0 0 42 36"
      role="img"
      aria-label={hollow ? `${person.name}（还没有写字）` : person.name}
    >
      <path
        className="avatar-body"
        d="M2.5 21C2 11 8 3 18 2C28 0 38 6 39 17C42 27 36 34 24 34C11 36 1 32 2.5 21Z"
      />
      <g className="avatar-face">
        <ellipse cx="15" cy="16" rx="1.5" ry="1.9" />
        <ellipse cx="28" cy="16" rx="1.5" ry="1.9" />
        <path d="M19 20q3 4 6 0" fill="none" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    </svg>
  );
}
