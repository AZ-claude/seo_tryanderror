import { z } from 'zod';

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const isoTimestamp = z.string().min(1);

const rankSource = z.enum(['gsc', 'websearch', 'manual', 'fixture']);
const metricKey = z.enum([
  'impressions',
  'clicks',
  'ctr',
  'position',
  'organic_sessions',
  'qualified_sessions',
  'conversions',
  'revenue',
]);
const siteMaturity = z.enum(['bootstrap', 'exploring', 'growing', 'optimizing']);

export const opportunityScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), path: z.string().min(1) }),
  z.object({ type: z.literal('cluster'), representativeQueries: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('site') }),
]);

export const opportunityKindSchema = z.enum([
  'ctr_title',
  'content_gap',
  'proprietary_data',
  'intent_mismatch',
  'other',
]);

export const opportunityIdentitySchema = z.object({
  scopeKey: z.string().min(1),
  intentKey: z.string().min(1),
});

export const evidenceSourceSchema = z.enum([
  'gsc_query',
  'gsc_page',
  'serp',
  'existing_page',
  'proprietary_data',
  'ga4',
  'manual',
]);

export const evidenceSchema = z.object({
  source: evidenceSourceSchema,
  summary: z.string().min(1),
  ref: z.string().optional(),
  collectedAt: isoTimestamp,
});

export const opportunitySignalsSchema = z.object({
  hasGscTraction: z.boolean(),
  contentGapConfirmed: z.boolean(),
  leveragesProprietaryData: z.boolean(),
});

export const opportunityStatusSchema = z.enum(['open', 'promoted', 'rejected', 'stale']);

export const opportunityEventSchema = z.object({
  at: isoTimestamp,
  type: z.enum(['discovered', 'promoted', 'released', 'rejected', 'reopened', 'note']),
  note: z.string().optional(),
  relatedExperimentId: z.string().optional(),
});

export const opportunitySchema = z.object({
  id: z.string().min(1),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  scope: opportunityScopeSchema,
  identity: opportunityIdentitySchema,
  kind: opportunityKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: z.array(evidenceSchema),
  signals: opportunitySignalsSchema,
  status: opportunityStatusSchema,
  history: z.array(opportunityEventSchema),
});

export const opportunitiesFileSchema = z.object({
  schemaVersion: z.literal(2),
  opportunities: z.array(opportunitySchema),
});

export const hypothesisSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  createdAt: isoTimestamp,
  statement: z.string().min(1),
  expectedSignals: z.array(metricKey).min(1),
  rationale: z.string().min(1),
});

export const actionTypeSchema = z.enum(['CREATE', 'REVISE', 'LINK', 'MERGE', 'SPLIT', 'RETIRE']);

export const actionSchema = z.object({
  type: actionTypeSchema,
  targetPaths: z.array(z.string().min(1)),
  summary: z.string().min(1),
  requiredFacts: z.array(z.string()),
  forbiddenChanges: z.array(z.string()),
});

export const measurementPlanSchema = z
  .object({
    targetPages: z.array(z.string().min(1)).min(1),
    targetQueries: z.array(z.string().min(1)).optional(),
    primaryMetric: metricKey,
    secondaryMetrics: z.array(metricKey),
    baselineWindowDays: z.number().positive(),
    reviewWindowDays: z.number().positive(),
    minimumImpressions: z.number().nonnegative().optional(),
  })
  .superRefine((plan, ctx) => {
    if (plan.targetQueries) {
      const seen = new Set(plan.targetQueries);
      if (seen.size !== plan.targetQueries.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'targetQueries must not contain duplicates', path: ['targetQueries'] });
      }
    }
  });

export const experimentStatusSchema = z.enum([
  'proposed',
  'approved',
  'applied',
  'observing',
  'concluded',
  'rejected',
]);

export const metricsSnapshotSourceSchema = z.enum(['gsc', 'ga4', 'websearch', 'manual', 'fixture']);

