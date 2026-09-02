const test = require('node:test');
const assert = require('node:assert/strict');

const { isAwardMilestone, isCancellationState } = require('../services/triageProgress');

test('isAwardMilestone recognizes an award workflow step', () => {
    assert.equal(isAwardMilestone('Contract Award', 'Active'), true);
    assert.equal(isAwardMilestone('Award Issuance', 'Active'), true);
});

test('isAwardMilestone recognizes completed linked files as awarded', () => {
    assert.equal(isAwardMilestone('Completed', 'Completed'), true);
    assert.equal(isAwardMilestone('Amendment Completed', 'Completed'), true);
});

test('isAwardMilestone leaves pre-award active steps assigned', () => {
    assert.equal(isAwardMilestone('Team Lead Review (Contract)', 'Active'), false);
    assert.equal(isAwardMilestone('Evaluation', 'Active'), false);
});

test('isCancellationState recognizes only the canonical cancelled file status', () => {
    assert.equal(isCancellationState('Cancelled'), true);
    assert.equal(isCancellationState('Active'), false);
    assert.equal(isCancellationState('Completed'), false);
    assert.equal(isCancellationState(null), false);
});
