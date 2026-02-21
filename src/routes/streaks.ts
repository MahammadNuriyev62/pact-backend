import { Router, Response } from 'express';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();

function computeStreak(completedDates: string[], frequency: string, timesPerWeek?: number): { currentStreak: number; longestStreak: number } {
  if (completedDates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const sorted = [...completedDates].sort();

  if (frequency === 'weekly') {
    // Group dates by ISO week
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

    for (let i = 0; i < weekKeys.length; i++) {
      if ((weeks.get(weekKeys[i]) || 0) >= target) {
        streak++;
        longestStreak = Math.max(longestStreak, streak);
      } else {
        streak = 0;
      }

      // Check if this is the current or previous week
      const now = new Date();
      const weekDate = new Date(weekKeys[i] + 'T00:00:00Z');
      const diffDays = Math.floor((now.getTime() - weekDate.getTime()) / (1000 * 60 * 60 * 24));
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

  const today = new Date().toISOString().split('T')[0];
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

  // Check if streak is current (last date is today or yesterday)
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

// Get streaks for current user across all pacts
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactIds = db.prepare(
    'SELECT pact_id FROM pact_participants WHERE user_id = ?'
  ).all(req.userId!) as any[];

  const streaks = pactIds.map(row => {
    const pact = db.prepare('SELECT * FROM pacts WHERE id = ?').get(row.pact_id) as any;
    if (!pact) return null;

    // Get all completed dates for this user+pact
    const subs = db.prepare(
      'SELECT DISTINCT substr(timestamp, 1, 10) as date FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1'
    ).all(row.pact_id, req.userId!) as any[];

    const completedDates = subs.map((s: any) => s.date);
    const { currentStreak, longestStreak } = computeStreak(completedDates, pact.frequency, pact.times_per_week);

    return {
      pactId: row.pact_id,
      userId: req.userId!,
      currentStreak,
      longestStreak,
      completedDates,
      streakType: pact.frequency,
    };
  }).filter(Boolean);

  res.json(streaks);
});

// Get aggregate activity map for contribution graph
router.get('/activity', authMiddleware, (req: AuthRequest, res: Response) => {
  const subs = db.prepare(`
    SELECT substr(timestamp, 1, 10) as date, COUNT(*) as count
    FROM submissions s
    JOIN pact_participants pp ON pp.pact_id = s.pact_id AND pp.user_id = ?
    WHERE s.user_id = ? AND s.verified = 1
    GROUP BY date
  `).all(req.userId!, req.userId!) as any[];

  const activity: Record<string, number> = {};
  for (const s of subs) {
    activity[s.date] = s.count;
  }

  res.json(activity);
});

export default router;
