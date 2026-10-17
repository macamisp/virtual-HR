/** The local-demo switch for mandatory 2FA (FR-AUTH-004) can never be used in production. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mfaEnforced } from '../src/common/config.ts';

describe('mfaEnforced', () => {
  it('is on unless explicitly switched off', () => {
    assert.equal(mfaEnforced({}), true);
    assert.equal(mfaEnforced({ AUTH_MFA_ENFORCEMENT: 'false' }), true, 'only the exact value "off" counts');
  });
  it('can be switched off outside production', () => {
    assert.equal(mfaEnforced({ AUTH_MFA_ENFORCEMENT: 'off', NODE_ENV: 'development' }), false);
  });
  it('refuses to be off in production', () => {
    assert.throws(() => mfaEnforced({ AUTH_MFA_ENFORCEMENT: 'off', NODE_ENV: 'production' }), /not allowed in production/);
  });
});
