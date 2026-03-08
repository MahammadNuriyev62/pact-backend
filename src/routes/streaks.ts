import { Router, Response } from 'express';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { getTodayInTimezone, utcTimestampToDateInTimezone } from '../timezone';

const router = Router();

function computeStreak(completedDates: string[], frequency: string, today: string, timesPerWeek?: number): { currentStreak: number; longestStreak: number } {
  if (completedDates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const sorted = [...completedDates].sort();

  if (frequency === 'weekly') {
    const weeks = new Map<string, number>();
    for (const date of sorted) {
      const d = new Date(date + 'T00:00:00Z');
      const weekStart = new Date(d);
      weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      weeks.set(weekKey, (weeks.get(weekKey) || 0) + 1);
    }

    const target = timesPerWeek || 3;
    const weekKeys = [...weeks.keys()].sort();
    let currentStreak = 0;
    let longestStreak = 0;
    let streak = 0;

    const todayD = new Date(today + 'T00:00:00Z');
    for (let i = 0; i < weekKeys.length; i++) {
      if ((weeks.get(weekKeys[i]) || 0) >= target) {
        streak++;
        longestStreak = Math.max(longestStreak, streak);
      } else {
        streak = 0;
      }

      const weekDate = new Date(weekKeys[i] + 'T00:00:00Z');
      const diffDays = Math.floor((todayD.getTime() - weekDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 13) {
        currentStreak = streak;
      }
    }

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

    // Unified completed dates: days where ALL participants submitted
    const allDates = new Set<string>();
    for (const dates of perUserDates.values()) {
      for (const d of dates) allDates.add(d);
    }

    const unifiedDates: string[] = [];
    for (const date of allDates) {
      let allSubmitted = true;
      for (const dates of perUserDates.values()) {
        if (!dates.has(date)) { allSubmitted = false; break; }
      }
      if (allSubmitted) unifiedDates.push(date);
    }

    const { currentStreak, longestStreak } = computeStreak(unifiedDates, pact.frequency, today, pact.times_per_week);

    // Today's status: how many participants submitted today
    let completedToday = 0;
    for (const dates of perUserDates.values()) {
      if (dates.has(today)) completedToday++;
    }

    // Current user's own completed dates (for personal calendar view)
    const myDates = perUserDates.get(req.userId!) || new Set();

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
