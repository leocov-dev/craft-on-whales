import { PathGuardService } from '../storage/path-guard.service';

/** hs_err files live in the server root; crash reports in crash-reports/. */
export function crashAbsPathFor(
  pathGuard: PathGuardService,
  serverId: string,
  filename: string,
): string {
  return filename.startsWith('hs_err')
    ? pathGuard.dataPath('servers', serverId, filename)
    : pathGuard.dataPath('servers', serverId, 'crash-reports', filename);
}
