import { describe, expect, it } from 'vitest';
import { queueOptionsSchema } from './queue.ipc';

describe('queue options IPC schema', () => {
  it('validates the semantic draft identifier field', () => {
    const draftId = '11111111-1111-4111-8111-111111111111';
    expect(queueOptionsSchema.safeParse({ draftId, accountIds: [] }).success).toBe(true);
    expect(queueOptionsSchema.safeParse({ draftId: 'queue-not-a-draft-id', accountIds: [] }).success).toBe(false);
  });
});
