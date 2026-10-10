const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production compose requires a digest-pinned application image without a build override', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /image:\s*pasmwezi\/procurement_tracking_system@\$\{APP_IMAGE_DIGEST:\?[^}]+\}/);
    assert.doesNotMatch(compose, /^\s+build:/m);
    assert.match(compose, /read_only:\s*true/);
    assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /image:\s*postgres:16-alpine@sha256:[a-f0-9]{64}/);
});

test('application container healthcheck exercises the database-backed health endpoint', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /healthcheck:[\s\S]*127\.0\.0\.1:3000\/api\/health/);
    assert.match(compose, /start_period:/);
});

test('container build uses lockfile installs in every dependency stage', () => {
    const dockerfile = read('Dockerfile');
    assert.doesNotMatch(dockerfile, /RUN npm install(?:\s|$)/);
    assert.match(dockerfile, /RUN npm ci/);
    const bases = [...dockerfile.matchAll(/^FROM\s+([^\s]+)/gm)].map(match => match[1]);
    assert.ok(bases.length >= 2);
    assert.ok(bases.every(image => /@sha256:[a-f0-9]{64}$/.test(image)));
    assert.doesNotMatch(dockerfile, /COPY\s+--chown=node:node/);
    assert.match(dockerfile, /apk add --no-cache dumb-init=\d+\.\d+\.\d+-r\d+/);
});

test('public health failure does not expose raw database exceptions', () => {
    const server = read('server.js');
    const health = server.match(/app\.get\('\/api\/health'[\s\S]*?\n\}\);/);
    assert.ok(health, 'health route must exist');
    assert.doesNotMatch(health[0], /message:\s*err\.message/);
    assert.match(health[0], /Database unavailable/);
});
