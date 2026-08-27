import assert from "node:assert/strict";
import fs from "node:fs";

const build = fs.readFileSync("scripts/build-node20-candidates.sh", "utf8");
const start = fs.readFileSync("scripts/start-isolated-preview.sh", "utf8");
assert.match(build, /--target web/);
assert.match(build, /--target worker/);
assert.match(build, /process.versions.node/);
assert.match(build, /images.tsv/);
assert.match(build, /sha256:/);
assert.doesNotMatch(build, /docker push|production|jiawang-commerce-new-/);
assert.match(start, /validate-isolated-preview.sh/);
assert.match(start, /--no-build --force-recreate/);
assert.doesNotMatch(start, /down -v|volume prune|docker volume rm|jiawang-commerce-new-/);
console.log("PASS candidate release scripts contract");
