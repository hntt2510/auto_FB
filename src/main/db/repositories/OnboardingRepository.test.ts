import { describe, expect, it } from 'vitest';
import { onboardingDay } from './OnboardingRepository';

const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);

describe('onboardingDay local calendar semantics', () => {
  it('uses Day 1 throughout the same local date', () => {
    expect(onboardingDay(local(2026, 8, 25, 0, 1).toISOString(), 5, local(2026, 8, 25, 23, 59))).toBe(1);
  });

  it('advances at local midnight instead of after 24 elapsed hours', () => {
    const start = local(2026, 8, 25, 23, 30);
    const nextDate = local(2026, 8, 26, 0, 1);
    expect(nextDate.getTime() - start.getTime()).toBeLessThan(86_400_000);
    expect(onboardingDay(start.toISOString(), 5, nextDate)).toBe(2);
  });

  it('counts multiple calendar dates and crosses month and year boundaries', () => {
    expect(onboardingDay(local(2026, 8, 25, 23, 30).toISOString(), 5, local(2026, 8, 27, 0, 1))).toBe(3);
    expect(onboardingDay(local(2026, 8, 31, 23, 30).toISOString(), 5, local(2026, 9, 1, 0, 1))).toBe(2);
    expect(onboardingDay(local(2026, 12, 31, 23, 30).toISOString(), 5, local(2027, 1, 1, 0, 1))).toBe(2);
  });

  it('caps the plan day and clamps an earlier system clock to Day 1', () => {
    expect(onboardingDay(local(2026, 8, 1).toISOString(), 3, local(2026, 8, 20))).toBe(3);
    expect(onboardingDay(local(2026, 8, 25, 12).toISOString(), 3, local(2026, 8, 24, 12))).toBe(1);
  });

  it('uses local date parts across a 23-hour daylight-saving day', () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const start = new Date(2026, 2, 8, 0, 0);
      const next = new Date(2026, 2, 9, 0, 0);
      expect(next.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
      expect(onboardingDay(start.toISOString(), 5, next)).toBe(2);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('rejects missing or invalid inputs', () => {
    expect(onboardingDay(undefined, 3)).toBeUndefined();
    expect(onboardingDay('invalid', 3)).toBeUndefined();
    expect(onboardingDay(new Date().toISOString(), 0)).toBeUndefined();
    expect(onboardingDay(new Date().toISOString(), 3, new Date(Number.NaN))).toBeUndefined();
  });
});
