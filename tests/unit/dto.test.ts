import { describe, it, expect } from 'vitest';
import { toUserDto, toSessionDto } from '../../src/lib/server/dto.js';

// Plan 01-07 (Wave 4) — PITFALL P3 DTO discipline. Round-trip projection
// asserted to strip every secret-shaped field even when the input row
// carries them (defense-in-depth — schema-as-types alone is not sufficient,
// because TypeScript erases at runtime; the projection is the runtime guard).
describe('DTO discipline (PITFALL P3)', () => {
  it('toUserDto strips google_sub / accountId / passwords / verification', () => {
    const fakeUser = {
      id: 'u-1',
      email: 'a@b.test',
      name: 'A',
      image: null,
      // Fields that MUST NOT appear in DTO:
      googleSub: 'gsub-secret',
      refreshToken: 'r-tok',
      accessToken: 'a-tok',
      idToken: 'i-tok',
      password: 'should-not-exist',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof toUserDto>[0];

    const dto = toUserDto(fakeUser);
    expect(dto).toEqual({ id: 'u-1', email: 'a@b.test', name: 'A', image: null });
    expect(dto).not.toHaveProperty('googleSub');
    expect(dto).not.toHaveProperty('refreshToken');
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('idToken');
    expect(dto).not.toHaveProperty('password');
    expect(dto).not.toHaveProperty('emailVerified');
  });

  it('toSessionDto omits the session token (=cookie value)', () => {
    const fakeSession = {
      id: 's-1',
      userId: 'u-1',
      token: 'cookie-token-secret',
      expiresAt: new Date(),
      ipAddress: '1.2.3.4',
      userAgent: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof toSessionDto>[0];

    const dto = toSessionDto(fakeSession);
    expect(dto).not.toHaveProperty('token');
    expect(dto).not.toHaveProperty('userId');
  });
});
