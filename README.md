# Pact Backend

Express + TypeScript API with SQLite for the Pact social habit tracking app.

## Setup

```bash
npm install
```

Create a `.env` file:

```
JWT_SECRET=your_secret_here
```

## Run

```bash
npx tsx src/index.ts
```

Server starts on port 3000. Database auto-seeds with test accounts on first run.

## Test Accounts

All passwords: `password123`

| Email | User |
|---|---|
| nazrin@pact.app | Nazrin Nasirova |
| sarah@pact.app | Sarah Chen |
| jake@pact.app | Jake Miller |
| emma@pact.app | Emma Wilson |
| alex@pact.app | Alex Park |
| mia@pact.app | Mia Johnson |

## API Routes

All routes require `Authorization: Bearer <token>` except login and register.

### Auth

- `POST /auth/register` — Create account
- `POST /auth/login` — Login, returns JWT
- `GET /auth/me` — Current user profile

### Pacts

- `GET /pacts` — List user's pacts
- `POST /pacts` — Create a pact
- `GET /pacts/:id` — Pact details
- `GET /pacts/:id/submissions` — Submissions for a pact

### Submissions

- `POST /submissions` — Submit verification (multipart: photo + pactId)
- `GET /submissions/recent` — 10 most recent across user's pacts

### Streaks

- `GET /streaks` — Streak data for all user pacts
- `GET /streaks/activity` — Activity map by date

### Notifications

- `GET /notifications` — All notifications
- `GET /notifications/unread-count` — Unread count
- `PUT /notifications/read` — Mark all read

### Other

- `POST /nudge/:pactId` — Nudge participants (optional `targetUserId` in body)
- `GET /users` — All users except current
- `GET /health` — Health check

## Stack

- **Express** with TypeScript
- **SQLite** via better-sqlite3
- **JWT** auth (jsonwebtoken + bcryptjs)
- **multer** for file uploads (stored in `uploads/`)
