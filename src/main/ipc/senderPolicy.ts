export function isAuthorizedIpcSender(senderId: number, allowedSenderIds: ReadonlySet<number>): boolean {
  return allowedSenderIds.has(senderId);
}
