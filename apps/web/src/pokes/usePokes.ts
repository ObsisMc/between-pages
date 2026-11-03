import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';
import type { WindowSide } from '../windows/index.ts';

// The home's two mascots (window-mascots ADR). Poking or petting the viewer's own mascot is
// play in this browser and sends nothing (D1); doing it to the partner's sends a poke or a
// pet, which never fails out loud: it is not something that must arrive (失败与恢复). What
// the partner sent is asked for every 10 s while the home shows and on coming back to it
// (D5); it makes the viewer's mascot hop, says what arrived, and is then confirmed by count,
// so each one plays once (invariant 4).

/** How often the home asks for what the partner sent (D5). */
export const POLL_MS = 10_000;
/** Taps on the partner's mascot this close together count as one streak: "戳了 TA 3 下". */
const STREAK_MS = 2_500;
const SELF_LINES = ['嘿嘿', '痒～', '在呢', '别闹啦'];

type Motion = Pick<WindowSide, 'bounce' | 'bubble' | 'mood'>;
export type Received = { pokes: number; pets: number; lastAt: string };

/** "戳了你 3 下，摸了摸你": what the partner did, for the bubble and the line under it. */
export function receivedText(r: Pick<Received, 'pokes' | 'pets'>): string {
  const parts = [];
  if (r.pokes) parts.push(r.pokes > 1 ? `戳了你 ${r.pokes} 下` : '戳了你一下');
  if (r.pets) parts.push(r.pets > 1 ? `摸了你 ${r.pets} 次` : '摸了摸你');
  return parts.join('，');
}

/** Motions that end by themselves after `ms`. */
function useMotion() {
  const [motion, setMotion] = useState<Motion>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const play = (next: Motion, ms: number) => {
    clearTimeout(timer.current);
    setMotion(next);
    timer.current = setTimeout(() => setMotion({}), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [motion, play] as const;
}

/**
 * The home's pokes while `bound`: the motions of each window, what arrived during this visit
 * (added up), and what tapping or petting each mascot does, the partner's named as the page
 * names them. `partnerAsleep` follows the partner's sleep schedule only (D6).
 */
export function usePokes(bound: boolean, partnerAsleep: boolean) {
  const [mine, playMine] = useMotion();
  const [theirs, playTheirs] = useMotion();
  const [received, setReceived] = useState<Received | null>(null);
  const streak = useRef({ count: 0, at: 0 });
  /** The last answer already played; asked again before its confirmation lands, it is not. */
  const played = useRef<string | null>(null);

  const waiting = useQuery({
    queryKey: ['pokes'],
    queryFn: () => callApi('pokes'),
    enabled: bound,
    refetchInterval: POLL_MS,
    // Every look is a new answer, even one equal to the last, so a confirmation that failed
    // is sent again.
    structuralSharing: false,
  });
  const seen = useMutation({
    mutationFn: (shown: { pokes: number; pets: number }) => callApi('seenPokes', { body: shown }),
  });
  const send = useMutation({
    mutationFn: (kind: 'poke' | 'pet') => callApi('sendPoke', { body: { kind } }),
  });

  // Each answer is handled once, after it is rendered: a new batch plays and adds up; one
  // already played is only confirmed again, by count, so a failed confirmation is retried on
  // the next look without playing the same pokes twice (失败与恢复).
  const onAnswer = useEffectEvent((arrived: Received) => {
    const key = `${arrived.lastAt}:${arrived.pokes}:${arrived.pets}`;
    if (played.current !== key) {
      played.current = key;
      setReceived((before) =>
        before
          ? {
              pokes: before.pokes + arrived.pokes,
              pets: before.pets + arrived.pets,
              lastAt: arrived.lastAt,
            }
          : arrived,
      );
      playMine({ mood: 'happy', bounce: { kind: 'hop', at: Date.now() } }, 2600);
      playTheirs({ bubble: receivedText(arrived) }, 2600);
    }
    seen.mutate({ pokes: arrived.pokes, pets: arrived.pets });
  });
  const answer = waiting.data;
  useEffect(() => {
    if (answer?.received) onAnswer(answer.received);
  }, [answer]);

  const pokeSelf = () => {
    const line = SELF_LINES[Math.floor(Math.random() * SELF_LINES.length)]!;
    playMine({ mood: 'poked', bubble: line, bounce: { kind: 'squish', at: Date.now() } }, 900);
  };
  const petSelf = () => playMine({ mood: 'happy', bubble: '好舒服～' }, 1400);

  const pokePartner = (partnerName: string) => {
    const now = Date.now();
    streak.current = {
      count: now - streak.current.at < STREAK_MS ? streak.current.count + 1 : 1,
      at: now,
    };
    const n = streak.current.count;
    playTheirs(
      {
        mood: partnerAsleep ? 'asleep' : 'poked',
        bubble: partnerAsleep
          ? `嘘…${partnerName}大概在睡`
          : n > 1
            ? `戳了${partnerName} ${n} 下`
            : `戳了${partnerName}一下`,
        bounce: { kind: 'squish', at: now },
      },
      1400,
    );
    send.mutate('poke');
  };
  const petPartner = (partnerName: string) => {
    playTheirs(
      partnerAsleep
        ? { mood: 'asleep', bubble: `${partnerName}睡得更香了` }
        : { mood: 'happy', bubble: `摸了摸${partnerName}` },
      1600,
    );
    send.mutate('pet');
  };

  return { mine, theirs, received, pokeSelf, petSelf, pokePartner, petPartner };
}
