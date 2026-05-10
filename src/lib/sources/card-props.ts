// Universal card props — Phase 03.0.1 D-03. Each per-source adapter's
// ui/card-props.ts exports `toCardProps(event) → CardProps`; the
// universal <EventCard> shell consumes this shape.
export interface CardProps {
  thumbnail: string | null;
  title: string;
  subtitle: string | null;
  badge: string | null;
  metrics: Array<{ label: string; value: string }>;
  href: string;
}