export const metricsSnapshotSchema = z.object({
  at: isoTimestamp,
  source: metricsSnapshotSourceSchema,
  window: z.object({ start: dateString, end: dateString, days: z.number().positive() }),
  scope: z.object({ targetPages: z.array(z.string().min(1)), targetQueries: z.array(z.string().min(1)).optional() }),
  metrics: z.record(metricKey, z.number()),
  sufficientData: z.boolean(),
});

export const reviewOutcomeSchema = z.enum([
  'hypothesis_supported',
  'partially_supported',
  'no_effect',
  'worse',
  'insufficient_data',
]);

export const experimentEventSchema = z.object({
  at: isoTimestamp,
  type: z.union([experimentStatusSchema, z.literal('applied_rolled_back')]),
  note: z.string().optional(),
});

export const checkpointDaySchema = z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(28)]);

export const reviewCheckpointSchema = z.object({
  at: isoTimestamp,
  checkpointDay: checkpointDaySchema,
  elapsedDays: z.number().nonnegative(),
  comparisonWindow: z.object({
    beforeStart: dateString,
    beforeEnd: dateString,
    afterStart: dateString,
    afterEnd: dateString,
    days: z.number().positive(),
  }),
  before: metricsSnapshotSchema,
  after: metricsSnapshotSchema,
  decision: z.enum(['continue_observing', 'ready_to_conclude', 'insufficient_data']),
  note: z.string(),
});

export const experimentSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  hypothesisId: z.string().min(1),
  action: actionSchema,
  measurementPlan: measurementPlanSchema,
  status: experimentStatusSchema,
  before: metricsSnapshotSchema.nullable(),
  after: metricsSnapshotSchema.optional(),
  observation: z.object({ start: dateString, end: dateString, nextReviewDate: dateString }).optional(),
  result: z.object({ outcome: reviewOutcomeSchema, notes: z.string() }).optional(),
  learning: z.string().optional(),
  checkpoints: z.array(reviewCheckpointSchema).optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  history: z.array(experimentEventSchema),
});

export const experimentsFileSchema = z.object({
  schemaVersion: z.literal(2),
  experiments: z.array(experimentSchema),
});

export const learningEntrySchema = z.object({
  id: z.string().min(1),
  derivedFromExperimentIds: z.array(z.string().min(1)),
  statement: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  createdAt: isoTimestamp,
});

export const learningsFileSchema = z.object({
  schemaVersion: z.literal(2),
  learnings: z.array(learningEntrySchema),
});

export const pageSnapshotSchema = z.object({
  path: z.string().min(1),
  title: z.string().optional(),
  headings: z.array(z.string()),
  excerpt: z.string(),
  excerptTruncated: z.boolean(),
  contentHash: z.string().min(1),
  wordCount: z.number().nonnegative(),
  fetchedAt: isoTimestamp,
});

export const gscSummaryRowSchema = z.object({
  query: z.string().min(1),
  page: z.string().nullable(),
  clicks: z.number().nonnegative(),
  impressions: z.number().nonnegative(),
  ctr: z.number().nonnegative(),
  position: z.number().nonnegative(),
});

export const siteUnderstandingSchema = z.object({
  schemaVersion: z.literal(2),
  site: z.object({ baseUrl: z.string().min(1) }),
  generatedAt: isoTimestamp,
  pages: z.array(pageSnapshotSchema),
  themes: z.array(z.string()),
  proprietaryDataNotes: z.array(z.string()),
  gscSummary: z
    .object({
      window: z.object({ start: dateString, end: dateString, days: z.number().positive() }),
      topQueries: z.array(gscSummaryRowSchema),
    })
    .optional(),
  maturity: siteMaturity,
});

export const rankHistoryRowSchema = z.object({
  query: z.string().min(1),
  page: z.string().nullable(),
  clicks: z.number().nonnegative(),
  impressions: z.number().nonnegative(),
  ctr: z.number().nonnegative(),
  position: z.number().nonnegative(),
});

export const rankHistoryEntrySchema = z.object({
  date: dateString,
  source: rankSource,
  window: z.object({ start: dateString, end: dateString, days: z.number().positive() }).optional(),
  rows: z.array(rankHistoryRowSchema),
  note: z.string().optional(),
});

