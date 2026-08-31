import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const buyerHome = read("app/buyer/page.tsx");
const detailRoute = read("app/buyer/products/[id]/page.tsx");
const detail = read("components/buyer/product-detail.tsx");
const productApi = read("app/api/products/[id]/route.ts");
const productCreateApi = read("app/api/products/route.ts");
const productCatalog = read("lib/product-catalog.ts");
const productManager = read("components/admin/product-manager.tsx");
const db = read("lib/db.ts");

assert.match(buyerHome, /href={`\/buyer\/products\/\${product\.id}`}/, "home cards must link to product details");
assert.ok(!buyerHome.includes("<select"), "buyer home must not render a SKU selector");
const productCard = buyerHome.slice(buyerHome.indexOf("function ProductCard"), buyerHome.indexOf("function CartView"));
assert.ok(!productCard.includes("/api/cart"), "buyer product cards must not add directly to cart");
assert.match(detailRoute, /ProductDetail productId={id}/);
assert.match(detail, /product\.skus\.map/);
assert.match(detail, /sku\.tiers/);
assert.ok(detail.includes('fetch("/api/cart"'));
assert.match(detail, /sku\.stock<1/);
assert.ok(detail.includes("setMissing(true)"));
assert.match(db, /first_activated_at/);
assert.ok(!productCreateApi.includes("first_activated_at"), "the create route must not use a second activation-history write");
assert.ok(productCatalog.includes("first_activated_at=CASE WHEN ?='active'"));
assert.match(productCatalog, /INSERT INTO products\(id,name,category,category_key,subcategory_key,brand,description,status,first_activated_at\)/);
assert.ok(productApi.includes("first_activated_at=CASE WHEN ?='active'"));
assert.match(productApi, /applyProductLifecycle/);
assert.ok(productCatalog.includes("product.status===\"inactive\""));
assert.match(productCatalog, /!product.warehouseProductId/);
assert.match(productCatalog, /!product.firstActivatedAt/);
assert.match(productCatalog, /orderCount===0/);
assert.match(productCatalog, /action:"deleted"/);
assert.match(productCatalog, /action:permanent\?"permanently-hidden"/);
assert.match(productCatalog, /DELETE FROM cart_items/);
assert.match(productApi, /fs.unlink/);
assert.match(productApi, /product_file_cleanup/);
assert.match(productApi, /cleanupPending/);
assert.match(productManager, /method:"DELETE"/);
assert.match(productManager, /j.action==="deleted"/);
assert.match(productManager, /j.action==="archived"/);

console.log("PASS product detail and safe delete contract");
