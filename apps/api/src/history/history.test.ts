import { describe, expect, it } from 'vitest';
import type { CommitPoint } from '../store/store.ts';
import { historyPoints, nextPointIn } from './history.ts';

const T0 = Date.parse('2026-10-26T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function commits(seconds: number[], generationId = 'g1', authorId = 'a'): CommitPoint[] {
  return seconds.map((s, i) => ({
    version: i + 1,
    publicId: `${generationId}-${s}`,
    generationId,
    authorId,
    committedAt: at(s),
  }));
}

const pointTimes = (points: { committedAt: Date }[]) =>
  points.map((p) => (p.committedAt.getTime() - T0) / 1000);

describe('historyPoints', () => {
  it('groups continuous editing into five-minute spans, each ending at its last commit', () => {
    const everyHalfMinute = Array.from({ length: 25 }, (_, i) => i * 30); // 0 … 720 s

    expect(pointTimes(historyPoints(commits(everyHalfMinute), at(720 + 120)))).toEqual([
      270, 570, 720,
    ]);
  });

  it('ends a group after two minutes without a text commit', () => {
    expect(pointTimes(historyPoints(commits([0, 60, 200, 230]), at(400)))).toEqual([60, 230]);
  });

  it('closes groups after a shorter idle time when the end-to-end suite asks for one', () => {
    expect(pointTimes(historyPoints(commits([0, 5, 30]), at(40), 10_000))).toEqual([5, 30]);
  });

  it('shows no point for a group still being written', () => {
    expect(pointTimes(historyPoints(commits([0, 60, 200, 230]), at(300)))).toEqual([60]);
    expect(historyPoints([], at(0))).toEqual([]);
  });

  it('never merges commits of two generations into one point', () => {
    const timeline = [...commits([0, 30], 'g1'), ...commits([60, 90], 'g2')];

    expect(historyPoints(timeline, at(1000)).map((p) => p.publicId)).toEqual(['g1-30', 'g2-90']);
  });

  it('lists everyone who changed the text in a group', () => {
    const timeline = [...commits([0], 'g1', 'b'), ...commits([30], 'g1', 'a')];

    expect(historyPoints(timeline, at(1000))).toEqual([
      { publicId: 'g1-30', committedAt: at(30), authors: ['a', 'b'] },
    ]);
  });
});

describe('nextPointIn', () => {
  it('says when the group being written closes: two minutes after its last commit', () => {
    expect(nextPointIn(commits([0, 60, 200, 230]), at(300))).toBe(50_000);
  });

  it('says so at five minutes from its first commit when editing never pauses', () => {
    expect(nextPointIn(commits([0, 100, 200, 280]), at(290))).toBe(10_000);
  });

  it('is null once the newest group is a point, or before any commit', () => {
    expect(nextPointIn(commits([0, 60]), at(180))).toBeNull();
    expect(nextPointIn([], at(0))).toBeNull();
  });
});
