// Runtime dispatcher, not a plain barrel — see ./DUAL_DIALECT_NOTES.md for
// why. Re-exports each table from whichever dialect's real module matches
// DB_DRIVER, cast to the SQLite module's type so every consumer keeps a
// single, concrete set of TypeScript types regardless of the active driver.
import * as sqliteSchema from './sqlite';
import * as pgSchema from '../schema-pg';

const active: typeof sqliteSchema = process.env.DB_DRIVER === 'postgres' ? (pgSchema as unknown as typeof sqliteSchema) : sqliteSchema;

export const servers = active.servers;
export const serverPacks = active.serverPacks;
export const serverContent = active.serverContent;

export const users = active.users;
export const sessions = active.sessions;
export const userServerPermissions = active.userServerPermissions;

export const events = active.events;
export const crashReports = active.crashReports;
export const playerEvents = active.playerEvents;
export const playerSessions = active.playerSessions;
export const playerStatSnapshots = active.playerStatSnapshots;

export const libraryFiles = active.libraryFiles;

export const chatCommandSettings = active.chatCommandSettings;
export const chatCommands = active.chatCommands;

export const schedules = active.schedules;

export const blueprints = active.blueprints;
export const backups = active.backups;

export const integrations = active.integrations;

export const settings = active.settings;
export const apiKeys = active.apiKeys;
export const apiCache = active.apiCache;
export const storageIndex = active.storageIndex;
export const storageSnapshots = active.storageSnapshots;
export const updateChecks = active.updateChecks;
