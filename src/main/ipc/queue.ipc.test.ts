import { describe, expect, it } from 'vitest';
import { queueOptionsSchema } from './queue.ipc';
import { queueBatchActionSchema, queueBatchRescheduleSchema } from '@shared/schemas';

describe('queue options IPC schema', () => {
  it('validates the semantic draft identifier field', () => {
    const draftId = '11111111-1111-4111-8111-111111111111';
    expect(queueOptionsSchema.safeParse({ draftId, accountIds: [] }).success).toBe(true);
    expect(queueOptionsSchema.safeParse({ draftId: 'queue-not-a-draft-id', accountIds: [] }).success).toBe(false);
  });
  it('rejects malformed transactional batch payloads', () => { const id = '11111111-1111-4111-8111-111111111111'; expect(queueBatchActionSchema.safeParse({ queueIds: [id], action: 'PAUSE' }).success).toBe(true); expect(queueBatchActionSchema.safeParse({ queueIds: [], action: 'PAUSE' }).success).toBe(false); expect(queueBatchRescheduleSchema.safeParse({ queueIds: [id], mode: 'SET_TIME' }).success).toBe(false); expect(queueBatchRescheduleSchema.safeParse({ queueIds: [id], mode: 'SHIFT', shiftMinutes: 0 }).success).toBe(false); });
});
