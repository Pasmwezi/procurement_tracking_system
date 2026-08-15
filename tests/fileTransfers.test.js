const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTransfers } = require('../services/fileTransfers');

test('normalizeTransfers accepts distinct active-file transfer instructions', () => {
    assert.deepEqual(normalizeTransfers(4, [
        { file_id: '10', to_officer_id: '7' },
        { file_id: 11, to_officer_id: 8 }
    ]), [
        { fileId: 10, toOfficerId: 7 },
        { fileId: 11, toOfficerId: 8 }
    ]);
});

test('normalizeTransfers rejects duplicate files', () => {
    assert.throws(
        () => normalizeTransfers(4, [
            { file_id: 10, to_officer_id: 7 },
            { file_id: 10, to_officer_id: 8 }
        ]),
        /more than once/i
    );
});

test('normalizeTransfers rejects a transfer back to the source officer', () => {
    assert.throws(
        () => normalizeTransfers(4, [{ file_id: 10, to_officer_id: 4 }]),
        /different/i
    );
});

test('normalizeTransfers rejects malformed identifiers and empty batches', () => {
    assert.throws(() => normalizeTransfers(4, []), /at least one/i);
    assert.throws(() => normalizeTransfers(4, [{ file_id: 'x', to_officer_id: 7 }]), /integer/i);
    assert.throws(() => normalizeTransfers(4, [{ file_id: 10, to_officer_id: 0 }]), /integer/i);
});
