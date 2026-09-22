// Domain types for C (opportunity-driven autonomous site growth engine).
// See DESIGN.md sections 6-9 for the specification these mirror.

export type SiteMaturity = 'bootstrap' | 'exploring' | 'growing' | 'optimizing';

// --- Opportunity (DESIGN.md 6.1) ---

export type OpportunityScope =
  | { type: 'page'; path: string }
  | { type: 'cluster'; representativeQueries: string[] }
  | { type: 'site' };

export type OpportunityKind =
  | 'ctr_title'
  | 'content_gap'
  | 'proprietary_data'
  | 'intent_mismatch'
  | 'other';

export type OpportunityIdentity = {
  scopeKey: string;
  intentKey: string;
};

export type OpportunityStatus = 'open' | 'promoted' | 'rejected' | 'stale';

export type OpportunityEventType =
  | 'discovered'
  | 'promoted'
  | 'released'
  | 'rejected'
  | 'reopened'
  | 'note';

export type OpportunityEvent = {
  at: string;
  type: OpportunityEventType;
  note?: string;
  relatedExperimentId?: string;
};

export type OpportunitySignals = {
  hasGscTraction: boolean;
  contentGapConfirmed: boolean;
  leveragesProprietaryData: boolean;
};

export type Opportunity = {
  id: string;
  createdAt: string;
  updatedAt: string;
  scope: OpportunityScope;
  identity: OpportunityIdentity;
  kind: OpportunityKind;
  title: string;
  description: string;
  evidence: Evidence[];
  signals: OpportunitySignals;
  status: OpportunityStatus;
  history: OpportunityEvent[];
};

// --- Evidence (DESIGN.md 6.2) ---

export type EvidenceSource =
  | 'gsc_query'
  | 'gsc_page'
  | 'serp'
  | 'existing_page'
  | 'proprietary_data'
  | 'ga4'
  | 'manual';

export type Evidence = {
  source: EvidenceSource;
  summary: string;
  ref?: string;
  collectedAt: string;
};

// --- Hypothesis (DESIGN.md 6.3) ---

export type MetricKey =
  | 'impressions'
  | 'clicks'
  | 'ctr'
  | 'position'
  | 'organic_sessions'
  | 'qualified_sessions'
  | 'conversions'
  | 'revenue';

export type Hypothesis = {
  id: string;
  opportunityId: string;
  createdAt: string;
  statement: string;
  expectedSignals: MetricKey[];
  rationale: string;
};

// --- Action (DESIGN.md 6.4) ---

export type ActionType = 'CREATE' | 'REVISE' | 'LINK' | 'MERGE' | 'SPLIT' | 'RETIRE';

export type Action = {
  type: ActionType;
  targetPaths: string[];
  summary: string;
  requiredFacts: string[];
  forbiddenChanges: string[];
};

// --- Experiment / MeasurementPlan (DESIGN.md 6.5) ---

export type MeasurementPlan = {
  targetPages: string[];
  targetQueries?: string[];
  primaryMetric: MetricKey;
  secondaryMetrics: MetricKey[];
  baselineWindowDays: number;
  reviewWindowDays: number;
  minimumImpressions?: number;
};

export type ExperimentStatus =
  | 'proposed'
  | 'approved'
  | 'applied'
  | 'observing'
  | 'concluded'
  | 'rejected';

export type MetricsSnapshotSource = 'gsc' | 'ga4' | 'websearch' | 'manual' | 'fixture';

export type MetricsSnapshot = {
  at: string;
  source: MetricsSnapshotSource;
  window: { start: string; end: string; days: number };
  scope: { targetPages: string[]; targetQueries?: string[] };
  metrics: Partial<Record<MetricKey, number>>;
  sufficientData: boolean;
};

export type ReviewOutcome =
  | 'hypothesis_supported'
  | 'partially_supported'
  | 'no_effect'
  | 'worse'
  | 'insufficient_data';

export type ExperimentEventType = ExperimentStatus | 'applied_rolled_back';

export type ExperimentEvent = {
  at: string;
  type: ExperimentEventType;
  note?: string;
};

/** Fixed rolling-review checkpoint tiers, days since Experiment.observation.start. */
export const CHECKPOINT_DAYS = [3, 7, 14, 28] as const;
export type CheckpointDay = (typeof CHECKPOINT_DAYS)[number];

/**
 * A "look, don't necessarily conclude" review at a fixed checkpoint tier
 * (rolling PDCA, not a 28-day-only wait). Uses an equal-length before/after
 * window (never a trailing-N-day GSC window compared against itself) so an
 * early checkpoint isn't diluted by mostly-overlapping days.
 */
