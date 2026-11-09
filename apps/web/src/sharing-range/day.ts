// Calendar days are strings that never change time zone (spaces-and-invitations D3). The
// calendar widget needs `Date` objects, so this file is the only place in the module that
// builds one (`eslint.config.js` forbids `new Date(` in the others): a day becomes its UTC
// midnight, and a UTC instant becomes its day. The calendar runs in `timeZone="UTC"`, so
// both directions are the same whatever zone the device is in.

const pad = (n: number) => String(n).padStart(2, '0');

/** The UTC midnight of a `YYYY-MM-DD` day. */
export const toDate = (day: string): Date => new Date(`${day}T00:00:00Z`);

/** The `YYYY-MM-DD` day of a UTC instant, read in UTC. */
export const toDay = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
