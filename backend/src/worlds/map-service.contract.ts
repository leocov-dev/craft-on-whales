/**
 * The one method WorldPropsService actually needs from MapService (to
 * refresh BlueMap/map configs after a level-name change) — injected via this
 * token instead of `import type` + `@Inject(forwardRef(() => require(...)))`.
 * WorldsModule still needs `forwardRef(() => MapModule)` since the module
 * cycle itself is genuine (MapService also depends on WorldPropsService),
 * but this class no longer does.
 */
export interface MapServiceContract {
  writeMapConfigs(serverId: string): Promise<void>;
}

export const MAP_SERVICE_CONTRACT = Symbol('MAP_SERVICE_CONTRACT');
