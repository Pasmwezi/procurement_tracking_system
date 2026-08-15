const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFilesResponse } = require('../public/js/clientPayloads');

test('normalizeFilesResponse reads paginated file-list responses', () => {
    const files = [{ id: 1 }, { id: 2 }];
    assert.deepEqual(normalizeFilesResponse({ data: files, total: 2, page: 1, limit: 50 }), files);
});

test('normalizeFilesResponse remains compatible with legacy arrays', () => {
    const files = [{ id: 1 }];
    assert.equal(normalizeFilesResponse(files), files);
});

test('normalizeFilesResponse safely handles missing payloads', () => {
    assert.deepEqual(normalizeFilesResponse(null), []);
    assert.deepEqual(normalizeFilesResponse({}), []);
});
