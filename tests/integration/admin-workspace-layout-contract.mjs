import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const orders = read("components/admin/order-center.tsx");
const conversations = read("components/admin/conversation-list.tsx");
const chat = read("components/chat/chat-panel.tsx");

assert.ok(
  orders.includes('placeholder="搜索订单号、客户名或手机号"'),
  "order management must expose a useful search field",
);
assert.ok(
  orders.includes("data-admin-order-scroll"),
  "order management must expose a stable scroll viewport",
);
assert.match(
  orders,
  /data-admin-order-scroll[\s\S]{0,180}overflow-y-auto/,
  "the order list must scroll vertically",
);
assert.match(
  orders,
  /<thead className="[^"]*sticky[^"]*top-0/,
  "desktop order headers must remain visible while scrolling",
);
assert.ok(
  orders.includes("filteredOrders.map"),
  "order rows must use the filtered result",
);

assert.ok(
  conversations.includes('placeholder="搜索客户、店铺、手机号或消息"'),
  "conversation management must expose a search field",
);
assert.ok(
  conversations.includes("filteredItems.map"),
  "conversation rows must use the filtered result",
);
assert.ok(
  conversations.includes("data-admin-conversation-scroll"),
  "conversation list must expose its own scroll viewport",
);
assert.ok(
  conversations.includes("data-admin-chat-pane"),
  "chat pane must expose a stable acceptance selector",
);
assert.match(
  conversations,
  /data-admin-chat-pane[\s\S]{0,180}min-h-0[\s\S]{0,180}overflow-hidden/,
  "the right chat pane must constrain its internal scrolling",
);
assert.ok(
  chat.includes("data-chat-message-scroll"),
  "message history must expose its own scroll viewport",
);
assert.match(
  chat,
  /data-chat-message-scroll[\s\S]{0,160}overflow-y-auto/,
  "message history must scroll independently of the composer",
);

console.log("PASS admin workspace layout contract");
