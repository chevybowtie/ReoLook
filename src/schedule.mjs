// Weekly recording schedule: 7 days x 24 hours, one character per hour, Sunday first
// (the same order as Date#getDay). '0' = do not record, 'm' = record on motion, 'c' = record
// continuously. Local time, because that is how the person reading the grid thinks of it.

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SCHEDULE_PATTERN = /^[0mc]{168}$/;

/** Whether a value is a weekly schedule: 168 characters, one per hour, each 0 (off), m (motion) or c (continuous). */
export const isSchedule = (v) => typeof v === 'string' && SCHEDULE_PATTERN.test(v);

/** A schedule that records `mode` ('motion'|'continuous') in every hour. */
export const fullWeek = (mode = 'motion') => (mode === 'continuous' ? 'c' : 'm').repeat(168);

/** 'off' | 'motion' | 'continuous' for the hour containing `date`. */
export function modeAt(schedule, date) {
  const ch = schedule[date.getDay() * 24 + date.getHours()];
  return ch === 'c' ? 'continuous' : ch === 'm' ? 'motion' : 'off';
}

/** Hours per week in each mode, for a one-line summary. */
export function summary(schedule) {
  /** How many hours of the week have the mode `c`. */
  const n = (c) => [...schedule].filter((x) => x === c).length;
  return { off: n('0'), motion: n('m'), continuous: n('c') };
}
