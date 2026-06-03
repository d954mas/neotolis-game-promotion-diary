// Inert $app/state stub for the vitest browser project (runes-era API).
// `page` is exposed as a plain object with the fields components read;
// component-mount tests don't drive navigation. See vitest.config.ts.

export const page = {
  url: new URL("http://localhost/"),
  params: {},
  route: { id: null },
  status: 200,
  error: null,
  data: {},
  form: null,
  state: {},
};
export const navigating = { from: null, to: null, type: null, complete: Promise.resolve() };
export const updated = { current: false, check: () => Promise.resolve(false) };
