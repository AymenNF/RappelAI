import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTimezone,
  CONSENT_VERSION,
  hasOnboarded,
  onboard,
  type IdentityState,
} from '../../src/modules/identity/onboarding.js';

const now = new Date('2026-10-27T18:00:00Z');
const blank = (): IdentityState => ({
  consent_version: null,
  consent_at: null,
  consent_token: null,
  consent_offer_version: null,
  consent_expires_at: null,
  paused: false,
  timezone: null,
  timezone_confirmed_at: null,
  pending_timezone: null,
  timezone_token: null,
  timezone_expires_at: null,
  last_control_at: null,
});
const step = (state: IdentityState, text: string | null, token = 'test-token') =>
  onboard(state, text, now, now, () => token);
function consented() {
  return step(step(blank(), 'hello').state, 'CONSENT test-token').state;
}
function ready() {
  return step(step(consented(), 'TIMEZONE America/Toronto').state, 'CONFIRM TIMEZONE test-token')
    .state;
}

test('first message cannot imply consent; explicit version-bound token required', () => {
  const first = step(blank(), 'yes');
  assert.equal(first.state.consent_at, null);
  assert.match(first.reply!, new RegExp(CONSENT_VERSION));
  assert.equal(step(first.state, 'CONSENT wrong').state.consent_at, null);
  const accepted = step(first.state, 'CONSENT test-token');
  assert.equal(accepted.consentAction, 'accepted');
  assert.equal(hasOnboarded(accepted.state), false);
});
test('timezone accepts named zones, rejects abbreviations, guesses and offsets', () => {
  assert.equal(canonicalTimezone('America/Toronto'), 'America/Toronto');
  assert.equal(canonicalTimezone('UTC'), 'UTC');
  for (const input of ['EST', '-04:00', 'Toronto', 'Mars/Olympus', ''])
    assert.equal(canonicalTimezone(input), null);
});
test('timezone is proposed then explicitly confirmed; no country inference', () => {
  const proposal = step(consented(), 'TIMEZONE America/Toronto');
  assert.equal(proposal.state.timezone, null);
  assert.match(proposal.reply!, /2:00/);
  assert.equal(step(proposal.state, 'CONFIRM TIMEZONE wrong').disposition, 'blocked');
  assert.equal(hasOnboarded(step(proposal.state, 'CONFIRM TIMEZONE test-token').state), true);
});
test('STOP revokes immediately; START does not restore consent', () => {
  const stopped = step(ready(), 'STOP');
  assert.equal(stopped.consentAction, 'revoked');
  assert.equal(hasOnboarded(stopped.state), false);
  assert.equal(step(stopped.state, 'remind me').disposition, 'blocked');
  assert.equal(step(stopped.state, 'START').state.consent_at, null);
});
test('expired confirmations do not grant consent or timezone', () => {
  const offered = step(blank(), 'hello').state;
  const later = new Date(now.getTime() + 2 * 86400000);
  assert.equal(
    onboard(offered, 'CONSENT test-token', later, later, () => 'new-token').state.consent_at,
    null,
  );
  const proposed = step(consented(), 'TIMEZONE Europe/Paris').state;
  assert.equal(onboard(proposed, 'CONFIRM TIMEZONE test-token', later, later).state.timezone, null);
});
test('old setting changes cannot override newer controls, but old STOP still revokes', () => {
  const state = ready();
  const old = new Date(now.getTime() - 60000);
  assert.equal(onboard(state, 'TIMEZONE Europe/Paris', old, now).disposition, 'blocked');
  assert.equal(onboard(state, 'STOP', old, now).state.paused, true);
});
test('only onboarded text reaches ready; pending zone change gates processing', () => {
  assert.equal(step(blank(), 'remind me').disposition, 'handled');
  assert.equal(step(ready(), 'remind me').disposition, 'ready');
  assert.equal(step(ready(), null).disposition, 'blocked');
  assert.equal(hasOnboarded(step(ready(), 'TIMEZONE Europe/Paris').state), false);
});
test('a new consent version invalidates eligibility', () => {
  assert.equal(hasOnboarded({ ...ready(), consent_version: 'obsolete' }), false);
  const oldOffer = { ...step(blank(), 'hello').state, consent_offer_version: 'obsolete' };
  assert.equal(step(oldOffer, 'CONSENT test-token').state.consent_at, null);
});