export type ReviewCheckpoint = {
  at: string;
  checkpointDay: CheckpointDay;
  elapsedDays: number;
  comparisonWindow: {
    beforeStart: string;
    beforeEnd: string;
    afterStart: string;
    afterEnd: string;
    days: number;
  };
  before: MetricsSnapshot;
  after: MetricsSnapshot;
  decision: 'continue_observing' | 'ready_to_conclude' | 'insufficient_data';
  note: string;
};

export type Experiment = {
  id: string;
  opportunityId: string;
  hypothesisId: string;
  action: Action;
  measurementPlan: MeasurementPlan;
  status: ExperimentStatus;
  before: MetricsSnapshot | null;
  after?: MetricsSnapshot;
  observation?: { start: string; end: string; nextReviewDate: string };
  result?: { outcome: ReviewOutcome; notes: string };
  learning?: string;
  checkpoints?: ReviewCheckpoint[];
  createdAt: string;
  updatedAt: string;
  history: ExperimentEvent[];
};

/** Active (non-terminal) experiment statuses, per DESIGN.md 7.3 / 12 (active experiment guard). */
export const ACTIVE_EXPERIMENT_STATUSES: ExperimentStatus[] = [
  'proposed',
  'approved',
  'applied',
  'observing',
];

// --- Learning (DESIGN.md 6.6) ---

export type LearningEntry = {
  id: string;
  derivedFromExperimentIds: string[];
  statement: string;
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
};

// --- Site Understanding (DESIGN.md 6.7) ---

export type PageSnapshot = {
  path: string;
  title?: string;
  headings: string[];
  excerpt: string;
  excerptTruncated: boolean;
  contentHash: string;
  wordCount: number;
  fetchedAt: string;
};

