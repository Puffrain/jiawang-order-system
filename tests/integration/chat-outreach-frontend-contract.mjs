import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "components/admin/conversation-list.tsx"), "utf8");

assert.match(source, /canRecommendProducts=\{true\}/, "merchant chat must explicitly enable product recommendations");
assert.match(source, /fetch\(\"\/api\/customers\"/, "new conversations must load customers");
assert.match(source, /customer\.status === \"active\"/, "only active customers may be selected");
assert.match(source, /fetch\(\"\/api\/chat\/conversations\", \{ method: \"PATCH\"/, "conversation actions must use the planned PATCH endpoint");
assert.match(source, /action: \"clear\" \| \"hide\"/, "clear and hide must both be supported");
assert.match(source, /current\.length < 100/, "bulk selection must be capped at 100 recipients");
assert.match(source, /customers\.slice\(0, 100\)/, "select-all must retain the 100-recipient cap");
assert.match(source, /window\.confirm\(`将向 \${selectedIds\.length} 位客户发送/, "bulk sends require explicit confirmation");
assert.match(source, /fetch\(\"\/api\/chat\/bulk\"/, "bulk sends must use the planned endpoint");
assert.match(source, /buyerUserIds: selectedIds/, "bulk payload must contain recipient ids");
assert.match(source, /type: hasText \? "text" : "product"/, "bulk payload must declare its content type");
assert.match(source, /batchId: crypto\.randomUUID\(\)/, "bulk payload must be idempotent");
assert.match(source, /hasText && productId/, "bulk sends must contain text or one product, not both");
assert.match(source, /收件人之间互不可见/, "confirmation must state recipient privacy");

console.log("PASS chat outreach frontend contract");
