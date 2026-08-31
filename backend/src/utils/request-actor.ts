import type { Request } from 'express';
import { currentUser } from '../auth/current-user';

/** The acting username for an event/audit log entry. Throws if `req.user` is missing rather than silently misattributing to 'admin'. */
export function actorOf(req: Request): string {
  return currentUser(req).username;
}
