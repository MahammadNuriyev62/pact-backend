import bcrypt from 'bcryptjs';
import db, { initDb } from './db';

const PASSWORD = 'password123';
const hash = bcrypt.hashSync(PASSWORD, 10);

function generateDates(daysBack: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = daysBack; i >= 0; i--) {
    if (Math.random() < 0.1) continue; // skip ~10% randomly
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

export function seed() {
  // Check if already seeded
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as any;
  if (existingUsers.count > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding database...');

  const users = [
    { id: 'u1', name: 'Nazrin Nasirova', username: 'nazrin', email: 'nazrin@pact.app', avatar: 'https://i.pravatar.cc/150?img=1' },
    { id: 'u2', name: 'Sarah Chen', username: 'sarah', email: 'sarah@pact.app', avatar: 'https://i.pravatar.cc/150?img=5' },
    { id: 'u3', name: 'Jake Miller', username: 'jake', email: 'jake@pact.app', avatar: 'https://i.pravatar.cc/150?img=8' },
    { id: 'u4', name: 'Emma Wilson', username: 'emma', email: 'emma@pact.app', avatar: 'https://i.pravatar.cc/150?img=9' },
    { id: 'u5', name: 'Alex Park', username: 'alex', email: 'alex@pact.app', avatar: 'https://i.pravatar.cc/150?img=12' },
    { id: 'u6', name: 'Mia Johnson', username: 'mia', email: 'mia@pact.app', avatar: 'https://i.pravatar.cc/150?img=16' },
  ];

  const insertUser = db.prepare('INSERT INTO users (id, name, username, email, password_hash, avatar) VALUES (?, ?, ?, ?, ?, ?)');
  for (const u of users) {
    insertUser.run(u.id, u.name, u.username, u.email, hash, u.avatar);
  }

  const pacts = [
    { id: 'p1', title: 'Morning Run', icon: 'fitness', icon_family: 'Ionicons', color: '#FF6B6B', frequency: 'daily', times_per_week: null, deadline: '23:59', created_by: 'u1', created_at: '2026-01-15', participants: ['u1', 'u2', 'u3'] },
    { id: 'p2', title: 'Read 30 Min', icon: 'book', icon_family: 'Ionicons', color: '#FFE66D', frequency: 'daily', times_per_week: null, deadline: '23:59', created_by: 'u1', created_at: '2026-01-20', participants: ['u1', 'u4', 'u5'] },
    { id: 'p3', title: 'Healthy Meals', icon: 'restaurant', icon_family: 'Ionicons', color: '#95E1D3', frequency: 'weekly', times_per_week: 5, deadline: '23:59', created_by: 'u1', created_at: '2026-01-10', participants: ['u1', 'u2', 'u6'] },
    { id: 'p4', title: 'Meditate', icon: 'leaf', icon_family: 'Ionicons', color: '#4ECDC4', frequency: 'daily', times_per_week: null, deadline: '22:00', created_by: 'u1', created_at: '2026-02-01', participants: ['u1', 'u3', 'u4', 'u6'] },
    { id: 'p5', title: 'No Phone Before 9am', icon: 'phone-portrait-outline', icon_family: 'Ionicons', color: '#F38181', frequency: 'daily', times_per_week: null, deadline: '09:00', created_by: 'u1', created_at: '2026-02-05', participants: ['u1', 'u5'] },
  ];

  const insertPact = db.prepare('INSERT INTO pacts (id, title, icon, icon_family, color, frequency, times_per_week, deadline, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertParticipant = db.prepare('INSERT INTO pact_participants (pact_id, user_id) VALUES (?, ?)');

  for (const p of pacts) {
    insertPact.run(p.id, p.title, p.icon, p.icon_family, p.color, p.frequency, p.times_per_week, p.deadline, p.created_by, p.created_at);
    for (const userId of p.participants) {
      insertParticipant.run(p.id, userId);
    }
  }

  // Generate submissions for each pact based on completed dates
  const insertSubmission = db.prepare('INSERT INTO submissions (id, pact_id, user_id, photo_uri, timestamp, verified) VALUES (?, ?, ?, ?, ?, 1)');

  let subId = 1;
  const pactSubmissionData: Record<string, { participants: string[]; daysBack: number; seed: string }> = {
    p1: { participants: ['u1', 'u2', 'u3'], daysBack: 30, seed: 'run' },
    p2: { participants: ['u1', 'u4', 'u5'], daysBack: 30, seed: 'book' },
    p3: { participants: ['u1', 'u2', 'u6'], daysBack: 30, seed: 'meal' },
    p4: { participants: ['u1', 'u3', 'u4', 'u6'], daysBack: 17, seed: 'med' },
    p5: { participants: ['u1', 'u5'], daysBack: 13, seed: 'phone' },
  };

  for (const [pactId, data] of Object.entries(pactSubmissionData)) {
    for (const userId of data.participants) {
      const dates = generateDates(data.daysBack);
      for (const date of dates) {
        const hours = String(6 + Math.floor(Math.random() * 4)).padStart(2, '0');
        const mins = String(Math.floor(Math.random() * 60)).padStart(2, '0');
        insertSubmission.run(
          `s${subId++}`,
          pactId,
          userId,
          `https://picsum.photos/seed/${data.seed}${subId}/400/400`,
          `${date}T${hours}:${mins}:00Z`,
        );
      }
    }
  }

  // Friendships — all demo users are friends with each other
  const insertFriendship = db.prepare('INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?, ?)');
  let fId = 1;
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      insertFriendship.run(`f${fId++}`, users[i].id, users[j].id, 'accepted', '2026-01-01T00:00:00Z');
    }
  }

  // Notifications
  const today = new Date().toISOString().split('T')[0];
  const insertNotif = db.prepare('INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  insertNotif.run('n1', 'nudge', 'u2', 'p1', 'u1', "Sarah nudged you: Don't break the streak! Go for your run!", `${today}T10:00:00Z`, 0);
  insertNotif.run('n2', 'deadline_warning', null, 'p4', 'u1', 'Meditation deadline is in 2 hours! Your pact friends are waiting.', `${today}T20:00:00Z`, 0);
  insertNotif.run('n3', 'new_submission', 'u3', 'p1', 'u1', 'Jake just submitted his morning run!', `${today}T06:45:00Z`, 1);
  insertNotif.run('n4', 'streak_milestone', null, 'p2', 'u1', 'Amazing! 22-day reading streak!', `${today}T22:00:00Z`, 1);
  insertNotif.run('n5', 'streak_milestone', null, 'p3', 'u1', '4-week Healthy Meals streak! Keep it going!', `${today}T18:00:00Z`, 1);
  insertNotif.run('n6', 'deadline_warning', null, 'p3', 'u1', 'Healthy Meals: 3 of 5 done this week. 2 days left to hit your target!', `${today}T09:00:00Z`, 0);

  console.log(`Seeded: ${users.length} users, ${pacts.length} pacts, ${subId - 1} submissions, 6 notifications`);
}

// Run directly
if (require.main === module) {
  initDb();
  seed();
  console.log('Done!');
}
