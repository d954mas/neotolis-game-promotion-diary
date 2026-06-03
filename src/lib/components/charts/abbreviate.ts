/**
 * D-11 axis/label number abbreviation: 1234 → "1.2k", 47000 → "47k",
 * 1_200_000 → "1.2M". One decimal place max, trailing ".0" stripped, values
 * below 1000 unchanged. Callers pair this with `font-variant-numeric:
 * tabular-nums` so the abbreviated forms align; full values live in the
 * tooltip/panel.
 */
export function abbreviate(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);

  const sign = n < 0 ? "-" : "";
  const units: { value: number; suffix: string }[] = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "k" },
  ];

  for (const { value, suffix } of units) {
    if (abs < value) continue;
    const scaled = abs / value;
    // One decimal place; strip a trailing ".0" (47000 → "47k", not "47.0k").
    const rounded = Math.round(scaled * 10) / 10;
    const text = rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
    return `${sign}${text}${suffix}`;
  }

  return String(n);
}
