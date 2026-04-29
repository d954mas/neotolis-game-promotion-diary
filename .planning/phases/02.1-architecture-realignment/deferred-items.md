
## Plan 02.1-21 — out-of-scope errors found during typecheck

Pre-existing typecheck errors in tests/integration/game-listings.test.ts and games.test.ts referencing modules removed during Plan 02.1-01 baseline collapse:
- src/lib/server/services/youtube-channels.js
- src/lib/server/db/schema/game-youtube-channels.js
- src/lib/server/db/schema/youtube-channels.js
- src/lib/server/db/schema/tracked-youtube-videos.js

Out of scope for Plan 02.1-21 (it does not touch these files). Pre-Phase-02.1-01 cleanup; either update or delete these test files.
