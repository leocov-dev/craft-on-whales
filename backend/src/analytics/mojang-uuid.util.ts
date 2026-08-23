// Scoped port of src/services/mojangProfiles.ts's uuidToDashed only —
// stats.ts is the sole caller in this module's scope, and it only needs
// this pure string-formatting helper, not the network-calling
// resolveProfile() (which belongs to the full PlayersModule port later).

/** Convert Mojang's undashed UUID form to the dashed form the server files use. */
export function uuidToDashed(uuid: unknown): string | null {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
