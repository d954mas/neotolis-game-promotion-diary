// metricColor — ONE semantic source of truth for per-metric chart/icon colors.
//
// Keyed by the METRIC (not by series index), so a metric reads the same color
// everywhere it surfaces: the per-event history chart's line + legend chip, the
// event-detail stats row, and the feed-card stat icons. Toggling or reordering
// the chart's series never reshuffles a metric's color, and "views" is the same
// blue on a card as it is on the chart.
//
// Concrete hex (not a CSS var) on purpose: the same value feeds both an ECharts
// canvas line color (no var()/color-mix on a <canvas>) and a CSS icon color.
//
// Colors are dark-theme-legible and convention-aligned: likes is the universal
// RED heart, Reddit score/upvotes is orange, comments is green.
const METRIC_HEX: Record<string, string> = {
  views: "#5b8def", // blue
  likes: "#e5575c", // red heart (the universal "like" convention)
  comments: "#5fb98e", // green
  score: "#e8932f", // orange (Reddit)
  upvotes: "#e8932f", // orange (Reddit)
  num_comments: "#5fb98e", // green
  reactions: "#c77dff", // purple (Telegram reactions — distinct from views blue)
  shares: "#2cc2c2", // teal (TikTok shares — distinct from views blue / comments green)
};

export function metricColor(metric: string): string {
  return METRIC_HEX[metric] ?? "#8a8f98";
}

// The history chart's adapter labels series as `chart_metric_<metric>` — strip
// the prefix so the same semantic map drives the chart line + legend chip.
export function metricColorForLabelKey(labelKey: string): string {
  return metricColor(labelKey.replace(/^chart_metric_/, ""));
}
