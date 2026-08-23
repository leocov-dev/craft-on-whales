"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const drizzle_kit_1 = require("drizzle-kit");
exports.default = (0, drizzle_kit_1.defineConfig)({
    dialect: 'sqlite',
    schema: './src/db/schema/index.ts',
    out: './drizzle',
    dbCredentials: {
        url: process.env.DB_FILE ?? './data/panel.db',
    },
});
//# sourceMappingURL=drizzle.config.js.map