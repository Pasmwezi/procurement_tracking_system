const test = require('node:test');
const assert = require('node:assert/strict');

const { isAwardMilestone } = require('../services/triageProgress');

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
