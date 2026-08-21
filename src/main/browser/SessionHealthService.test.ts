import { describe, expect, it } from 'vitest';
import { classifySession } from './SessionHealthService';

describe('session classification', () => {
  it('recognizes login, checkpoint, ready, and unknown states conservatively', () => {
    expect(classifySession({ url: 'https://www.facebook.com/login', text: '', loginForm: true, appNavigation: false }).status).toBe('LOGIN_REQUIRED');
    expect(classifySession({ url: 'https://www.facebook.com/checkpoint', text: '', loginForm: false, appNavigation: false }).status).toBe('CHECKPOINT');
    expect(classifySession({ url: 'https://www.facebook.com/', text: 'News Feed', loginForm: false, appNavigation: true }).status).toBe('READY');
    expect(classifySession({ url: 'https://www.facebook.com/', text: 'Something unclear', loginForm: false, appNavigation: false }).status).toBe('ERROR');
  });
});
