# Phase 03.0.2 — Deferred Items

Items discovered during execution that are out of scope for this phase and
deliberately deferred. Tracked here per SCOPE BOUNDARY rule (`.claude/get-shit-done`
deviation rules) so they are not lost but also not silently rolled in.

## Discovered during 03.0.2-01 (`@types/supertest` bump, 2026-05-11)

### `pnpm lint` fails locally on Windows with `core.autocrlf=true`

**Symptom.** On Windows with Git's `core.autocrlf=true` (Git for Windows default),
`pnpm lint` reports `Code style issues found in N files. Run Prettier with --write
to fix.` against ~128 files in the checked-out tree. Prettier reads the working
copy (CRLF) but the stored blob in Git's index is LF; Prettier's `endOfLine`
default of `lf` rejects CRLF in working-copy files.

**Pre-existing.** Confirmed by checking master HEAD: master CI is green
(run 25637209245, commit a870ddb), so the lint failure does NOT reflect a real
formatting drift — Linux CI runners check out LF files and Prettier passes there.
This is a local-Windows-only environmental issue, not a code defect.

**Out of scope for 03.0.2.** Phase 03.0.2 is dependency refresh; line-ending
hygiene across the working tree is a separate concern. No commit in this phase
touches the affected files.

**Local workaround.** When a phase commit modifies a Prettier-formatted file
(e.g., `package.json` after `pnpm add`), run `pnpm exec prettier --write
<file>` on just that file before commit so the working-copy line endings match
the stored blob. The 03.0.2-01 commit applied this workaround to `package.json`
and `pnpm-lock.yaml`.

**Permanent fix candidate (separate PR, NOT in 03.0.2).** Add
`* text=auto eol=lf` to `.gitattributes`. This would force LF checkout on
Windows too, eliminating the Prettier mismatch. Requires a one-off
re-normalization commit (`git add --renormalize .`). Open as a follow-up
`chore: normalize line endings to LF on checkout` PR after Phase 03.0.2 ships.
