// Inert $app/forms stub for the vitest browser project. See
// vitest.config.ts $appAlias.

export function enhance() {
  return { destroy() {} };
}
export function applyAction() {
  return Promise.resolve();
}
export function deserialize(result) {
  return JSON.parse(result);
}
