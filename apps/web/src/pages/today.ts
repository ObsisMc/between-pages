/**
 * The viewer's local today as YYYY-MM-DD in the device's zone (spec §4), for the
 * `/days/:date` links; the day page asks the server whether that date may be written.
 */
export const localToday = () => new Intl.DateTimeFormat('en-CA').format(new Date());
