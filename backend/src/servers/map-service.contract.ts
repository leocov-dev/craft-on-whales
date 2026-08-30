/**
 * The one method ServerEnvironmentService actually needs from MapService (to
 * fold BlueMap's extra port mapping into a container's env/port set) —
 * injected via this token instead of `import type` +
 * `@Inject(forwardRef(() => require(...)))`. ServersModule still needs
 * `forwardRef(() => MapModule)` since the module cycle itself is genuine,
 * but this class no longer does.
 */
export interface MapServiceContract {
  extraPortsFor(
    serverId: string,
  ): Promise<{ container: string; host: number }[]>;
}

export const MAP_SERVICE_CONTRACT = Symbol('MAP_SERVICE_CONTRACT');
