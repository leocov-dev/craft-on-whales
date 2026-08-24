import type { MojangService } from '../players/mojang.service';

/** Concrete MC version label ("LATEST (1.21.4)"), resolved via Mojang's manifest. */
export async function displayVersion(
  mojang: MojangService,
  mcVersion: string,
): Promise<string> {
  if (mcVersion !== 'LATEST' && mcVersion !== 'SNAPSHOT') return mcVersion;
  try {
    const manifest = await mojang.getVersionManifest();
    const resolved =
      mcVersion === 'LATEST'
        ? manifest.latest.release
        : manifest.latest.snapshot;
    return `${mcVersion} (${resolved})`;
  } catch {
    return mcVersion;
  }
}

const FLAVOR_LABELS: Record<string, string> = {
  VANILLA: 'Vanilla',
  PAPER: 'Paper',
  PURPUR: 'Purpur',
  PUFFERFISH: 'Pufferfish',
  FOLIA: 'Folia',
  LEAF: 'Leaf',
  SPIGOT: 'Spigot',
  BUKKIT: 'Bukkit',
  FABRIC: 'Fabric',
  FORGE: 'Forge',
  NEOFORGE: 'NeoForge',
  QUILT: 'Quilt',
  AUTO_CURSEFORGE: 'CurseForge pack',
  MODRINTH: 'Modrinth pack',
  FTBA: 'FTB pack',
  PACKWIZ: 'packwiz pack',
  CUSTOM: 'Custom jar',
};

export function flavorLabel(type: string): string {
  return FLAVOR_LABELS[type] || type;
}
