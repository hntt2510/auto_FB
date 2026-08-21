import { describe, expect, it } from 'vitest';
import { isAllowedRendererUrl } from './navigationPolicy';

describe('renderer navigation policy', () => {
  it('allows only the application document and rejects external or alternate paths', () => {
    expect(isAllowedRendererUrl('file:///D:/app/out/renderer/index.html#accounts', 'file:///D:/app/out/renderer/index.html')).toBe(true);
    expect(isAllowedRendererUrl('file:///D:/app/out/renderer/other.html', 'file:///D:/app/out/renderer/index.html')).toBe(false);
    expect(isAllowedRendererUrl('https://example.com/', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedRendererUrl('http://localhost:5173/other', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedRendererUrl('http://localhost:5173/?query=1', 'http://localhost:5173/')).toBe(true);
  });
});