export const rankHistorySchema = z.object({
  schemaVersion: z.literal(2),
  entries: z.array(rankHistoryEntrySchema),
});

export const serpInspectionSchema = z.object({
  query: z.string().min(1),
  results: z.array(
    z.object({
      rank: z.number(),
      title: z.string(),
      url: z.string(),
      summary: z.string(),
    }),
  ),
});

export const seoConfigSchema = z.object({
  schemaVersion: z.literal(2),
  site: z.object({
    baseUrl: z.string().min(1),
    mode: z.enum(['existing', 'bootstrap']),
    reader: z.enum(['http', 'filesystem']),
    repoRoot: z.string().nullable(),
    contentRoot: z.string().nullable(),
    maxPages: z.number().int().positive().optional(),
  }),
  gsc: z.object({
    property: z.string().min(1),
    credentialsEnv: z.string().min(1),
    defaultWindowDays: z.number().positive(),
    reviewWindowDays: z.number().positive(),
    finalDataLagDays: z.number().nonnegative(),
  }),
  experiment: z.object({
    cooldownDays: z.number().positive(),
    maxActiveExperiments: z.number().int().positive().optional(),
  }),
  commands: z.object({
    build: z.string().nullable(),
    test: z.string().nullable(),
  }),
  adapters: z.object({
    writer: z.enum(['stub', 'cli']),
    site: z.enum(['http-readonly', 'filesystem-readonly', 'fixture']),
    search: z.enum(['fixture', 'file']),
  }),
});

export const discoverOpportunityInputSchema = z
  .object({
    scope: opportunityScopeSchema,
    kind: opportunityKindSchema,
    intentSlug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'intentSlug must be kebab-case'),
    title: z.string().min(1),
    description: z.string().min(1),
    evidence: z.array(evidenceSchema),
    reopen: z.boolean().optional(),
    reopenReason: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.reopen && !input.reopenReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reopenReason is required when reopen=true',
        path: ['reopenReason'],
      });
    }
  });

export const discoverInputFileSchema = z.object({
  opportunities: z.array(discoverOpportunityInputSchema),
});

export const reviewDecisionInputSchema = z
  .object({
    decision: z.enum(['continue_observing', 'conclude']),
    proposedOutcome: reviewOutcomeSchema.optional(),
    note: z.string().min(1),
    learning: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.decision === 'conclude' && !input.proposedOutcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'proposedOutcome is required when decision=conclude',
        path: ['proposedOutcome'],
      });
    }
  });

export const proposeInputSchema = z.object({
  hypothesis: z.object({
    statement: z.string().min(1),
    expectedSignals: z.array(metricKey).min(1),
    rationale: z.string().min(1),
  }),
  action: actionSchema,
  measurementPlan: measurementPlanSchema,
});

/**
 * `apply --evidence-file` (Milestone 2 minimal REVISE-only apply, DESIGN.md
 * 10.6/13). Records what a human/AI-assisted session already did directly in
 * the site repo (edit, B review, test/build, commit, deploy, live check) so
 * it can be validated and turned into an append-only Experiment history
 * (proposed -> approved -> applied -> observing). This is not a generalized
 * SiteWriter/NaturalWriter executor — see DESIGN.md 9.6 for that future
 * scope.
 */
export const applyEvidenceSchema = z.object({
  targetPage: z.string().min(1),
  siteRepo: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  actionSummary: z.string().min(1),
  commitSha: z.string().min(1),
  commitBranch: z.string().min(1),
  bReview: z.object({
    tool: z.string().min(1),
    claimPreservation: z.object({
      preserved: z.number().nonnegative(),
      modified: z.number().nonnegative(),
      invented: z.number().nonnegative(),
    }),
  }),
  siteValidation: z.object({
    lintContent: z.string().min(1),
    build: z.string().min(1),
  }),
  deployMethod: z.string().min(1),
  liveVerification: z.object({
    httpStatus: z.number(),
    sectionPresent: z.boolean(),
    existingSectionsIntact: z.array(z.string().min(1)),
    canonicalUnchanged: z.boolean(),
    noindexUnchanged: z.boolean(),
  }),
});
