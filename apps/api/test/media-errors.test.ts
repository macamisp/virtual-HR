/** Pre-join camera and microphone messages (FR-MEET-011): HTTPS first, then the browser's reason. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mediaErrorMessage } from '../../../packages/shared/src/meetings/media-errors.ts';

const secure = { secure: true, hasMediaDevices: true, origin: 'https://demo.example.com' };
const err = (name: string) => Object.assign(new Error(name), { name });

describe('Pre-join media error messages (FR-MEET-011)', () => {
  it('on a non-HTTPS origin says HTTPS (or localhost) is required, whatever the browser reported', () => {
    const plain = { secure: false, hasMediaDevices: false, origin: 'http://192.168.1.20:3000' };
    for (const e of [err('NotAllowedError'), err('TypeError'), undefined]) {
      const m = mediaErrorMessage(e, 'camera', plain);
      assert.match(m, /secure connection/);
      assert.match(m, /HTTPS/);
      assert.match(m, /localhost/);
      assert.match(m, /http:\/\/192\.168\.1\.20:3000/);
    }
    assert.match(mediaErrorMessage(err('NotAllowedError'), 'microphone', { ...secure, hasMediaDevices: false }), /HTTPS/, 'no mediaDevices at all');
  });

  it('on HTTPS gives the browser\'s actual reason', () => {
    assert.match(mediaErrorMessage(err('NotAllowedError'), 'camera', secure), /blocked the camera.*Allow it/);
    assert.match(mediaErrorMessage(err('NotFoundError'), 'microphone', secure), /No microphone was found/);
    assert.match(mediaErrorMessage(err('NotReadableError'), 'camera', secure), /in use by another application/);
    assert.equal(mediaErrorMessage(err('Weird'), 'camera', secure), 'The camera could not be started.');
    assert.doesNotMatch(mediaErrorMessage(err('NotAllowedError'), 'camera', secure), /HTTPS/);
  });
});
