import { useQuery } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';
import type { Person } from './DiaryBlock.tsx';

/** The people of the caller's spaces by user ID, for author colors and names. */
export function usePeople(): { people: Map<string, Person>; known: boolean } {
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => callApi('spaces') });
  const people = new Map<string, Person>(
    (spaces.data?.spaces ?? []).flatMap((space) =>
      space.participants.map((p) => [p.user.id, { name: p.user.displayName, slot: p.authorSlot }]),
    ),
  );
  return { people, known: !spaces.isPending };
}

/** The author legend with the one "只看我的文字" switch of the page (EDIT-13, EDIT-14). */
export function AuthorLegend({
  people,
  ownOnly,
  onOwnOnly,
}: {
  people: Map<string, Person>;
  ownOnly: boolean;
  onOwnOnly: (on: boolean) => void;
}) {
  if (people.size === 0) return null;
  return (
    <div className="author-legend" aria-label="作者">
      {[...people.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((person) => (
          <span key={person.slot} className={`author-slot-${person.slot}`}>
            {person.name}
          </span>
        ))}
      <label className="own-only">
        <input type="checkbox" checked={ownOnly} onChange={(e) => onOwnOnly(e.target.checked)} />
        只看我的文字
      </label>
    </div>
  );
}
