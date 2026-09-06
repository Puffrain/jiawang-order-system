import assert from "node:assert/strict";
import fs from "node:fs";

const proxy = fs.readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
assert.ok(proxy.includes('if (!bearerApi && pathname.startsWith("/api/")'), "Bearer APIs must bypass browser-only CSRF checks");
assert.ok(proxy.includes('requestHeaders.get("sec-fetch-site") === "cross-site"'), "cookie-authenticated cross-site writes must remain blocked");
assert.ok(proxy.includes('if (bearerApi) return withSecurity(NextResponse.next'), "Bearer token must still flow through session authentication");
console.log("mini program bearer CSRF contract: PASS");
