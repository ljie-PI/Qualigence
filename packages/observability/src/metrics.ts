export type MetricLabels = Record<string, string>;

/**
 * Label names that are forbidden because they would leak high-cardinality or
 * sensitive data into the metrics plane. The design pins this rule: metric
 * labels must never carry prompts, URL queries, user text or per-artifact ids.
 */
const DISALLOWED_LABELS: readonly string[] = [
  "url",
  "uri",
  "query",
  "prompt",
  "usertext",
  "plaintext",
  "artifactid",
  "artifactkey",
  "capsuleid",
  "traceid",
  "eventid",
  "runid",
  "missionid",
  "projectid",
  "userid",
  "subject",
  "email",
  "token",
  "authorization",
  "cookie",
  "secret",
  "password",
  "apikey",
  "path",
];

const SECRET_VALUE = /(?:^|[?&\s])(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)=/i;
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const MAX_LABEL_VALUE_LENGTH = 80;

function assertLabels(labels: MetricLabels): void {
  for (const [name, value] of Object.entries(labels)) {
    if (DISALLOWED_LABELS.includes(normalizeLabelName(name))) {
      throw new Error(`disallowed metric label: ${name}`);
    }
    if (value.length > MAX_LABEL_VALUE_LENGTH || value.includes("?") || SECRET_VALUE.test(value) || JWT_VALUE.test(value)) {
      throw new Error(`disallowed metric label value for ${name}`);
    }
  }
}

function normalizeLabelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function seriesKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join(",");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  const body = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
  return `{${body}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

interface Series {
  readonly labels: MetricLabels;
  value: number;
}

abstract class Metric {
  protected readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge",
  ) {}

  protected upsert(labels: MetricLabels): Series {
    assertLabels(labels);
    const key = seriesKey(labels);
    let series = this.series.get(key);
    if (series === undefined) {
      series = { labels: { ...labels }, value: 0 };
      this.series.set(key, series);
    }
    return series;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    for (const series of this.series.values()) {
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    }
    return lines.join("\n");
  }
}

export class Counter extends Metric {
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }

  inc(amount = 1, labels: MetricLabels = {}): void {
    if (amount < 0) {
      throw new Error("counter increments must be non-negative");
    }
    this.upsert(labels).value += amount;
  }
}

export class Gauge extends Metric {
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }

  set(value: number, labels: MetricLabels = {}): void {
    this.upsert(labels).value = value;
  }

  inc(amount = 1, labels: MetricLabels = {}): void {
    this.upsert(labels).value += amount;
  }
}

/**
 * A tiny Prometheus-compatible metrics registry that renders the text
 * exposition format. It intentionally refuses high-cardinality / sensitive
 * label names so the metrics plane can never become an exfiltration channel.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    const existing = this.metrics.get(name);
    if (existing instanceof Counter) {
      return existing;
    }
    if (existing !== undefined) {
      throw new Error(`metric ${name} already registered with a different type`);
    }
    const counter = new Counter(name, help);
    this.metrics.set(name, counter);
    return counter;
  }

  gauge(name: string, help: string): Gauge {
    const existing = this.metrics.get(name);
    if (existing instanceof Gauge) {
      return existing;
    }
    if (existing !== undefined) {
      throw new Error(`metric ${name} already registered with a different type`);
    }
    const gauge = new Gauge(name, help);
    this.metrics.set(name, gauge);
    return gauge;
  }

  render(): string {
    return `${[...this.metrics.values()].map((metric) => metric.render()).join("\n\n")}\n`;
  }
}
