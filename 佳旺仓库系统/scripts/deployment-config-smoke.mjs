#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync('compose.yaml', 'utf8');
assert.ok(content.includes('APP_ORIGIN: ${APP_ORIGIN:?set APP_ORIGIN to the public HTTPS origin}'));
assert.ok(content.includes('APP_MASTER_KEY: ${APP_MASTER_KEY:?set APP_MASTER_KEY}'));
assert.ok(!content.includes('APP_MASTER_SECRET'));
assert.match(content, /REQUIRE_ORIGIN:\s*\$\{REQUIRE_ORIGIN:-true\}/);
assert.match(content, /REQUIRE_CSRF:\s*\$\{REQUIRE_CSRF:-true\}/);
assert.ok(content.includes('/warehouse/api/health'));
assert.match(content, /condition:\s*service_completed_successfully/);
assert.match(content, /chown -R 1000:1000 \/data \/media/);
process.stdout.write('warehouse deployment config smoke: required origin and master key; origin and CSRF checks stay enabled\n');
