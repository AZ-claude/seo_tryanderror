// Domain types for C (SEO self-improvement loop).
// See DESIGN.md sections 4-15 for the specification these mirror.

export type Priority = 'high' | 'medium' | 'low';

export type KeywordRecord = {
  keyword: string;
  targetPath: string;
  priority: Priority;
};

export type Watchwords = {
  schemaVersion: 1;
  site: string;
  gscProperty: string;
  keywords: KeywordRecord[];
};

export type RankSource = 'gsc' | 'websearch' | 'manual' | 'fixture';

export type RankMeasurement = {
  keyword: string;
  rank: number | null;
  impressions: number;
  clicks: number;
  url?: string;
};

export type RankHistoryEntry = {
  date: string;
  source: RankSource;
  window?: { start: string; end: string; days: number };
  measurements: RankMeasurement[];
  note?: string;
};

export type RankHistory = {
  schemaVersion: 1;
  entries: RankHistoryEntry[];
};

export type ImprovementStatus = 'active' | 'observing' | 'achieved';

export type ChangeType =
  | 'title'
  | 'description'
  | 'intro'
  | 'faq'
  | 'content'
  | 'internal_link'
  | 'data'
  | 'other';

export type ReviewOutcome =
  | 'achieved'
  | 'improved_not_achieved'
  | 'no_effect'
  | 'worse'
  | 'insufficient_data';

export type ImprovementAction = {
  date: string;
  rankAtAction: number | null;
  rankSource: RankSource;
  searchNeed: string;
  gap: string[];
  done: string;
  changeType: ChangeType;
  sources: string[];
  baseline?: {
    impressions?: number;
    clicks?: number;
  };
  review?: {
    date: string;
    outcome: ReviewOutcome;
    previousRank: number | null;
    currentRank: number | null;
    notes: string;
  };
};

export type ImprovementKeywordState = {
  keyword: string;
  targetPath: string;
  status: ImprovementStatus;
  nextReviewDate: string | null;
  actions: ImprovementAction[];
};

export type ImprovementLog = {
  schemaVersion: 1;
  keywords: ImprovementKeywordState[];
};

// --- Status buckets (DESIGN.md section 10) ---

export type StatusBuckets = {
  dueForReview: KeywordRecord[];
  observing: KeywordRecord[];
  active: KeywordRecord[];
  achieved: KeywordRecord[];
};

// --- Adapters ---

export type UnregisteredQuery = {
  query: string;
  rank: number;
  impressions: number;
  clicks: number;
};

export interface GscAdapter {
  fetchRankWindow(input: {
    property: string;
    startDate: string;
    endDate: string;
    watchwords: KeywordRecord[];
  }): Promise<{
    measurements: RankMeasurement[];
    unregisteredQueries: UnregisteredQuery[];
  }>;
}

export type SerpInspection = {
  keyword: string;
  results: Array<{
    rank: number;
    title: string;
    url: string;
    summary: string;
  }>;
};

export interface SearchAdapter {
  inspectSerp(input: {
    keyword: string;
    targetUrl: string;
    topN: number;
  }): Promise<SerpInspection>;
}

export type SeoPlanInput = {
  keyword: KeywordRecord;
  latestMeasurement: RankMeasurement | null;
  targetPage: {
    path: string;
    content: string;
  };
  serp: SerpInspection;
  previousActions: ImprovementAction[];
};

export type SeoPlan = {
  searchNeed: string;
  evidence: string[];
  gaps: string[];
  selectedGap: string;
  changeType: ChangeType;
  requestedChange: string;
  requiredFacts: string[];
  forbiddenChanges: string[];
  sources: string[];
};

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

export interface SiteAdapter {
  readPage(targetPath: string): Promise<{ path: string; content: string }>;
  apply(input: {
    targetPath: string;
    newText: string;
    plan: SeoPlan;
  }): Promise<{ changedFiles: string[]; summary: string }>;
  validate(): Promise<{ ok: boolean; output: string }>;
}

// --- Config ---

export type SeoConfig = {
  schemaVersion: 1;
  site: {
    baseUrl: string;
    repoRoot: string;
    contentRoot: string;
  };
  gsc: {
    property: string;
    credentialsEnv: string;
    defaultWindowDays: number;
    reviewWindowDays: number;
    finalDataLagDays: number;
  };
  experiment: {
    cooldownDays: number;
    oneKeywordPerRun: boolean;
  };
  commands: {
    build: string;
    test: string;
  };
  adapters: {
    writer: 'stub' | 'cli';
    site: 'fixture' | 'filesystem';
    search: 'fixture' | 'file';
  };
};
