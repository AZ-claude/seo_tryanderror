import { addDays, isBeforeOrEqual } from './date.js';
import type { Experiment, Opportunity, StatusView } from './types.js';

const RECENTLY_CONCLUDED_WINDOW_DAYS = 30;

/**
 * DESIGN.md section 11: opportunities/experiments status view, replacing the
 * old keyword-bucket `getStatus()`. Pure function over already-loaded state.
 */
export function getStatusView(input: {
  opportunities: Opportunity[];
  experiments: Experiment[];
  today: string;
}): StatusView {
  const { opportunities, experiments, today } = input;
  const titleFor = (opportunityId: string): string =>
    opportunities.find((o) => o.id === opportunityId)?.title ?? '(unknown opportunity)';

  const observingExperiments = experiments
    .filter((e) => e.status === 'observing' && e.observation && !isBeforeOrEqual(e.observation.nextReviewDate, today))
    .map((e) => ({ id: e.id, opportunityTitle: titleFor(e.opportunityId), nextReviewDate: e.observation!.nextReviewDate }));

  const dueForReviewExperiments = experiments
    .filter((e) => e.status === 'observing' && e.observation && isBeforeOrEqual(e.observation.nextReviewDate, today))
    .map((e) => ({ id: e.id, opportunityTitle: titleFor(e.opportunityId) }));

  const recentCutoff = addDays(today, -RECENTLY_CONCLUDED_WINDOW_DAYS);
  const concludedRecently = experiments.filter(
    (e) => e.status === 'concluded' && e.updatedAt.slice(0, 10) >= recentCutoff,
  );

  return {
    openOpportunities: opportunities.filter((o) => o.status === 'open').length,
    proposedExperiments: experiments.filter((e) => e.status === 'proposed').length,
    observingExperiments,
    dueForReviewExperiments,
    concludedRecently,
  };
}
