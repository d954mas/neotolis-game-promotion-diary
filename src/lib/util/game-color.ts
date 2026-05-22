// gameColor — deterministic HSL color from a game id hash.
//
// GameDto has no color field today (see src/lib/server/dto.ts) — to give
// every game a stable per-id accent that flows across the app (FeedCard
// footer chips, AxisRow filter chips, ActiveFiltersStrip pills, the
// AddEvent form's game chip picker, and EventDetailContent's game chip
// picker), we derive the hue client-side from a multiply-by-31 hash of
// the id string. Same id → same hue across every surface, light + dark
// themes adapt via fixed saturation + lightness values.
//
// 62% saturation / 52% lightness lands in the "desaturated for dark"
// band so the color reads on the dark background without screaming —
// same band as tokens.css's kind palette (saturation 55-70, lightness
// 60-72).
//
// Extracted from the duplicated inline implementations in FeedCard.svelte
// and /feed/+page.svelte once a third caller (AddEventForm) needed the
// same mapping — KISS rule: three concrete callers earn the abstraction.

export function gameColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 62% 52%)`;
}
