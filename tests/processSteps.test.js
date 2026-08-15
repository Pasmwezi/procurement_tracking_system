const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProcessSteps } = require('../services/processSteps');

test('normalizeProcessSteps trims names, computes order, and recalculates cumulative SLA', () => {
    assert.deepEqual(normalizeProcessSteps([
        { id: '12', step_name: ' Initial review ', sla_days: '4' },
        { id: null, step_name: 'Client review', sla_days: 7 },
        { id: 13, step_name: 'Completed', sla_days: 0 }
    ]), [
        { id: 12, stepName: 'Initial review', slaDays: 4, stepOrder: 1, cumulativeDays: 4 },
        { id: null, stepName: 'Client review', slaDays: 7, stepOrder: 2, cumulativeDays: 11 },
        { id: 13, stepName: 'Completed', slaDays: 0, stepOrder: 3, cumulativeDays: 11 }
    ]);
});

test('normalizeProcessSteps requires at least one named step', () => {
    assert.throws(() => normalizeProcessSteps([]), /at least one/i);
    assert.throws(() => normalizeProcessSteps([{ step_name: ' ', sla_days: 1 }]), /name/i);
});

test('normalizeProcessSteps rejects negative, fractional, or excessive SLA values', () => {
    for (const value of [-1, 1.5, 3651, 'not-a-number']) {
        assert.throws(() => normalizeProcessSteps([{ step_name: 'Review', sla_days: value }]), /sla/i);
    }
});

test('normalizeProcessSteps rejects duplicate or invalid existing IDs', () => {
    assert.throws(() => normalizeProcessSteps([
        { id: 3, step_name: 'One', sla_days: 1 },
        { id: '3', step_name: 'Two', sla_days: 1 }
    ]), /duplicate/i);
    assert.throws(() => normalizeProcessSteps([{ id: -2, step_name: 'One', sla_days: 1 }]), /id/i);
});

test('normalizeProcessSteps requires exactly one final Completed step', () => {
    assert.throws(() => normalizeProcessSteps([
        { step_name: 'Review', sla_days: 1 }
    ]), /Completed/);
    assert.throws(() => normalizeProcessSteps([
        { step_name: 'Completed', sla_days: 0 },
        { step_name: 'After completion', sla_days: 1 }
    ]), /final step/);
    assert.doesNotThrow(() => normalizeProcessSteps([
        { step_name: 'Review', sla_days: 1 },
        { step_name: 'Completed', sla_days: 0 }
    ]));
    assert.doesNotThrow(() => normalizeProcessSteps([
        { step_name: 'Draft amendment', sla_days: 1 },
        { step_name: 'Amendment Completed', sla_days: 0 }
    ]));
});
