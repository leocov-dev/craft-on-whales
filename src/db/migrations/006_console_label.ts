'use strict';

// Per-server label for panel-run console actions. When set, the panel announces
// "[label] <command>" in game chat (the vanilla "Rcon" sender can't be renamed).
// NULL = no announcement.

import type { Db } from '../types';

function up(db: Db): void {
  db.exec('ALTER TABLE servers ADD COLUMN console_label TEXT');
}

export = { up };
