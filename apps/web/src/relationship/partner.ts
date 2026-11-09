import type { ResponseOf } from '@between-pages/contracts';

export type Space = ResponseOf<'spaces'>['spaces'][number];

/** The other participant of a two-person space. */
export const partnerOf = (space: Space, userId: string) =>
  space.participants.find((p) => p.user.id !== userId)!.user;
