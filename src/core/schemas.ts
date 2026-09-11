import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const priority = z.enum(['high', 'medium', 'low']);
const rankSource = z.enum(['gsc', 'websearch', 'manual', 'fixture']);
const changeType = z.enum([
  'title',
  'description',
  'intro',
  'faq',
  'content',
  'internal_link',
  'data',
  'other',
]);
const reviewOutcome = z.enum([
  'achieved',
  'improved_not_achieved',
  'no_effect',
  'worse',
  'insufficient_data',
]);

export const keywordRecordSchema = z.object({
  keyword: z.string().min(1),
  targetPath: z.string().min(1),
  priority,
});

export const watchwordsSchema = z
  .object({
    schemaVersion: z.literal(1),
    site: z.string().min(1),
    gscProperty: z.string().min(1),
    keywords: z.array(keywordRecordSchema),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const [index, k] of doc.keywords.entries()) {
      if (seen.has(k.keyword)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate keyword: ${k.keyword}`,
          path: ['keywords', index, 'keyword'],
        });
      }
      seen.add(k.keyword);
    }
  });

export const rankMeasurementSchema = z.object({
  keyword: z.string().min(1),
  rank: z.number().nullable(),
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  url: z.string().optional(),
});

export const rankHistoryEntrySchema = z.object({
  date: dateString,
  source: rankSource,
  window: z
    .object({ start: dateString, end: dateString, days: z.number().positive() })
    .optional(),
  measurements: z.array(rankMeasurementSchema),
  note: z.string().optional(),
});

export const rankHistorySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(rankHistoryEntrySchema),
});

export const improvementActionSchema = z.object({
  date: dateString,
  rankAtAction: z.number().nullable(),
  rankSource,
  searchNeed: z.string().min(1),
  gap: z.array(z.string()),
  done: z.string().min(1),
  changeType,
  sources: z.array(z.string()),
  baseline: z
    .object({ impressions: z.number().optional(), clicks: z.number().optional() })
    .optional(),
  review: z
    .object({
      date: dateString,
      outcome: reviewOutcome,
      previousRank: z.number().nullable(),
      currentRank: z.number().nullable(),
      notes: z.string(),
    })
    .optional(),
});

export const improvementKeywordStateSchema = z.object({
  keyword: z.string().min(1),
  targetPath: z.string().min(1),
  status: z.enum(['active', 'observing', 'achieved']),
  nextReviewDate: dateString.nullable(),
  actions: z.array(improvementActionSchema),
});

export const improvementLogSchema = z.object({
  schemaVersion: z.literal(1),
  keywords: z.array(improvementKeywordStateSchema),
});

export const seoPlanSchema = z
  .object({
    searchNeed: z.string().min(1),
    evidence: z.array(z.string()),
    gaps: z.array(z.string()).min(1),
    selectedGap: z.string().min(1),
    changeType,
    requestedChange: z.string().min(1),
    requiredFacts: z.array(z.string()),
    forbiddenChanges: z.array(z.string()),
    sources: z.array(z.string()),
  })
  .superRefine((plan, ctx) => {
    if (!plan.gaps.includes(plan.selectedGap)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selectedGap must be one of gaps',
        path: ['selectedGap'],
      });
    }
  });

export const serpInspectionSchema = z.object({
  keyword: z.string().min(1),
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
  schemaVersion: z.literal(1),
  site: z.object({
    baseUrl: z.string().min(1),
    repoRoot: z.string().min(1),
    contentRoot: z.string().min(1),
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
    oneKeywordPerRun: z.boolean(),
  }),
  commands: z.object({
    build: z.string().min(1),
    test: z.string().min(1),
  }),
  adapters: z.object({
    writer: z.enum(['stub', 'cli']),
    site: z.enum(['fixture', 'filesystem']),
    search: z.enum(['fixture', 'file']),
  }),
});
