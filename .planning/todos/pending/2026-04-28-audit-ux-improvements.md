---
created: 2026-04-28T05:58:00.000Z
title: /audit UX — group checkbox filters + table headers
area: ui
files:
  - src/lib/components/ActionFilter.svelte (currently <select> — should be checkbox groups)
  - src/lib/components/AuditRow.svelte (no column headers)
  - src/routes/audit/+page.svelte (header layout)
  - messages/en.json (group labels + column headers)
---

## Problem

During Phase 2 manual UAT (2026-04-28), four issues on `/audit`:

**1. ActionFilter is a dropdown — user wants checkboxes.**
Current: `<select>` listing all 15 audit_log.action values flat (`session.signin / session.signout / key.add / key.rotate / ...`). User wanted to multi-select within categories. Dropdown also forces single-select, blocking the natural "show me all key.* events plus session.signin" use case.

User feedback (verbatim): "Аудит фильтры. Не нравится дроп меню. Как будто хочется тут галочками"

**2. No category grouping.** All 15 actions render as a flat list. They naturally group by prefix:
- `session.*` (signin, signout, signout_all)
- `key.*` (add, rotate, remove)
- `game.*` (created, deleted, restored)
- `item.*` (created, deleted) — will fold into `event.*` after Phase 2.1 unification (todo `2026-04-28-rethink-items-vs-events-architecture`)
- `event.*` (created, edited, deleted)
- `theme.*` (changed)

User feedback (verbatim): "И разделить на группы"

**3. No table headers — columns unexplained.**
AuditRow renders: time | chip | last4 | ip | userAgent without column labels above. At desktop (768px+) it becomes a 5-column grid but no `<thead>`. User couldn't tell what `::1` was (it's the IP column showing IPv6 loopback in dev).

User feedback (verbatim): "Не понятно что там в таблице. Как будто нужен заголовок? ::1"

**4. ::1 in IP column** — this is correct (IPv6 loopback in dev), just unlabeled and not obvious. Adding a "IP" column header solves the confusion.

## Solution

**Fix 1 + 2 — ActionFilter rewrite:**
- Replace `<select>` with collapsible checkbox groups
- One group per action prefix (Session / Keys / Games / Events / Theme — after Phase 2.1 unification)
- "Select all" checkbox per group
- Multi-select state encodes into URL as `?actions=session.signin,key.add,key.rotate` (CSV) — falls back to current `action=key.add` single-action for backward compat
- Server-side: extend `assertValidActionFilter` to accept CSV; `listAuditPage` uses `IN (...)` instead of `=` when multiple actions

**Fix 3 — Table headers:**
- Add `<header>` row above the rows list with column labels: Time / Action / Detail / IP / User agent
- Mobile (< 768px): keep stacked layout, drop the desktop header (use existing visual cues)
- Desktop (≥ 768px): render headers as a non-data first row of the same grid

**Fix 4 — ::1 disambiguation:**
- Already handled by Fix 3 (IP column gets a label)
- Bonus: in dev mode, render `::1` as `localhost (dev)` for clarity. Or simpler — leave it raw, the column header is enough.

## Tests

- ActionFilter unit test: assert checkbox groups render + multi-select state syncs to URL
- /audit integration test: assert column headers render at desktop breakpoint
- Server-side: `listAuditPage` accepts both single action (string) and CSV multi-action

## Severity

**P1** — table is functional but UX-poor. Bundle into Phase 2.1 gap closure.

Owner: Phase 2.1 gap closure.
