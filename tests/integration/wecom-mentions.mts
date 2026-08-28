import assert from "node:assert/strict";
import { parseMentionMobiles } from "../../lib/wecom";

assert.deepEqual(parseMentionMobiles(), []);
assert.deepEqual(parseMentionMobiles("13800138000"), ["13800138000"]);
assert.deepEqual(
  parseMentionMobiles("13800138000, 13900139000，13800138000\ninvalid"),
  ["13800138000", "13900139000"],
);
assert.deepEqual(parseMentionMobiles("@all,13800138000"), ["@all", "13800138000"]);

process.stdout.write("wecom mention parsing: PASS\n");
