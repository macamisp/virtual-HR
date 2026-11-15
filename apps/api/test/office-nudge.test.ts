/**
 * Nudge rules (ADR 058, FR-VO-016), pure: who is near enough, and how the operator's settings
 * are read (bounded, defaults when missing or nonsense).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NUDGE_RULES, NudgeAnswerDtoSchema, NudgeDtoSchema, nudgeReach, nudgeRules } from '../../../packages/shared/src/office/index.ts';

describe('Nudge rules (ADR 058)', () => {
  it('near enough means the same floor, the same room (or both in the open) and within reach', () => {
    const at = (x: number, y: number, roomId: string | null = null, floorId: string | null = 'ground') => ({ x, y, roomId, floorId });
    assert.equal(nudgeReach(at(0, 0), at(160, 0), 160), true);
    assert.equal(nudgeReach(at(0, 0), at(161, 0), 160), false);
    assert.equal(nudgeReach(at(0, 0), at(100, 100), 160), true);
    assert.equal(nudgeReach(at(0, 0), at(120, 120), 160), false);
    assert.equal(nudgeReach(at(0, 0, 'r1'), at(10, 0, 'r1'), 160), true);
    assert.equal(nudgeReach(at(0, 0, 'r1'), at(10, 0, null), 160), false, 'not through a room wall');
    assert.equal(nudgeReach(at(0, 0, 'r1'), at(10, 0, 'r2'), 160), false);
    assert.equal(nudgeReach(at(0, 0, null, 'ground'), at(10, 0, null, 'first'), 160), false);
    assert.equal(nudgeReach(at(0, 0, null, null), at(0, 0, null, null), 160), false, 'nowhere is not near');
  });

  it('settings: defaults, operator values, bounds, and nonsense ignored', () => {
    assert.deepEqual(nudgeRules({}), DEFAULT_NUDGE_RULES);
    assert.deepEqual(DEFAULT_NUDGE_RULES, { reachPx: 160, cooldownMs: 30_000, ttlMs: 20_000 });
    assert.deepEqual(nudgeRules({ OFFICE_NUDGE_REACH_PX: '240', OFFICE_NUDGE_COOLDOWN_MS: '5000', OFFICE_NUDGE_TTL_MS: '10000' }), { reachPx: 240, cooldownMs: 5000, ttlMs: 10_000 });
    assert.deepEqual(nudgeRules({ OFFICE_NUDGE_REACH_PX: '1', OFFICE_NUDGE_COOLDOWN_MS: '-5', OFFICE_NUDGE_TTL_MS: '5' }), { reachPx: 32, cooldownMs: 0, ttlMs: 1000 });
    assert.deepEqual(nudgeRules({ OFFICE_NUDGE_REACH_PX: '99999', OFFICE_NUDGE_COOLDOWN_MS: '9999999', OFFICE_NUDGE_TTL_MS: '9999999' }), { reachPx: 640, cooldownMs: 600_000, ttlMs: 120_000 });
    assert.deepEqual(nudgeRules({ OFFICE_NUDGE_REACH_PX: 'far', OFFICE_NUDGE_COOLDOWN_MS: '', OFFICE_NUDGE_TTL_MS: 'NaN' }), DEFAULT_NUDGE_RULES);
  });

  it('bodies are strict: a person id and nothing else; an id and a yes or no', () => {
    const id = 'f1f40000-0000-4000-8000-000000000011';
    assert.equal(NudgeDtoSchema.safeParse({ to: id }).success, true);
    for (const bad of [{}, { to: 'me' }, { to: id, orgId: id }, { to: id, from: id }, { to: [id] }]) assert.equal(NudgeDtoSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(NudgeAnswerDtoSchema.safeParse({ id, accept: true }).success, true);
    for (const bad of [{ id }, { id, accept: 'yes' }, { id, accept: true, to: id }]) assert.equal(NudgeAnswerDtoSchema.safeParse(bad).success, false, JSON.stringify(bad));
  });
});
