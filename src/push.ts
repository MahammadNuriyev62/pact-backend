import webpush from 'web-push';
import db from './db';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@pact.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  tag?: string;
}

/**
 * Send a web push notification to all subscriptions for a given user.
 * Auto-deletes expired/invalid subscriptions (HTTP 410/404).
 * Silently no-ops if VAPID keys are not configured.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = db.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
  ).all(userId) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;

  if (subscriptions.length === 0) {
    console.log(`[Push] No subscriptions for user ${userId}, skipping`);
    return;
  }

  console.log(`[Push] Sending "${payload.title}" to ${subscriptions.length} subscription(s) for user ${userId}`);
  const jsonPayload = JSON.stringify(payload);

  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush
        .sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          jsonPayload
        )
        .then(() => {
          console.log(`[Push] Delivered to ${sub.endpoint.slice(0, 60)}...`);
        })
        .catch((err) => {
          console.error(`[Push] Failed for ${sub.endpoint.slice(0, 60)}...: ${err.statusCode || err.message}`);
          if (err.statusCode === 410 || err.statusCode === 404) {
            db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            console.log(`[Push] Removed expired subscription ${sub.id}`);
          }
        })
    )
  );

  // TODO: When adding iOS/Android native push, dispatch via Expo Push API here
}

export { VAPID_PUBLIC_KEY };
