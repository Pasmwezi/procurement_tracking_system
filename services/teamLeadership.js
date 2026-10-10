const OFFICER_CLASSIFICATIONS = Object.freeze(['PG-2', 'PG-3', 'PG-4']);
const TRIAGE_LEVELS = Object.freeze(['Low', 'High']);
const REVIEW_GATES = Object.freeze([
    'strategy', 'pre-solicitation', 'addendum', 'evaluation approach', 'pre-award',
    'amendment', 'change order', 'extension of time', 'payment/holdback', 'close-out', 'other'
]);
const REVIEW_STATUSES = Object.freeze([
    'submitted', 'reviewing', 'returned', 'resubmitted', 'cleared',
    'conditionally cleared', 'escalated'
]);
const CHECKPOINT_TYPES = Object.freeze(['objective-setting', 'mid-year', 'year-end']);

function recommendOfficerClassification(valueClassification, complexity) {
    if (!TRIAGE_LEVELS.includes(valueClassification) || !TRIAGE_LEVELS.includes(complexity)) {
        throw new Error('Value classification and complexity must be Low or High');
    }
    if (valueClassification === 'High' && complexity === 'High') return 'PG-4';
    if (valueClassification === 'Low' && complexity === 'Low') return 'PG-2';
    return 'PG-3';
}

function validateAssignmentMatch(recommended, selected, rationale) {
    if (!OFFICER_CLASSIFICATIONS.includes(recommended)) throw new Error('Invalid recommended classification');
    if (selected !== null && selected !== undefined && !OFFICER_CLASSIFICATIONS.includes(selected)) {
        throw new Error('Invalid selected officer classification');
    }
    const override = selected !== recommended;
    const normalized = typeof rationale === 'string' ? rationale.trim() : '';
    if (override && !normalized) throw new Error('A nonblank override rationale is required');
    return { override, rationale: normalized || null };
}

function validateReviewTransition(fromStatus, toStatus, role) {
    const leaderTargets = {
        submitted: ['reviewing', 'returned', 'conditionally cleared', 'cleared', 'escalated'],
        reviewing: ['returned', 'conditionally cleared', 'cleared', 'escalated'],
        resubmitted: ['reviewing', 'returned', 'conditionally cleared', 'cleared', 'escalated']
    };
    const allowed = role === 'officer'
        ? (fromStatus === 'returned' && toStatus === 'resubmitted')
        : ['team_leader', 'admin'].includes(role) && (leaderTargets[fromStatus] || []).includes(toStatus);
    if (!REVIEW_STATUSES.includes(fromStatus) || !REVIEW_STATUSES.includes(toStatus) || !allowed) {
        throw new Error(`Review transition from ${fromStatus} to ${toStatus} is not allowed for ${role}`);
    }
    return true;
}

function sanitizePerformanceCheckpoint(payload) {
    const forbidden = Object.keys(payload || {}).filter(key => /narrative|rating/i.test(key));
    if (forbidden.length) throw new Error('Performance checkpoints cannot contain narrative or rating fields');
    const officerId = Number(payload?.officer_id);
    const year = Number(payload?.year);
    if (!Number.isInteger(officerId) || officerId <= 0) throw new Error('officer_id must be a positive integer');
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('year is invalid');
    if (!CHECKPOINT_TYPES.includes(payload?.checkpoint_type)) throw new Error('Invalid checkpoint type');
    if (!payload?.due_date) throw new Error('due_date is required');
    return {
        officer_id: officerId,
        year,
        checkpoint_type: payload.checkpoint_type,
        due_date: payload.due_date,
        completion_date: payload.completion_date || null,
        hr_record_date: payload.hr_record_date || null,
        followup_date: payload.followup_date || null
    };
}

module.exports = {
    OFFICER_CLASSIFICATIONS,
    TRIAGE_LEVELS,
    REVIEW_GATES,
    REVIEW_STATUSES,
    CHECKPOINT_TYPES,
    recommendOfficerClassification,
    validateAssignmentMatch,
    validateReviewTransition,
    sanitizePerformanceCheckpoint
};
