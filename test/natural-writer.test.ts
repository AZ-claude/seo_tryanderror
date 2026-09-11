import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StubNaturalWriterAdapter } from '../src/adapters/natural-writer.js';

test('StubNaturalWriterAdapter combines existing text, facts, and changes', async () => {
  const adapter = new StubNaturalWriterAdapter();
  const result = await adapter.transform({
    mode: 'revise',
    targetLanguage: 'ja',
    contentType: 'article',
    existingText: '既存の本文',
    searchNeed: 'need',
    requiredFacts: ['fact 1', 'fact 2'],
    requiredChanges: ['change 1'],
    forbiddenChanges: [],
    targetKeyword: 'kw',
  });
  assert.match(result.text, /既存の本文/);
  assert.match(result.text, /fact 1/);
  assert.match(result.text, /change 1/);
  assert.deepEqual(result.preservedFacts, ['fact 1', 'fact 2']);
  assert.equal(result.warnings.length, 0);
});

test('StubNaturalWriterAdapter warns when forbiddenChanges is non-empty', async () => {
  const adapter = new StubNaturalWriterAdapter();
  const result = await adapter.transform({
    mode: 'create',
    targetLanguage: 'ja',
    contentType: 'article',
    searchNeed: 'need',
    requiredFacts: [],
    requiredChanges: ['change'],
    forbiddenChanges: ['do not remove pricing table'],
    targetKeyword: 'kw',
  });
  assert.equal(result.warnings.length, 1);
});
