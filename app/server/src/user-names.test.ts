import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortUserName } from './user-names.js';

describe('shortUserName', () => {
  it('shortens the tier ServiceAccounts the way the TelemetryPolicy does', () => {
    assert.equal(shortUserName('system:serviceaccount:maas-tier-free:user1'), 'free:user1');
    assert.equal(shortUserName('system:serviceaccount:maas-tier-pro:user5'), 'pro:user5');
    assert.equal(shortUserName('system:serviceaccount:maas-tier-max:user9'), 'max:user9');
  });

  it('is idempotent, so new short labels and folded old ones meet', () => {
    assert.equal(shortUserName('free:user1'), 'free:user1');
  });

  it('leaves every other identity alone', () => {
    assert.equal(shortUserName('admin'), 'admin');
    assert.equal(shortUserName('maas-user'), 'maas-user');
    assert.equal(shortUserName('system:serviceaccount:models-as-a-service:demo-user1'), 'system:serviceaccount:models-as-a-service:demo-user1');
    assert.equal(shortUserName('unknown'), 'unknown');
    assert.equal(shortUserName('system:serviceaccount:maas-tier-'), 'system:serviceaccount:maas-tier-');
  });
});
