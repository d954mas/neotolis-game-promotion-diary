---
created: 2026-05-05T10:32:00.000Z
area: security
status: pending
---

# Client-side encryption for R2 backups (probably won't ship)

## Idea

Add client-side encryption to the backup pipeline so the `.sql.gz` file
in R2 is unreadable without a key the attacker doesn't have. Two
plausible approaches:

- **rclone crypt remote** — overlay encryption configured in rclone.conf,
  password sits in operator's `.env` or external file. Simplest pipeline
  change (just swap RCLONE_REMOTE).
- **GPG --encrypt before rclone** — `pg_dump | gzip | gpg --encrypt
  --recipient <fingerprint>` in backup.sh. Operator's GPG private key
  lives off-VPS (laptop / hardware key). VPS compromise still yields
  unreadable backups.

## Why we probably won't do this

Captured during Phase 02.2 backup verification 2026-05-05:

- R2 buckets are **private** (no public access, requires API token)
- The most sensitive at-rest data is **already envelope-encrypted**
  inside the dump:
  - `api_keys_steam.secret_ct` (Steam Web API keys)
  - Better Auth `account.access_token` / `refresh_token` / `id_token`
    (encrypted via encryptedDrizzleAdapter)
- TLS in transit + Cloudflare server-side encryption at rest is the
  same posture most SaaS products give you out of the box
- Object Lock 30-day retention prevents deletion even if R2 token is
  compromised

What's still plaintext in the dump: PII (`users.email`, `users.name`,
`users.googleSub`), event content (titles, URLs, notes), audit log.
That's a real attack surface if R2 token leaks AND attacker chooses
to download the whole archive instead of just listing.

## When to revisit

- If user count grows past ~100 (broader blast radius if data leaks)
- If we add genuinely sensitive fields beyond what's already
  envelope-encrypted (e.g. private keys, financial data)
- If a security incident or compliance requirement forces it (GDPR
  Article 32 already kind of suggests it but isn't strictly required
  given the existing controls)

## Estimated work if we do it

- ~1 hour for GPG pipeline (preferred — standard tooling, key off-VPS)
- + key management documentation in `docs/deploy/install.md` (operator
  needs to create GPG key, save private key off-VPS, paste public key
  fingerprint in `.env`)
- + restore runbook update (decrypt step before pg_restore)
- + test that recovery actually works end-to-end (D-22a failure mode
  matrix needs new row)

## Captured

2026-05-05 during morning backup verification (Phase 02.2 close-out).
Operator's stance: probably won't ship, threats already mitigated by
private buckets + envelope encryption on the secret-shaped fields +
Object Lock.
