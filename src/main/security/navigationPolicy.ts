/** Returns true only for the exact application renderer URL/path. */
export function isAllowedRendererUrl(candidateUrl: string, applicationUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const application = new URL(applicationUrl);
    if (candidate.protocol !== application.protocol) return false;
    if (candidate.protocol === 'file:') return candidate.pathname === application.pathname;
    return candidate.origin === application.origin && candidate.pathname === application.pathname;
  } catch {
    return false;
  }
}
