/**
 * The viewer's local today as YYYY-MM-DD in the device's zone (spec §4): the `/days/:date`
 * links and the month a sharing calendar opens on. The day page asks the server whether
 * that date may be written; the calendars never turn it back into an instant.
 */
export const localToday = () => new Intl.DateTimeFormat('en-CA').format(new Date());
