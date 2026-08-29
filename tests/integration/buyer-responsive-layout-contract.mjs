import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const page = read("app/buyer/page.tsx");
const catalog = read("components/buyer/catalog-home.tsx");
const detail = read("components/buyer/product-detail.tsx");

assert.ok(page.includes("max-w-[460px]"), "mobile buyer shell width must remain unchanged");
assert.ok(page.includes("lg:max-w-[1440px]"), "desktop buyer shell must expand at the large breakpoint");
assert.ok(page.includes('tab === "home"') || page.includes('tab==="home"'), "only the catalog tab may use the widest desktop shell");
assert.ok(page.includes("lg:max-w-[760px]"), "single-column buyer tabs must retain a readable desktop width");
assert.ok(page.includes("fixed inset-x-0 bottom-0"), "mobile navigation must remain fixed at the bottom");
assert.ok(page.includes("lg:static lg:max-w-none"), "desktop navigation must move into the page flow");

assert.ok(catalog.includes("grid-cols-[92px_1fr]"), "mobile catalog must retain its narrow category rail");
assert.ok(catalog.includes("lg:grid-cols-[184px_minmax(0,1fr)]"), "desktop catalog must widen the category rail");
assert.ok(catalog.includes("lg:grid-cols-2") && catalog.includes("xl:grid-cols-3"), "desktop product list must use two and three column grids");
assert.ok(catalog.includes("data-buyer-product-card"), "product cards must expose a stable acceptance selector");
assert.ok(catalog.includes("overflow-x-auto"), "category navigation must remain scrollable when desktop categories overflow");
assert.ok(!catalog.includes("lg:overflow-visible"), "desktop category navigation must not disable overflow scrolling");
assert.ok(!catalog.includes("justify-center"), "overflowing category navigation must remain start-aligned");

assert.ok(detail.includes("max-w-[520px]"), "mobile product detail width must remain unchanged");
assert.ok(detail.includes("lg:max-w-[1280px]"), "desktop product detail must expand at the large breakpoint");
assert.ok(detail.includes("lg:grid-cols-[minmax(0,1fr)_minmax(380px,480px)]"), "desktop product detail must split gallery and purchase controls");
assert.ok(detail.includes("fixed inset-x-0 bottom-0"), "mobile purchase action must remain fixed");
assert.ok(detail.includes("lg:sticky lg:bottom-6"), "desktop purchase action must remain visible without covering content");

console.log("PASS buyer responsive layout contract");
