import { describe, expect, it } from 'vitest';
import { checkRequest } from './request-guard';

const ok = (h: Parameters<typeof checkRequest>[0]) => checkRequest(h).ok;

describe('checkRequest', () => {
  it('allows a same-origin browser request', () => {
    expect(ok({ 'sec-fetch-site': 'same-origin', host: 'localhost:5173' })).toBe(true);
  });

  it('allows a user-initiated navigation', () => {
    expect(ok({ 'sec-fetch-site': 'none', host: '127.0.0.1:3000' })).toBe(true);
  });

  it('rejects a cross-site request — the CSRF case', () => {
    expect(ok({ 'sec-fetch-site': 'cross-site', host: 'localhost:5173' })).toBe(false);
  });

  it('rejects same-site, which is still a different origin', () => {
    expect(ok({ 'sec-fetch-site': 'same-site', host: 'localhost:5173' })).toBe(false);
  });

  it('rejects a non-loopback Host — the DNS-rebinding case', () => {
    // Rebinding arrives with a same-origin-looking fetch metadata but an
    // attacker-controlled Host, so Sec-Fetch-Site alone would let it through.
    expect(ok({ 'sec-fetch-site': 'same-origin', host: 'evil.example.com' })).toBe(false);
  });

  it('allows a non-browser client that sends no Sec-Fetch-Site', () => {
    // curl, the CLI, tests. No ambient authority to borrow, so not a CSRF vector.
    expect(ok({ host: 'localhost:5173' })).toBe(true);
  });

  it('still requires a loopback Host when Sec-Fetch-Site is absent', () => {
    expect(ok({ host: 'evil.example.com' })).toBe(false);
  });

  it('rejects an absent Host', () => {
    expect(ok({})).toBe(false);
  });

  it('accepts bracketed IPv6 loopback', () => {
    expect(ok({ 'sec-fetch-site': 'same-origin', host: '[::1]:5173' })).toBe(true);
  });

  it('does not treat a lookalike host as loopback', () => {
    expect(ok({ host: 'localhost.evil.com' })).toBe(false);
  });

  it('reports why it rejected', () => {
    const v = checkRequest({ 'sec-fetch-site': 'cross-site', host: 'localhost' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('cross-site');
  });
});
