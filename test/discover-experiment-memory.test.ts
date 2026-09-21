import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExperimentMemory } from '../src/core/workflow/discover.js';
import type { Experiment } from '../src/core/types.js';

function concluded(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'EXP',
    opportunityId: 'OPP',
    hypothesisId: 'HYP',
    action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['/a/'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
    status: 'concluded',
    before: null,
    result: { outcome: 'hypothesis_supported', notes: 'notes' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [],
    ...overrides,
  };
}

// 17. discover dumpにconcluded Experiment memory
test('buildExperimentMemory: includes concluded Experiments with the expected bounded shape', () => {
  const memory = buildExperimentMemory([concluded({ learning: 'context links help CTR' })]);
  assert.equal(memory.length, 1);
  assert.deepEqual(memory[0], {
    experimentId: 'EXP',
    opportunityId: 'OPP',
    actionType: 'REVISE',
    targetPaths: ['/a/'],
    outcome: 'hypothesis_supported',
    learning: 'context links help CTR',
    concludedAt: '2026-09-01T00:00:00.000Z',
  });
});

test('buildExperimentMemory: excludes non-concluded Experiments', () => {
  const memory = buildExperimentMemory([
    concluded({ id: 'E1' }),
    { ...concluded({ id: 'E2' }), status: 'observing', result: undefined },
  ]);
  assert.equal(memory.length, 1);
  assert.equal(memory[0]!.experimentId, 'E1');
});

// 18. bounded
test('buildExperimentMemory: bounded to the most recent 50, newest first', () => {
  const many: Experiment[] = Array.from({ length: 60 }, (_, i) =>
    concluded({
      id: `E${i}`,
      updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );
  const memory = buildExperimentMemory(many);
  assert.equal(memory.length, 50);
  // newest-updatedAt-first ordering
  for (let i = 1; i < memory.length; i++) {
    assert.ok(memory[i - 1]!.concludedAt >= memory[i]!.concludedAt);
  }
});

// 19. learning無しExperimentでも壊れない
test('buildExperimentMemory: an Experiment concluded without a learning does not break (field simply omitted)', () => {
  const memory = buildExperimentMemory([concluded({ learning: undefined })]);
  assert.equal(memory.length, 1);
  assert.equal('learning' in memory[0]!, false);
  assert.equal(JSON.stringify(memory[0]!).includes('learning'), false);
});
