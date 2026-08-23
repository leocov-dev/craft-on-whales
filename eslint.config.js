'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Root-level lint scope is now just the repo's small utility scripts/ —
// frontend/ and backend/ each own their own eslint config (Vue+Quasar and
// NestJS+TypeScript respectively; see frontend/eslint.config.js and
// backend/eslint.config.mjs), since they're independent packages with their
// own dependency graphs.
module.exports = [
  { ignores: ['node_modules/', 'data/', 'data-*/', 'frontend/', 'backend/', 'discovery/'] },
  js.configs.recommended,
  {
    files: ['scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'error',
    },
  },
];
