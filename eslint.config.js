'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

// typescript-eslint doesn't support TypeScript 7.x yet (it hard-throws on
// require('typescript') if the resolved version is >=7 — see
// https://github.com/typescript-eslint/typescript-eslint/issues/10940). The
// project's real `typescript` devDependency is TS 7.0.2, needed for `tsc`
// itself (see package.json's `typecheck` script, which invokes the real TS7
// binary directly to sidestep this same aliasing). For eslint's sake only,
// the root `typescript` devDependency is aliased to `@typescript/typescript6`
// (a TS6-compatible shim) so typescript-eslint's peer check is satisfied;
// `typescript7` is the untouched real compiler used everywhere else. This is
// the dual-alias workaround documented at
// https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0.
// Remove this split (and the `typescript7` alias) once typescript-eslint
// supports TS 7.x directly — `npm run typecheck` already exercises the real
// TS7 checker, so this is purely a lint-time accommodation.
//
// Non-type-checked rules only (`recommended`, not `recommendedTypeChecked`):
// type-aware linting would build a full TS program through the aliased TS6
// shim rather than the project's real TS7 compiler, which is an unnecessary
// second source of truth for something `tsc -p tsconfig.json` already covers
// authoritatively.

module.exports = [
  { ignores: ['node_modules/', 'data/', 'data-*/', 'public/css/', 'docker-minecraft-server/', 'discovery/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    rules: {
      // Matches the CommonJS `require`/`export =` convention kept throughout
      // src/ (see AGENTS.md-equivalent history in the TypeScript migration
      // commits) — flagging it would fight the codebase's own style choice.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      // Same intentional-unused convention as the plain-JS rule below.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Off (not lazily): several input-sanitization/log-parsing regexes match
      // control chars on purpose (ANSI stripping, NUL/unit-separator guards) —
      // same rationale as the plain-JS block below.
      'no-control-regex': 'off',
      // The migration's own convention (see the TypeScript rewrite commits) is
      // `any` only for genuinely dynamic data — NBT tag parsing, blueprint
      // manifests, third-party JSON shapes — with `unknown` preferred elsewhere.
      // Warn rather than error: surfaces remaining spots to reconsider without
      // forcing a mechanical `unknown`-everywhere pass that would just relocate
      // the imprecision into more `as` casts at each dynamic-data boundary.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Build/QA scripts + tests (CommonJS). src/ is now all TypeScript.
    files: ['scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Errors, not warnings — problems fail the build honestly instead of being
      // promoted by a --max-warnings flag. `_`-prefixed and rest-sibling
      // (destructure-to-omit) vars are the standard "intentionally unused" opt-out;
      // `next` is Express's error-forwarding param that asyncHandler drives.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Off (not lazily): several input-sanitization regexes match control chars
      // on purpose; enabling this would force noise-only disable comments on each.
      'no-control-regex': 'off',
      'no-useless-escape': 'error',
    },
  },
  {
    // Browser client code (ES modules).
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Intentional: ANSI/control-char handling in console + MOTD rendering.
      'no-control-regex': 'off',
    },
  },
];
