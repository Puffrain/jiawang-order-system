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

assert.match(chatPanel,/onClick=\{\s*onOpenOrder\s*\?\s*\(\)\s*=>\s*onOpenOrder\(message\.orderId!\)\s*:\s*undefined\s*\}/);
assert.ok(conversations.includes("onOpenOrder={onOpenOrder}"));
assert.ok(dashboard.includes(`openOrder=(orderId:string)=>{setOrderToOpen(orderId);selectTab("orders")}`));
assert.ok(dashboard.includes("initialOrderId={orderToOpen}"));
assert.ok(dashboard.includes("onInitialOrderHandled={()=>setOrderToOpen(null)}"));
assert.ok(orderCenter.includes("useEffect(()=>{if(!initialOrderId)return;void open(initialOrderId);onInitialOrderHandled?.()}"));
assert.ok(orderCenter.includes("detailRequest=useRef(0)"));
assert.ok(orderCenter.includes("requestId!==detailRequest.current"));
assert.ok(orderCenter.includes("finally{if(requestId===detailRequest.current)setDetailLoading(false)}"));
assert.ok(orderCenter.includes("onInitialOrderHandled?.()"));
assert.ok(orderCenter.includes(`role="dialog" aria-modal="true"`));
assert.ok(orderCenter.includes("<fieldset disabled={!editable}>"));
assert.ok(orderCard.includes(`return onClick?<button type="button"`));
assert.ok(orderCard.includes(`:<div className="mt-2`));
assert.match(orderCard, /ChevronRight/);

console.log("PASS chat order navigation contract");
