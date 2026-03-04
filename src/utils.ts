import { Request } from 'express';

/** Prefix a relative avatar path with the full base URL */
export function fullAvatarUrl(avatar: string | null | undefined, req: Request): string {
  if (!avatar) return '';
  if (avatar.startsWith('/')) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return `${baseUrl}${avatar}`;
  }
  return avatar;
}
