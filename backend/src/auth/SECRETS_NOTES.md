# Secrets at rest — key precedence

`SecretsService` (this dir) encrypts everything stored at rest: the CurseForge
API key (`api_keys.key_cipher`), RCON passwords (`servers.rcon_password_cipher`),
TOTP secrets (`users.totp_secret`), and Discord webhook URLs
(`integrations.config_cipher`). All AES-256-GCM, all via this one service —
grep `SecretsService` for the exact call sites before adding a new encrypted
column.

## SECRET_KEY vs SESSION_SECRET

Tier 2 upstream-parity item 2.10 (see `UPSTREAM_PARITY.md`) asked for a
dedicated at-rest encryption key, independent of `SESSION_SECRET` (which also
signs session cookies — reusing it for encryption conflates two unrelated
secrets with different rotation needs). Our design deliberately diverges from
upstream's `secretsMigration.js` (which minted and wrote a key file under
`data/`): **the panel never generates `SECRET_KEY` and never writes it to
disk.** It's operator-supplied only, exactly like `SESSION_SECRET` used to be
before auto-generation was added — except here there's no auto-generation
fallback file, ever. Writing an encryption key to the same bind-mounted
`data/` directory it protects would undermine the point of separating it from
`SESSION_SECRET` in the first place.

Resolution (`SecretKeyProvider.resolve()`, called from `ConfigService`'s
constructor, i.e. hard-fails at Nest bootstrap, not lazily):

- **Set, well-formed** (32 bytes decoded, hex or base64/base64url): used
  as-is.
- **Set, malformed or wrong length**: throws during boot with a message
  naming the expected format. Never truncated, padded, or silently ignored —
  a key of the wrong length is worse than no key at all.
- **Unset**: `ConfigService.secretKey` is `null`. `SecretsService` falls back
  to the pre-2.10 behavior — `scryptSync(SESSION_SECRET, 'msm.secrets.v1', 32)`
  — and a loud (multi-line, `Logger.warn`) boot message tells the operator
  this is deprecated. Not fatal: existing installs keep booting unchanged.

## Decrypt-fallback / re-encrypt mechanism

Once `SECRET_KEY` is set, values encrypted under the old
`SESSION_SECRET`-derived key must keep decrypting, and should move to the new
key over time. We chose the **try-both-keys-in-`decrypt()`, re-encrypt-on-
next-write** approach, not a boot-time migration pass or a per-row key
version column:

- `SecretsService` always computes the `SESSION_SECRET`-derived key
  (`legacyKey`) in addition to the primary key (`SECRET_KEY` if set, else
  `legacyKey` itself). `decrypt()` tries the primary key first; on failure
  (and only if the two keys actually differ) it retries with `legacyKey`
  before giving up with `SecretKeyMismatchError`. This is entirely internal
  to `SecretsService` — no caller (auth, api-keys, integrations/discord,
  servers) had to change.
- `encrypt()` always uses the primary key. So the moment any existing value
  is legitimately rewritten through its normal application flow — rotating
  the CurseForge key (`ApiKeysService.setKey`), re-enrolling 2FA
  (`AuthService`), saving a new webhook URL (`DiscordService.setConfig`), or
  an RCON password self-heal (`ServerEnvironmentService.assembleEnv`) — it's
  re-encrypted under `SECRET_KEY` automatically, with zero extra code.

We considered a boot-time migration pass that re-reads and rewrites every
encrypted column once. Rejected: it would need direct DB access to four
unrelated tables/services from one new coordinator (or scattered per-service
migration methods), for a marginal gain over "the value quietly moves to the
new key next time it's touched, and until then still decrypts fine." A
per-row key-version column was also considered and rejected for the same
reason the task called out up front — new persistent state to keep in sync
for something the try-both-keys approach already handles.

**Caveat / known limitation**: a value that's _read_ constantly but never
_rewritten_ (e.g. a webhook URL nobody re-saves) stays encrypted under the
legacy key indefinitely after adopting `SECRET_KEY`, as long as
`SESSION_SECRET` doesn't change too. That's an accepted trade-off of the
lazy-on-write choice — it still decrypts correctly (no functional
regression), it just doesn't proactively migrate. If an operator wants full
migration immediately, re-saving each secret through its normal UI flow
forces re-encryption today; a "rotate all secrets" admin action would be the
natural follow-up if this ever needs to be immediate/complete, but that's new
surface area not required by 2.10 as specified.
