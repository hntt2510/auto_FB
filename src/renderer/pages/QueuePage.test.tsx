import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueueItem } from '@shared/types';
import { MarkVerifiedDialog } from './QueuePage';
import { submitVerificationEvidence, verificationEvidenceError } from '../verificationEvidence';

const item: QueueItem = { id: 'queue', accountId: 'account', groupId: 'group', draftTitle: 'Draft', body: 'Body', accountName: 'FB01', groupName: 'Target group', groupUrl: 'https://www.facebook.com/groups/test', status: 'SUBMITTED', media: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

describe('Mark Verified dialog', () => {
  it('renders a custom evidence modal instead of a browser prompt', () => {
    const html = renderToStaticMarkup(<MarkVerifiedDialog item={item} onCancel={vi.fn()} onConfirm={vi.fn()} onError={vi.fn()} />);
    expect(html).toContain('Verification evidence');
    expect(html).toContain('Confirmed the post is visible in the target Facebook group.');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('Mark verified');
    expect(readFileSync(join(process.cwd(), 'src', 'renderer', 'pages', 'QueuePage.tsx'), 'utf8')).not.toContain('window.prompt');
  });

  it('rejects empty evidence without calling the backend', async () => {
    const submit = vi.fn(async () => undefined);
    expect(verificationEvidenceError('   ')).toBe('Verification evidence is required.');
    await expect(submitVerificationEvidence(item.id, '   ', submit)).rejects.toThrow('Verification evidence is required.');
    expect(submit).not.toHaveBeenCalled();
  });

  it('trims and submits valid evidence to the existing API contract', async () => {
    const submit = vi.fn(async () => undefined);
    await submitVerificationEvidence(item.id, '  Confirmed visible in the target group.  ', submit);
    expect(submit).toHaveBeenCalledWith(item.id, 'Confirmed visible in the target group.');
  });

  it('rejects evidence longer than 500 characters', () => {
    expect(verificationEvidenceError('x'.repeat(501))).toBe('Verification evidence must be 500 characters or fewer.');
  });

  it('verifies QueuePage contains clear distinction titles for single run vs batch run', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'pages', 'QueuePage.tsx'), 'utf8');
    expect(source).toContain('title="Run this group only"');
    expect(source).toContain('title="Run all checked groups"');
    expect(source).toContain('Prepare & Run Batch');
    expect(source).toContain('Run all pending for this draft');
  });
});
