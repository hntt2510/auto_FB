export class AccountLockManager {
  private readonly locks = new Set<string>();

  acquire(accountId: string): boolean {
    if (this.locks.has(accountId)) return false;
    this.locks.add(accountId);
    return true;
  }

  release(accountId: string): void { this.locks.delete(accountId); }
  isLocked(accountId: string): boolean { return this.locks.has(accountId); }
  clear(): void { this.locks.clear(); }
}
