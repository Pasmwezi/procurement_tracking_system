(function exposeClientPayloads(root, factory) {
    const helpers = factory();
    if (typeof module === 'object' && module.exports) module.exports = helpers;
    if (root) root.normalizeFilesResponse = helpers.normalizeFilesResponse;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createClientPayloads() {
    function normalizeFilesResponse(payload) {
        if (Array.isArray(payload)) return payload;
        return payload && Array.isArray(payload.data) ? payload.data : [];
    }

    return { normalizeFilesResponse };
}));
