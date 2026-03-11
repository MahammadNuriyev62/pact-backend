import { v4 as uuid } from 'uuid';
import db from './db';
import { sendPushToUser } from './push';
import { getTodayInTimezone, getCurrentTimeInTimezone, utcTimestampToDateInTimezone } from './timezone';
import { computePersonalSubmissionStreak, computeFreezeInfo, computeWeeklyFreezeInfo, getWeekKey, MAX_FREEZES, DAYS_PER_FREEZE, FREEZE_COOLDOWN_DAYS, MIN_WEEKS_FOR_FREEZE } from './routes/streaks';

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

/**
 * Auto-apply streak freezes for yesterday.
 * After a day ends, check if any user missed a submission and has an available freeze.
 * If so, auto-consume it to protect the streak.
 */
function autoApplyFreezes() {
  const pacts = db.prepare(`
    SELECT DISTINCT p.* FROM pacts p
    JOIN pact_participants pp ON pp.pact_id = p.id AND pp.status = 'accepted'
  `).all() as any[];

  for (const pact of pacts) {
    if (pact.frequency !== 'daily') continue;

    const tz = pact.timezone || 'UTC';
    const today = getTodayInTimezone(tz);

    // Calculate yesterday
    const todayD = new Date(today + 'T00:00:00Z');
    todayD.setUTCDate(todayD.getUTCDate() - 1);
    const yesterday = todayD.toISOString().split('T')[0];

    const participants = db.prepare(
      `SELECT user_id FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
    ).all(pact.id) as any[];

    for (const p of participants) {
      // Check if user submitted yesterday
      const subs = db.prepare(
        'SELECT timestamp FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1'
      ).all(pact.id, p.user_id) as any[];
      const submissionDates = new Set(subs.map((s: any) => utcTimestampToDateInTimezone(s.timestamp, tz)));

      if (submissionDates.has(yesterday)) continue; // Already submitted

      // Check if freeze already applied for yesterday
      const existingFreeze = db.prepare(
        'SELECT id FROM streak_freezes WHERE pact_id = ? AND user_id = ? AND used_for_date = ?'
      ).get(pact.id, p.user_id, yesterday);
      if (existingFreeze) continue; // Already frozen

      // Compute freeze availability
      const freezeInfo = computeFreezeInfo(pact.id, p.user_id, submissionDates, today);

      if (freezeInfo.available <= 0) continue; // No freezes available
      if (freezeInfo.onCooldown) continue; // On cooldown

      // Check that user actually had a streak going (no freeze for first-day misses)
      // Compute what the personal streak was as of the day before yesterday
      const dayBeforeYesterday = new Date(yesterday + 'T00:00:00Z');
      dayBeforeYesterday.setUTCDate(dayBeforeYesterday.getUTCDate() - 1);
      const dby = dayBeforeYesterday.toISOString().split('T')[0];

      const freezeRows = db.prepare(
        'SELECT used_for_date FROM streak_freezes WHERE pact_id = ? AND user_id = ?'
      ).all(pact.id, p.user_id) as any[];
      const freezeDateSet = new Set(freezeRows.map((r: any) => r.used_for_date));
      const streakBeforeMiss = computePersonalSubmissionStreak(submissionDates, freezeDateSet, dby);

      if (streakBeforeMiss < 3) continue; // Must have at least 3-day streak to auto-freeze

      // Apply the freeze!
      db.prepare(
        'INSERT INTO streak_freezes (id, pact_id, user_id, used_for_date, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(uuid(), pact.id, p.user_id, yesterday, new Date().toISOString());

      // Notify user
      const message = `A streak freeze was used to protect your streak in "${pact.title}" for ${yesterday}. You have ${freezeInfo.available - 1} freeze${freezeInfo.available - 1 === 1 ? '' : 's'} left.`;

      db.prepare(
        'INSERT INTO notifications (id, type, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuid(), 'streak_freeze', pact.id, p.user_id, message, new Date().toISOString());

      sendPushToUser(p.user_id, {
        title: 'Streak Freeze Used!',
        body: message,
        icon: '/icon-192x192.png',
        url: `/pact/${pact.id}`,
        tag: `freeze-${pact.id}-${yesterday}`,
      });

      console.log(`[Scheduler] Auto-applied freeze for user ${p.user_id} in "${pact.title}" for ${yesterday}`);
    }
  }
}

/**
 * Auto-apply streak freezes for weekly pacts at the start of a new week.
 * Checks previous week: if a user's submissions < target and they have available freezes,
 * consumes (target - submissions) freezes to protect the streak.
 */
function autoApplyWeeklyFreezes() {
  const pacts = db.prepare(`
    SELECT DISTINCT p.* FROM pacts p
    JOIN pact_participants pp ON pp.pact_id = p.id AND pp.status = 'accepted'
  `).all() as any[];

  for (const pact of pacts) {
    if (pact.frequency !== 'weekly') continue;

    const tz = pact.timezone || 'UTC';
    const today = getTodayInTimezone(tz);
    const todayD = new Date(today + 'T00:00:00Z');
    const dayOfWeek = todayD.getUTCDay(); // 0=Sunday

    // Only check on Sunday (new week start) or Monday (grace period)
    if (dayOfWeek > 1) continue;

    // Compute previous week's Sunday start
    const prevWeekStart = new Date(todayD);
    prevWeekStart.setUTCDate(todayD.getUTCDate() - dayOfWeek - 7);
    const prevWeekKey = prevWeekStart.toISOString().split('T')[0];

    const target = pact.times_per_week || 3;
    const firstWeekKey = pact.created_at ? getWeekKey(pact.created_at.split('T')[0]) : null;
    if (prevWeekKey === firstWeekKey) continue; // Free pass week

    const participants = db.prepare(
      `SELECT user_id FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
    ).all(pact.id) as any[];

    for (const p of participants) {
      // Count submissions in previous week
      const subs = db.prepare(
        'SELECT timestamp FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1'
      ).all(pact.id, p.user_id) as any[];
      const submissionDates = new Set(subs.map((s: any) => utcTimestampToDateInTimezone(s.timestamp, tz)));

      let subsInPrevWeek = 0;
      for (const d of submissionDates) {
        if (getWeekKey(d) === prevWeekKey) subsInPrevWeek++;
      }

      if (subsInPrevWeek >= target) continue; // Met target

      // Check if freeze already applied for this week
      const existingFreeze = db.prepare(
        'SELECT id FROM streak_freezes WHERE pact_id = ? AND user_id = ? AND used_for_date = ?'
      ).get(pact.id, p.user_id, prevWeekKey);
      if (existingFreeze) continue;

      // Compute weekly freeze availability
      const wfInfo = computeWeeklyFreezeInfo(
        pact.id, p.user_id, submissionDates, today, target, pact.created_at
      );

      const deficit = target - subsInPrevWeek;
      if (wfInfo.available < deficit) continue; // Not enough freezes
      if (wfInfo.onCooldown) continue;
      if (wfInfo.personalStreak < MIN_WEEKS_FOR_FREEZE) continue; // Need 3 completed weeks minimum

      // Apply freezes (one row with count = deficit)
      db.prepare(
        'INSERT INTO streak_freezes (id, pact_id, user_id, used_for_date, count, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuid(), pact.id, p.user_id, prevWeekKey, deficit, new Date().toISOString());

      // Notify
      const remaining = wfInfo.available - deficit;
      const message = `${deficit} streak freeze${deficit > 1 ? 's were' : ' was'} used to protect your streak in "${pact.title}" for last week. You have ${remaining} freeze${remaining === 1 ? '' : 's'} left.`;

      db.prepare(
        'INSERT INTO notifications (id, type, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuid(), 'streak_freeze', pact.id, p.user_id, message, new Date().toISOString());

      sendPushToUser(p.user_id, {
        title: 'Streak Freeze Used!',
        body: message,
        icon: '/icon-192x192.png',
        url: `/pact/${pact.id}`,
        tag: `freeze-${pact.id}-${prevWeekKey}`,
      });

      console.log(`[Scheduler] Auto-applied ${deficit} weekly freeze(s) for user ${p.user_id} in "${pact.title}" for week ${prevWeekKey}`);
    }
  }
}

function runScheduledTasks() {
  checkDeadlineReminders();
  autoApplyFreezes();
  autoApplyWeeklyFreezes();
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  console.log('[Scheduler] Starting scheduler (every 30 min)');
  // Run once immediately
  runScheduledTasks();
  // Then every 30 minutes
  intervalId = setInterval(runScheduledTasks, REMINDER_INTERVAL_MS);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
