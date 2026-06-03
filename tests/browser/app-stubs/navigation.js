// Inert $app/navigation stub for the vitest browser project.
// Mounted components (e.g. RefreshNowButton) import `invalidateAll`; the
// dual-render / component tests assert DOM structure, not navigation side
// effects, so these resolve to no-ops. See vitest.config.ts $appAlias.

export function goto() {
  return Promise.resolve();
}
export function invalidate() {
  return Promise.resolve();
}
export function invalidateAll() {
  return Promise.resolve();
}
export function preloadData() {
  return Promise.resolve();
}
export function preloadCode() {
  return Promise.resolve();
}
export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() {}
export function pushState() {}
export function replaceState() {}
export function disableScrollHandling() {}
