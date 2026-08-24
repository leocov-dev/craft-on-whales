import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const libraryFiles = sqliteTable(
  'library_files',
  {
    id: text('id').primaryKey(),
    category: text('category').notNull(), // mod|plugin|datapack|resourcepack|modpack|world|icon
    name: text('name').notNull(),
    filename: text('filename').notNull(),
    relPath: text('rel_path').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sourceUrl: text('source_url'),
    platform: text('platform'), // 'modrinth' | 'curseforge' | 'url' | 'upload'
    projectId: text('project_id'),
    fileId: text('file_id'),
    version: text('version'),
    mcVersionsJson: text('mc_versions_json').notNull().default('[]'),
    loadersJson: text('loaders_json').notNull().default('[]'),
    iconUrl: text('icon_url'),
    iconRelPath: text('icon_rel_path'),
    worldSource: text('world_source'), // 'upload' | 'extract:<server_id>' | 'import'
    worldFlavor: text('world_flavor'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_library_cat').on(t.category),
    index('idx_library_sha').on(t.sha256),
    uniqueIndex('uniq_library_sha_cat').on(t.sha256, t.category),
  ],
);
