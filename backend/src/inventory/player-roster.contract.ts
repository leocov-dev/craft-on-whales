/**
 * The one method InventoryEditService actually needs from PlayerRosterService
 * (to pick the RCON-vs-file edit mechanism) — injected via this token instead
 * of `import type` + `@Inject(forwardRef(() => require(...)))`, so the
 * consumer class itself no longer needs the require()/eslint-disable
 * workaround. InventoryModule still imports PlayersModule via forwardRef()
 * (the module-level cycle is genuine), but binds this token to the real
 * PlayerRosterService with `useExisting`.
 */
export interface PlayerRosterContract {
  listOnlineNames(
    serverId: string,
    opts?: { throwOnError?: boolean },
  ): Promise<string[]>;
}

export const PLAYER_ROSTER_CONTRACT = Symbol('PLAYER_ROSTER_CONTRACT');
