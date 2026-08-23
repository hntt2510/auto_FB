export function verificationEvidenceError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Verification evidence is required.';
  if (trimmed.length > 500) return 'Verification evidence must be 500 characters or fewer.';
  return undefined;
}

export async function submitVerificationEvidence(queueId: string, value: string, submit: (queueId: string, evidence: string) => Promise<unknown>): Promise<void> {
  const issue = verificationEvidenceError(value); if (issue) throw new Error(issue); await submit(queueId, value.trim());
}
