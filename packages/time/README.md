# @between-pages/time

The time-zone math both apps share ([email-reminders](../../docs/adr/2026-11-17-email-reminders.md) D11): an instant's wall time and local date in a zone, the instant of a local wall time, calendar-day arithmetic, and whether an instant falls in a usual sleep. Pure functions over Intl, so the web app's two clocks and diary, and the server's anniversaries, wishes, diaries and email reminders all get one answer for daylight-saving days and sleep that crosses midnight.

## Public surface

Everything is exported from the package root (`src/index.ts`).

| Export | Contract |
| --- | --- |
| `LocalDate`, `WallTime`, `Sleep` | A calendar day `{ year, month, day }`; the same plus `{ hour, minute, second }`; a usual sleep as minutes after local midnight `{ start, end }`, crossing midnight when `end` ≤ `start`. |
| `localParts(instant, zone)`, `dateIn(instant, zone)` | The wall time and the calendar date of an instant (epoch milliseconds) in an IANA zone. |
| `isoDateIn(instant, zone)` | `YYYY-MM-DD` of the instant in `zone`, or in UTC when `zone` is `null` (someone who never reported a zone). |
| `localToInstant(date, minute, zone)`, `startOf(date, zone)` | The instant `minute` minutes after local midnight of `date`, and of midnight itself. A wall time skipped by a spring-forward gap maps to the first instant after the gap; a repeated one to its first occurrence. |
| `addDays(date, n)`, `daysBetween(from, to)`, `isoDate(date)` | Calendar-day arithmetic, independent of any zone; `daysBetween` is negative when `to` comes first. |
| `asleepAt(instant, zone, sleep)` | Whether the instant's local minute in `zone` falls in `[start, end)` of the sleep. |

## Invariants

- Wall time is always read back from Intl; nothing adds or subtracts a fixed zone offset, so switch days are 23 or 25 hours long (tested).
- Calendar days move as days: adding one to 2 月 28 日 gives 2 月 29 日 only in a leap year (tested).
- No clock, I/O or environment access: every function takes the instant it works on.
- Rules built on this math stay with their modules: the 23:00–8:00 default quiet hours of email reminders in `apps/api` `notify`, "大概在睡" and shared awake hours in the web app's `two-clocks`, the 2 月 29 日 rule and round days in `apps/api` `anniversaries`.

## Allowed dependencies

- May import: nothing; `vitest` in tests only.
- Must not import: `apps/*`, other packages, Node built-ins, or anything under `prototypes/` ([architecture](../../docs/architecture.md#dependency-direction), `verify-dependency-direction`).

## How to test

```sh
npx vitest run --project time
```

- Tier: unit, see [docs/testing.md](../../docs/testing.md#tiers). `src/time.test.ts` covers switch days in both directions, skipped and repeated wall times, sleep across midnight and across a clock change, and day arithmetic across 2 月 29 日. The callers' own tests (two clocks, anniversaries) still check the rules they build on it.

## Known limitations

- Zone names are not validated here; an unknown zone throws from Intl, so callers pass only zones that passed the contracts' `TimeZone` schema.
- A sleep is matched by wall minute only, so on the night clocks fall back the repeated hour counts as asleep twice, and a skipped hour never does.
