import type { Request } from 'express';

/** The acting username for an event/audit log entry, falling back to 'admin' for unauthenticated/system-triggered requests. */
export function actorOf(req: Request): string {
  return req.user ? req.user.username : 'admin';
}
