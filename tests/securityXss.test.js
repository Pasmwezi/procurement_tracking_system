const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const source = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
const functions = ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => source.slice(...n.range)).join('\n');
test('administrator user rendering escapes stored markup and attribute payloads', () => {
    const payload = '<img src=x onerror="globalThis.pwned=1">\\\' &quot;';
    const nodes = {};
    const context = vm.createContext({ adminUsers: [{ id: 1, display_name: payload, email: payload, role: 'officer', team_name: payload, is_active: true }], $: s => nodes[s] ||= { value: '', innerHTML: '' } });
    vm.runInContext(functions + '\nrenderAdminUsers()', context);
    assert.ok(!nodes['#usersBody'].innerHTML.includes('<img'));
    assert.ok(nodes['#usersBody'].innerHTML.includes('&lt;img'));
    assert.ok(!nodes['#usersBody'].innerHTML.includes('globalThis.pwned=1">'));
    assert.ok(!nodes['#usersBody'].innerHTML.includes('resetUserPassword(1,'));
});
