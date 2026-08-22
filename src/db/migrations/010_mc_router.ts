'use strict';

// mc-router routing: per-server hostname + optional per-server auto-scale
// override. NULL router_hostname = server not routed. router_auto_scale is
// NULL (inherit global mc_router settings), 'on', or 'off'.

import type { Db } from '../types';

function up(db: Db): void {
  db.exec(`
    ALTER TABLE servers ADD COLUMN router_hostname TEXT;
    ALTER TABLE servers ADD COLUMN router_auto_scale TEXT;
  `);
}

export { up };
