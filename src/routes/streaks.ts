import { Router, Response } from 'express';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { getTodayInTimezone, utcTimestampToDateInTimezone } from '../timezone';

const router = Router();

/** Max freezes a user can bank per pact (daily) */
const MAX_FREEZES = 2;
/** Days of consecutive personal submissions needed to earn 1 freeze */
const DAYS_PER_FREEZE = 7;
/** Minimum days between freeze uses */
const FREEZE_COOLDOWN_DAYS = 7;

/** Consecutive completed weeks needed to earn 1 weekly freeze */
const WEEKS_PER_FREEZE = 2;
/** Minimum completed weeks before weekly freezes activate */
const MIN_WEEKS_FOR_FREEZE = 3;
/** Weeks of cooldown after any weekly freeze use */
const WEEKLY_FREEZE_COOLDOWN_WEEKS = 2;

/** Helper: get the Sunday that starts the week containing a date string */
function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const weekStart = new Date(d);
  weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return weekStart.toISOString().split('T')[0];
}

function computeStreak(completedDates: string[], frequency: string, today: string, timesPerWeek?: number, createdAt?: string, weeklyFreezes?: Map<string, number>): { currentStreak: number; longestStreak: number } {
  if (completedDates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const sorted = [...completedDates].sort();

  if (frequency === 'weekly') {
    // Group submissions by week (Sunday-start)
    const weeks = new Map<string, number>();
    for (const date of sorted) {
      const weekKey = getWeekKey(date);
      weeks.set(weekKey, (weeks.get(weekKey) || 0) + 1);
    }

    const target = timesPerWeek || 3;

    // Determine first week key (free pass — excluded from streak)
    const firstWeekKey = createdAt ? getWeekKey(createdAt.split('T')[0]) : null;

    // Filter out the first week from streak computation
    const weekKeys = [...weeks.keys()].sort().filter(k => k !== firstWeekKey);
    if (weekKeys.length === 0) return { currentStreak: 0, longestStreak: 0 };

    let currentStreak = 0;
    let longestStreak = 0;
    let streak = 0;

    const todayD = new Date(today + 'T00:00:00Z');
    const currentWeekKey = getWeekKey(today);

    for (let i = 0; i < weekKeys.length; i++) {
      // Check for gap: if previous week exists, ensure they're consecutive (7 days apart)
      if (i > 0) {
        const prev = new Date(weekKeys[i - 1] + 'T00:00:00Z');
        const curr = new Date(weekKeys[i] + 'T00:00:00Z');
        const gapDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
        if (gapDays > 7) {
          streak = 0; // Gap week(s) missed — streak breaks
        }
      }

      const subsCount = weeks.get(weekKeys[i]) || 0;
      const freezeCount = weeklyFreezes?.get(weekKeys[i]) || 0;
      if (subsCount + freezeCount >= target) {
        streak++;
        longestStreak = Math.max(longestStreak, streak);
      } else {
        streak = 0;
      }
    }

    // Current streak is valid if the last counted week is this week or last week
    const lastWeekKey = weekKeys[weekKeys.length - 1];
    const lastWeekD = new Date(lastWeekKey + 'T00:00:00Z');
    const diffDays = Math.round((todayD.getTime() - lastWeekD.getTime()) / (1000 * 60 * 60 * 24));
    currentStreak = diffDays <= 13 ? streak : 0;

    return { currentStreak, longestStreak };
  }

  // Daily streak
  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 1;

  const uniqueDates = [...new Set(sorted)];

  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = new Date(uniqueDates[i - 1] + 'T00:00:00Z');
    const curr = new Date(uniqueDates[i] + 'T00:00:00Z');
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      streak++;
    } else {
      streak = 1;
    }
    longestStreak = Math.max(longestStreak, streak);
  }

  const lastDate = uniqueDates[uniqueDates.length - 1];
  const lastD = new Date(lastDate + 'T00:00:00Z');
  const todayD = new Date(today + 'T00:00:00Z');
  const diffFromToday = Math.round((todayD.getTime() - lastD.getTime()) / (1000 * 60 * 60 * 24));

  if (diffFromToday <= 1) {
    currentStreak = streak;
  }

  longestStreak = Math.max(longestStreak, streak);

  return { currentStreak, longestStreak };
}

