import type { Scheduler } from './scheduler.js';
import type { EventBus } from '../server/bus.js';

interface CronField { values: Set<number>; wildcard: boolean }
function field(source: string, minimum: number, maximum: number, sunday = false): CronField {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) throw new Error(`Invalid cron field: ${source}`);
    const step = match[2] ? Number(match[2]) : 1;
    if (!Number.isSafeInteger(step) || step < 1 || step > maximum - minimum + 1) throw new Error(`Invalid cron step: ${part}`);
    let start: number, end: number;
    if (match[1] === '*') { start = minimum; end = maximum; }
    else if (match[1].includes('-')) [start, end] = match[1].split('-').map(Number);
    else { start = Number(match[1]); end = match[2] ? maximum : start; }
    if (start < minimum || end > maximum || end < start) throw new Error(`Cron field out of range: ${source}`);
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values, wildcard: source === '*' };
}

/** Standard five-field local-time cron: lists, ranges, steps, and DOM/DOW OR. */
export function parseCron(expression: string): (now: Date) => boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule must have five cron fields: minute hour day month weekday');
  const [minute, hour, day, month, weekday] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7, true)];
  return now => {
    if (!minute.values.has(now.getMinutes()) || !hour.values.has(now.getHours()) || !month.values.has(now.getMonth() + 1)) return false;
    const matchesDay = day.values.has(now.getDate()), matchesWeekday = weekday.values.has(now.getDay());
    return day.wildcard ? matchesWeekday : weekday.wildcard ? matchesDay : matchesDay || matchesWeekday;
  };
}

export function installSchedules(scheduler: Scheduler, bus: EventBus = scheduler.bus): { tick(now?: Date): Promise<void>; close(): void } {
  let closed = false;
  const fired = new Map<string, string>();
  const tick = async (now = new Date()): Promise<void> => {
    if (closed) return;
    const minute = now.toISOString().slice(0, 16);
    const due: string[] = [];
    for (const node of scheduler.graph.nodes) {
      if (!node.fm.schedule || node.kind === 'fanout' || node.status === 'invalid') continue;
      try {
        if (fired.get(node.id) === minute || !parseCron(node.fm.schedule)(now)) continue;
      } catch (error) {
        node.status = 'invalid'; node.reason = `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`;
        bus.emit('schedule.error', { node: node.id, error: node.reason });
        continue;
      }
      fired.set(node.id, minute);
      scheduler.store.record(node.id).scheduledTick = minute;
      due.push(node.id);
    }
    if (due.length) {
      await scheduler.store.save();
      bus.emit('schedule.tick', { nodes: due, minute });
      if (!closed) await scheduler.run({ automatic: true });
    }
  };
  const interval = setInterval(() => { void tick().catch(error => bus.emit('schedule.error', { error: error instanceof Error ? error.message : String(error) })); }, 1000);
  interval.unref();
  return { tick, close() { closed = true; clearInterval(interval); } };
}
