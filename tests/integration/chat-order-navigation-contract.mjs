import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const dashboard = read("components/admin-dashboard.tsx");
const conversations = read("components/admin/conversation-list.tsx");
const orderCenter = read("components/admin/order-center.tsx");
const chatPanel = read("components/chat/chat-panel.tsx");
const orderCard = read("components/chat/order-message-card.tsx");

assert.match(
  chatPanel,
  /onClick=\{\s*onOpenOrder\s*\?\s*\(\)\s*=>\s*onOpenOrder\(message\.orderId!\)\s*:\s*undefined\s*\}/,
);
assert.ok(conversations.includes("onOpenOrder={onOpenOrder}"));
assert.ok(
  dashboard.includes(
    `openOrder=(orderId:string)=>{setOrderToOpen(orderId);selectTab("orders")}`,
  ),
);
assert.ok(dashboard.includes("initialOrderId={orderToOpen}"));
assert.ok(
  dashboard.includes("onInitialOrderHandled={()=>setOrderToOpen(null)}"),
);
assert.match(
  orderCenter,
  /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(!initialOrderId\)\s*return;\s*void open\(initialOrderId\);\s*onInitialOrderHandled\?\.\(\);/,
);
assert.match(orderCenter, /detailRequest\s*=\s*useRef\(0\)/);
assert.match(orderCenter, /requestId\s*!==\s*detailRequest\.current/);
assert.match(
  orderCenter,
  /finally\s*\{\s*if\s*\(requestId\s*===\s*detailRequest\.current\)\s*setDetailLoading\(false\)/,
);
assert.ok(orderCenter.includes("onInitialOrderHandled?.()"));
assert.match(orderCenter, /role="dialog"[\s\S]{0,80}aria-modal="true"/);
assert.ok(orderCenter.includes("<fieldset disabled={!editable}>"));
assert.ok(orderCard.includes(`return onClick?<button type="button"`));
assert.ok(orderCard.includes(`:<div className="mt-2`));
assert.match(orderCard, /ChevronRight/);

console.log("PASS chat order navigation contract");