/**
 * Compute the personal consecutive submission streak (excluding freeze days)
 * going backwards from today. Returns the count of real submission days.
 */
function computePersonalSubmissionStreak(submissionDates: Set<string>, freezeDates: Set<string>, today: string): number {
  let streak = 0;
  const d = new Date(today + 'T00:00:00Z');

  // Start from today, go backwards
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().split('T')[0];
    if (submissionDates.has(dateStr)) {
      streak++;
    } else if (freezeDates.has(dateStr)) {
      // Freeze day — skip it (don't break streak, don't count toward earning)
    } else {
      break; // Gap — streak ends
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return streak;
}

/**
 * Compute freeze info for a user+pact.
 * Returns available count, used dates, cooldown status.
 */
function computeFreezeInfo(pactId: string, userId: string, submissionDates: Set<string>, today: string) {
  // Get all freeze dates for this user+pact
  const freezeRows = db.prepare(
    'SELECT used_for_date FROM streak_freezes WHERE pact_id = ? AND user_id = ? ORDER BY used_for_date'
  ).all(pactId, userId) as any[];
  const freezeDates = new Set(freezeRows.map((r: any) => r.used_for_date));
  const freezeDatesArr = freezeRows.map((r: any) => r.used_for_date);

  // Personal submission streak (real submissions only, skipping freeze days)
  const personalStreak = computePersonalSubmissionStreak(submissionDates, freezeDates, today);

  // Earned freezes based on personal submission streak
  const totalEarned = Math.floor(personalStreak / DAYS_PER_FREEZE);

  // Used freezes count
  const usedCount = freezeDates.size;

  // Available (earned minus used, capped at MAX)
  const available = Math.max(0, Math.min(MAX_FREEZES, totalEarned) - usedCount);

  // Last freeze date for cooldown check
  const lastFreezeDate = freezeDatesArr.length > 0 ? freezeDatesArr[freezeDatesArr.length - 1] : null;

  let onCooldown = false;
  if (lastFreezeDate) {
    const lastD = new Date(lastFreezeDate + 'T00:00:00Z');
    const todayD = new Date(today + 'T00:00:00Z');
    const daysSince = Math.round((todayD.getTime() - lastD.getTime()) / (1000 * 60 * 60 * 24));
    onCooldown = daysSince < FREEZE_COOLDOWN_DAYS;
  }

  return {
    available,
    totalEarned: Math.min(MAX_FREEZES, totalEarned),
    used: usedCount,
    freezeDates: [...freezeDates],
    lastFreezeDate,
    onCooldown,
    personalStreak,
    nextFreezeIn: personalStreak >= DAYS_PER_FREEZE * MAX_FREEZES ? 0 : DAYS_PER_FREEZE - (personalStreak % DAYS_PER_FREEZE),
  };
}

/**
 * Compute freeze info for a user+pact on a weekly pact.
 * Max freezes = timesPerWeek + 1. Each freeze covers 1 missed submission in a week.
 * Earn 1 freeze per 3 consecutive completed weeks. 2-week cooldown after use.
 */
function computeWeeklyFreezeInfo(
  pactId: string,
  userId: string,
  submissionDates: Set<string>,
  today: string,
  timesPerWeek: number,
  createdAt: string
) {
  const maxFreezes = timesPerWeek + 1;

  // Get all freeze rows for this user+pact
  const freezeRows = db.prepare(
    'SELECT used_for_date, count FROM streak_freezes WHERE pact_id = ? AND user_id = ? ORDER BY used_for_date'
  ).all(pactId, userId) as any[];

  // Total freezes consumed (sum of counts)
  const totalUsed = freezeRows.reduce((sum: number, r: any) => sum + (r.count || 1), 0);
  const freezeWeekKeys = freezeRows.map((r: any) => r.used_for_date);

  // Group submissions by week
  const weekSubmissions = new Map<string, number>();
  for (const date of submissionDates) {
    const wk = getWeekKey(date);
    weekSubmissions.set(wk, (weekSubmissions.get(wk) || 0) + 1);
  }

  // Build freeze map (week -> count) for completed-week checks
  const freezeMap = new Map<string, number>();
  for (const r of freezeRows) {
    freezeMap.set(r.used_for_date, r.count || 1);
  }

  // Get sorted week keys (exclude creation week and current week)
  const firstWeekKey = createdAt ? getWeekKey(createdAt.split('T')[0]) : null;
  const currentWeekKey = getWeekKey(today);

  const allWeekKeys = new Set<string>();
  for (const wk of weekSubmissions.keys()) allWeekKeys.add(wk);
  for (const wk of freezeMap.keys()) allWeekKeys.add(wk);

  const completedWeekKeys = [...allWeekKeys]
    .filter(k => k !== firstWeekKey && k < currentWeekKey)
    .sort();

  // Count consecutive completed weeks going backwards (submissions + freezes >= target)
  let consecutiveWeeks = 0;
  for (let i = completedWeekKeys.length - 1; i >= 0; i--) {
    const wk = completedWeekKeys[i];

    // Check for gap with the next week we already counted
    if (i < completedWeekKeys.length - 1) {
      const curr = new Date(wk + 'T00:00:00Z');
      const next = new Date(completedWeekKeys[i + 1] + 'T00:00:00Z');
      const gapDays = Math.round((next.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24));
      if (gapDays > 7) break;
    }

    const subs = weekSubmissions.get(wk) || 0;
    const freezes = freezeMap.get(wk) || 0;
    if (subs + freezes >= timesPerWeek) {
      consecutiveWeeks++;
    } else {
      break;
    }
  }

  // Earned freezes: 1 per WEEKS_PER_FREEZE consecutive completed weeks
  const totalEarned = Math.floor(consecutiveWeeks / WEEKS_PER_FREEZE);
  const available = Math.max(0, Math.min(maxFreezes, totalEarned) - totalUsed);

  // Cooldown check: weeks since last freeze use
  const lastFreezeWeek = freezeWeekKeys.length > 0 ? freezeWeekKeys[freezeWeekKeys.length - 1] : null;
  let onCooldown = false;
  if (lastFreezeWeek) {
    const lastD = new Date(lastFreezeWeek + 'T00:00:00Z');
    const todayD = new Date(currentWeekKey + 'T00:00:00Z');
    const weeksSince = Math.round((todayD.getTime() - lastD.getTime()) / (1000 * 60 * 60 * 24 * 7));
    onCooldown = weeksSince < WEEKLY_FREEZE_COOLDOWN_WEEKS;
  }

  // Progress toward next freeze
  const nextFreezeIn = consecutiveWeeks >= WEEKS_PER_FREEZE * maxFreezes
    ? 0
    : WEEKS_PER_FREEZE - (consecutiveWeeks % WEEKS_PER_FREEZE);

  return {
    available,
    totalEarned: Math.min(maxFreezes, totalEarned),
    used: totalUsed,
    freezeDates: freezeWeekKeys,
    lastFreezeDate: lastFreezeWeek,
    onCooldown,
    personalStreak: consecutiveWeeks,
    nextFreezeIn,
    maxFreezes,
  };
}

// Get unified streaks per pact (streak only increments when ALL participants complete)
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactIds = db.prepare(
    `SELECT pact_id FROM pact_participants WHERE user_id = ? AND status = 'accepted'`
  ).all(req.userId!) as any[];

  const streaks: any[] = [];

  for (const row of pactIds) {
    const pact = db.prepare('SELECT * FROM pacts WHERE id = ?').get(row.pact_id) as any;
    if (!pact) continue;

    const tz = pact.timezone || 'UTC';
    const today = getTodayInTimezone(tz);

    // Get all accepted participants in this pact
    const participants = db.prepare(
      `SELECT user_id FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
    ).all(row.pact_id) as any[];

    const participantCount = participants.length;

    // Get submission timestamps per participant, convert to dates in pact timezone
    const perUserDates: Map<string, Set<string>> = new Map();
    for (const p of participants) {
      const subs = db.prepare(
        'SELECT timestamp FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1'
      ).all(row.pact_id, p.user_id) as any[];
      const dates = new Set(subs.map((s: any) => utcTimestampToDateInTimezone(s.timestamp, tz)));
      perUserDates.set(p.user_id, dates);
    }

    // Get freeze dates per participant
    const perUserFreezeDates: Map<string, Set<string>> = new Map();
    for (const p of participants) {
      const freezeRows = db.prepare(
        'SELECT used_for_date FROM streak_freezes WHERE pact_id = ? AND user_id = ?'
      ).all(row.pact_id, p.user_id) as any[];
      perUserFreezeDates.set(p.user_id, new Set(freezeRows.map((r: any) => r.used_for_date)));
    }

    // Effective dates per user = submissions ∪ freezes
    const perUserEffective: Map<string, Set<string>> = new Map();
    for (const p of participants) {
      const effective = new Set(perUserDates.get(p.user_id) || new Set());
      const freezes = perUserFreezeDates.get(p.user_id) || new Set();
      for (const d of freezes) effective.add(d);
      perUserEffective.set(p.user_id, effective);
    }

    // Unified completed dates/weeks: depends on frequency
    const unifiedDates: string[] = [];
    let weeklyFreezeMap: Map<string, number> | undefined;

    if (pact.frequency === 'weekly') {
      // For weekly pacts, compute at the week level:
      // A week is "unified complete" if every participant's (submissions + freezes) >= target
      const target = pact.times_per_week || 3;
      const firstWeekKey = pact.created_at ? getWeekKey(pact.created_at.split('T')[0]) : null;

      // Collect all week keys from all participants
      const allWeekKeys = new Set<string>();
      for (const dates of perUserDates.values()) {
        for (const d of dates) allWeekKeys.add(getWeekKey(d));
      }

      // Build per-user freeze counts per week
      const perUserWeeklyFreezes: Map<string, Map<string, number>> = new Map();
      for (const p of participants) {
        const userFreezes = new Map<string, number>();
        const freezeRows = db.prepare(
          'SELECT used_for_date, count FROM streak_freezes WHERE pact_id = ? AND user_id = ?'
        ).all(row.pact_id, p.user_id) as any[];
        for (const r of freezeRows) {
          userFreezes.set(r.used_for_date, r.count || 1);
          allWeekKeys.add(r.used_for_date);
        }
        perUserWeeklyFreezes.set(p.user_id, userFreezes);
      }

      // Build aggregate freeze map for computeStreak
      weeklyFreezeMap = new Map<string, number>();
      for (const wk of allWeekKeys) {
        // Min freeze count across all participants for this week (unified)
        let minFreezes = Infinity;
        for (const p of participants) {
          const userFreezes = perUserWeeklyFreezes.get(p.user_id) || new Map();
          minFreezes = Math.min(minFreezes, userFreezes.get(wk) || 0);
        }
        if (minFreezes > 0 && minFreezes < Infinity) {
          weeklyFreezeMap.set(wk, minFreezes);
        }
      }

      for (const wk of allWeekKeys) {
        if (wk === firstWeekKey) continue;
        let allMet = true;
        for (const p of participants) {
          const userDates = perUserDates.get(p.user_id) || new Set();
          let subsInWeek = 0;
          for (const d of userDates) {
            if (getWeekKey(d) === wk) subsInWeek++;
          }
          const userFreezes = perUserWeeklyFreezes.get(p.user_id) || new Map();
          const freezeCount = userFreezes.get(wk) || 0;
          if (subsInWeek + freezeCount < target) {
            allMet = false;
            break;
          }
        }
        if (allMet) {
          // Add synthetic dates so computeStreak can group by week
          const weekStart = new Date(wk + 'T00:00:00Z');
          for (let i = 0; i < target; i++) {
            const d = new Date(weekStart);
            d.setUTCDate(weekStart.getUTCDate() + i);
            unifiedDates.push(d.toISOString().split('T')[0]);
          }
        }
      }
    } else {
      // Daily: unified = days where ALL participants submitted OR used a freeze
      const allDates = new Set<string>();
      for (const dates of perUserEffective.values()) {
        for (const d of dates) allDates.add(d);
      }
      for (const date of allDates) {
        let allCovered = true;
        for (const dates of perUserEffective.values()) {
          if (!dates.has(date)) { allCovered = false; break; }
        }
        if (allCovered) unifiedDates.push(date);
      }
    }

    const { currentStreak, longestStreak } = computeStreak(unifiedDates, pact.frequency, today, pact.times_per_week, pact.created_at, weeklyFreezeMap);

    // Today's status: how many participants submitted today (actual submissions, not freezes)
    let completedToday = 0;
    for (const dates of perUserDates.values()) {
      if (dates.has(today)) completedToday++;
    }

    // Current user's own completed dates (for personal calendar view) — includes freeze days
    const myDates = perUserEffective.get(req.userId!) || new Set();

    // Current user's freeze info
    const mySubmissionDates = perUserDates.get(req.userId!) || new Set();
    let freezeInfo: any = null;
    if (pact.frequency === 'daily') {
      freezeInfo = { ...computeFreezeInfo(row.pact_id, req.userId!, mySubmissionDates, today), maxFreezes: MAX_FREEZES };
    } else if (pact.frequency === 'weekly') {
      freezeInfo = computeWeeklyFreezeInfo(row.pact_id, req.userId!, mySubmissionDates, today, pact.times_per_week || 3, pact.created_at);
    }

    // Weekly progress for weekly pacts
    let weeklyProgress = null;
    if (pact.frequency === 'weekly') {
      // Compute the Sunday that starts the current week in pact timezone
      const todayDate = new Date(today + 'T00:00:00Z');
      const dayOfWeek = todayDate.getUTCDay(); // 0=Sunday
      const weekStartDate = new Date(todayDate);
      weekStartDate.setUTCDate(todayDate.getUTCDate() - dayOfWeek);
      const weekStart = weekStartDate.toISOString().split('T')[0];

      // Saturday end of week
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);
      const weekEnd = weekEndDate.toISOString().split('T')[0];

      // Count current user's submissions this week (unique dates)
      let completed = 0;
      for (const dateStr of mySubmissionDates) {
        if (dateStr >= weekStart && dateStr <= weekEnd) {
          completed++;
        }
      }

      const target = pact.times_per_week || 3;

      // Check if this is the pact's first week
      // pact.created_at is stored as a date string like "2026-01-15"
      const pactCreatedDate = pact.created_at.split('T')[0]; // handle both "2026-01-15" and ISO timestamp
      const isFirstWeek = pactCreatedDate >= weekStart && pactCreatedDate <= weekEnd;

      // Days left in the week (including today): Saturday - today + 1
      const daysLeft = 7 - dayOfWeek; // Sunday=7, Monday=6, ..., Saturday=1

      // Adjusted target for first week
      let adjustedTarget = target;
      if (isFirstWeek) {
        const createdD = new Date(pactCreatedDate + 'T00:00:00Z');
        const createdDayOfWeek = createdD.getUTCDay();
        const daysLeftInWeekFromCreation = 7 - createdDayOfWeek; // days from creation day to Saturday inclusive
        adjustedTarget = Math.max(1, Math.ceil(target * daysLeftInWeekFromCreation / 7));
      }

      weeklyProgress = {
        completed,
        target,
        adjustedTarget,
        isFirstWeek,
        daysLeft,
      };
    }

    streaks.push({
      pactId: row.pact_id,
      currentStreak,
      longestStreak,
      completedDates: unifiedDates.sort(),
      myCompletedDates: [...myDates].sort(),
      streakType: pact.frequency,
      todayStatus: {
        completed: completedToday,
        total: participantCount,
      },
      freezeInfo,
      ...(weeklyProgress ? { weeklyProgress } : {}),
    });
  }

  res.json(streaks);
});

// Get aggregate activity map for contribution graph
router.get('/activity', authMiddleware, (req: AuthRequest, res: Response) => {
  // Fetch raw timestamps and convert to dates using each pact's timezone
  const subs = db.prepare(`
    SELECT s.timestamp, p.timezone
    FROM submissions s
    JOIN pact_participants pp ON pp.pact_id = s.pact_id AND pp.user_id = ? AND pp.status = 'accepted'
    JOIN pacts p ON p.id = s.pact_id
    WHERE s.user_id = ? AND s.verified = 1
  `).all(req.userId!, req.userId!) as any[];

  const activity: Record<string, number> = {};
  for (const s of subs) {
    const date = utcTimestampToDateInTimezone(s.timestamp, s.timezone || 'UTC');
    activity[date] = (activity[date] || 0) + 1;
  }

  res.json(activity);
});

export default router;
export { computeStreak, computePersonalSubmissionStreak, computeFreezeInfo, computeWeeklyFreezeInfo, getWeekKey, MAX_FREEZES, DAYS_PER_FREEZE, FREEZE_COOLDOWN_DAYS, WEEKS_PER_FREEZE, MIN_WEEKS_FOR_FREEZE, WEEKLY_FREEZE_COOLDOWN_WEEKS };