export type GscSummaryRow = {
  query: string;
  page: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SiteUnderstanding = {
  schemaVersion: 2;
  site: { baseUrl: string };
  generatedAt: string;
  pages: PageSnapshot[];
  themes: string[];
  proprietaryDataNotes: string[];
  gscSummary?: {
    window: { start: string; end: string; days: number };
    topQueries: GscSummaryRow[];
  };
  maturity: SiteMaturity;
};

// --- rank-history.json (DESIGN.md 7.4, 9.2) ---

export type RankSource = 'gsc' | 'websearch' | 'manual' | 'fixture';

export type RankHistoryRow = {
  query: string;
  page: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type RankHistoryEntry = {
  date: string;
  source: RankSource;
  window?: { start: string; end: string; days: number };
  rows: RankHistoryRow[];
  note?: string;
};

export type RankHistory = {
  schemaVersion: 2;
  entries: RankHistoryEntry[];
};

// --- Adapters ---

export interface SiteReaderAdapter {
  listPages(): Promise<Array<{ path: string; source: 'sitemap' | 'crawl' }>>;
  readPage(path: string): Promise<{ path: string; html: string; text: string; title?: string; headings: string[] }>;
}

export interface GscAdapter {
  fetchQueryPageMatrix(input: {
    property: string;
    startDate: string;
    endDate: string;
    /** Restrict rows to pages containing this substring (DESIGN.md multi-site GSC scoping). */
    pagePrefix?: string;
    /** Exclude rows for pages containing this substring (e.g. a subdomain that must not leak into the parent site's property). */
    excludePagePrefix?: string;
  }): Promise<{ rows: GscSummaryRow[] }>;
}

export type SerpInspection = {
  query: string;
  results: Array<{
    rank: number;
    title: string;
    url: string;
    summary: string;
  }>;
};

export interface SearchAdapter {
  inspectSerp(input: { query: string; topN: number }): Promise<SerpInspection>;
}

export interface NaturalWriterAdapter {
  transform(input: {
    mode: 'create' | 'revise';
    targetLanguage: 'ja';
    contentType: 'article';
    existingText?: string;
    searchNeed: string;
    requiredFacts: string[];
    requiredChanges: string[];
    forbiddenChanges: string[];
    targetKeyword: string;
  }): Promise<{
    text: string;
    preservedFacts: string[];
    warnings: string[];
  }>;
}

/** Milestone 2+. No implementation is wired to any Milestone 1A CLI command. */
export interface SiteWriterAdapter {
  apply(input: { targetPath: string; newText: string }): Promise<{ changedFiles: string[]; summary: string }>;
  validate(): Promise<{ ok: boolean; output: string }>;
}

/** Milestone 2+. Only a NotImplemented stub exists in Milestone 1A. */
export interface ActionExecutor {
  supports(type: ActionType): boolean;
  apply(input: {
    action: Action;
    site: SiteWriterAdapter;
    writer: NaturalWriterAdapter;
  }): Promise<{ changedFiles: string[]; summary: string }>;
}

// --- Config (DESIGN.md section 8) ---

export type SeoConfig = {
  schemaVersion: 2;
  site: {
    /**
     * Multi-site state namespace (DESIGN.md multi-site). When set, all state
     * (site-understanding/opportunities/experiments/rank-history/lock) and
     * reports for this config live under data/seo/<key>/ and reports/<key>/
     * instead of the legacy data/seo/ and reports/ roots. Optional for
     * backward compatibility with configs that never set it.
     */
    key?: string;
    baseUrl: string;
    mode: 'existing' | 'bootstrap';
    reader: 'http' | 'filesystem';
    repoRoot: string | null;
    contentRoot: string | null;
    maxPages?: number;
  };
  gsc: {
    property: string;
    credentialsEnv: string;
    defaultWindowDays: number;
    reviewWindowDays: number;
    finalDataLagDays: number;
    /** Restrict GSC rows to pages containing this substring (multi-site scoping, e.g. a subdomain's URL prefix). */
    pagePrefix?: string;
    /** Exclude GSC rows for pages containing this substring (e.g. a subdomain that must not leak into a domain-property fetch). */
    excludePagePrefix?: string;
  };
  experiment: {
    cooldownDays: number;
    maxActiveExperiments?: number;
  };
  commands: {
    build: string | null;
    test: string | null;
  };
  adapters: {
    writer: 'stub' | 'cli';
    site: 'http-readonly' | 'filesystem-readonly' | 'fixture';
    search: 'fixture' | 'file';
  };
};

// --- experiment memory (concluded Experiments -> discover --dump-inputs) ---

/**
 * A bounded summary of a concluded Experiment so DISCOVER doesn't propose
 * re-running something already tried on the same page (DESIGN.md rolling
 * PDCA). Deliberately thin — the full Experiment/Opportunity record remains
 * the source of truth; this is just enough for a Skill to recognize "already
 * tried this".
 */
export type ExperimentMemory = {
  experimentId: string;
  opportunityId: string;
  actionType: ActionType;
  targetPaths: string[];
  outcome: ReviewOutcome;
  learning?: string;
  concludedAt: string;
};

// --- discover input (Skill -> CLI) ---

export type DiscoverOpportunityInput = {
  scope: OpportunityScope;
  kind: OpportunityKind;
  intentSlug: string;
  title: string;
  description: string;
  evidence: Evidence[];
  reopen?: boolean;
  reopenReason?: string;
};

// --- propose input (Skill -> CLI) ---

export type ProposeInput = {
  hypothesis: {
    statement: string;
    expectedSignals: MetricKey[];
    rationale: string;
  };
  action: Action;
  measurementPlan: MeasurementPlan;
};

// --- review decision input (Skill -> CLI, rolling checkpoint review) ---

/**
 * `review --review-file`: the Skill's semantic judgment on a freshly
 * recomputed checkpoint (core never invents this call itself — see
 * ReviewCheckpoint.decision for core's own mechanical
 * data-sufficiency-only signal). `decision: 'conclude'` requires
 * `proposedOutcome`; core still validates it's consistent with whether the
 * checkpoint actually has sufficient data (DESIGN.md: insufficient_data is
 * never silently turned into no_effect).
 */
export type ReviewDecisionInput = {
  decision: 'continue_observing' | 'conclude';
  proposedOutcome?: ReviewOutcome;
  note: string;
  learning?: string;
};

// --- apply evidence (Skill/human -> CLI, Milestone 2 minimal REVISE-only apply) ---

export type ApplyEvidence = {
  targetPage: string;
  siteRepo: string;
  changedFiles: string[];
  actionSummary: string;
  commitSha: string;
  commitBranch: string;
  bReview: {
    tool: string;
    claimPreservation: { preserved: number; modified: number; invented: number };
  };
  siteValidation: { lintContent: string; build: string };
  deployMethod: string;
  liveVerification: {
    httpStatus: number;
    sectionPresent: boolean;
    existingSectionsIntact: string[];
    canonicalUnchanged: boolean;
    noindexUnchanged: boolean;
  };
};

// --- status view (DESIGN.md section 11) ---

export type StatusView = {
  openOpportunities: number;
  proposedExperiments: number;
  observingExperiments: Array<{ id: string; opportunityTitle: string; nextReviewDate: string }>;
  dueForReviewExperiments: Array<{ id: string; opportunityTitle: string }>;
  concludedRecently: Experiment[];
};
