import { v4 as uuid } from 'uuid';
import db from './db';
import { sendPushToUser } from './push';
import { getTodayInTimezone, getCurrentTimeInTimezone, utcTimestampToDateInTimezone } from './timezone';

const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes
const REMINDER_HOURS_BEFORE = 4; // Send reminder 4 hours before deadline

/**
 * Sends deadline reminders for daily pacts.
 * Runs periodically and checks if we're within REMINDER_HOURS_BEFORE of each pact's deadline.
 * Only notifies users who haven't submitted today and haven't been reminded today.
 */
function checkDeadlineReminders() {
  // Get all active pacts
  const pacts = db.prepare(`
    SELECT DISTINCT p.* FROM pacts p
    JOIN pact_participants pp ON pp.pact_id = p.id AND pp.status = 'accepted'
  `).all() as any[];

  for (const pact of pacts) {
    if (pact.frequency !== 'daily') continue;

    // Use the pact's timezone for all time calculations
    const tz = pact.timezone || 'UTC';
    const today = getTodayInTimezone(tz);
    const { hours: currentHour, minutes: currentMinute } = getCurrentTimeInTimezone(tz);
    const nowMinutes = currentHour * 60 + currentMinute;

    // Parse deadline (HH:MM format, default 23:59)
    const deadline = pact.deadline || '23:59';
    const [deadlineHour, deadlineMinute] = deadline.split(':').map(Number);
    const deadlineMinutes = deadlineHour * 60 + deadlineMinute;

    // Calculate reminder time (4 hours before deadline)
    const reminderMinutes = deadlineMinutes - (REMINDER_HOURS_BEFORE * 60);

    // Check if we're in the reminder window (within 30 min of reminder time)
    // Handle wrap-around for deadlines early in the day
    const diff = nowMinutes - reminderMinutes;
    if (diff < 0 || diff >= 30) continue;

    // Get accepted participants
    const participants = db.prepare(
      `SELECT user_id FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
    ).all(pact.id) as any[];

    for (const p of participants) {
      // Check if user already submitted today (using pact timezone for date comparison)
      const userSubs = db.prepare(
        `SELECT timestamp FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1 ORDER BY timestamp DESC LIMIT 5`
      ).all(pact.id, p.user_id) as any[];
      const submittedToday = userSubs.some((s: any) => utcTimestampToDateInTimezone(s.timestamp, tz) === today);

      if (submittedToday) continue;

      // Check if we already sent a reminder today for this pact+user
      const recentNotifs = db.prepare(
        `SELECT timestamp FROM notifications WHERE type = 'deadline_warning' AND pact_id = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 3`
      ).all(pact.id, p.user_id) as any[];
      const alreadyReminded = recentNotifs.some((n: any) => utcTimestampToDateInTimezone(n.timestamp, tz) === today);

      if (alreadyReminded) continue;

      // Create reminder notification
      const hoursLeft = Math.max(1, Math.round((deadlineMinutes - nowMinutes) / 60));
      const message = `${hoursLeft}h left to complete "${pact.title}" today! Don't break the streak!`;

      db.prepare(
        'INSERT INTO notifications (id, type, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuid(), 'deadline_warning', pact.id, p.user_id, message, new Date().toISOString());

      sendPushToUser(p.user_id, {
        title: 'Streak at Risk!',
        body: message,
        icon: '/icon-192x192.png',
        url: `/pact/${pact.id}`,
        tag: `deadline-${pact.id}-${today}`,
      });

      console.log(`[Scheduler] Sent deadline reminder to user ${p.user_id} for pact "${pact.title}"`);
    }
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  console.log('[Scheduler] Starting deadline reminder scheduler (every 30 min)');
  // Run once immediately
  checkDeadlineReminders();
  // Then every 30 minutes
  intervalId = setInterval(checkDeadlineReminders, REMINDER_INTERVAL_MS);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
