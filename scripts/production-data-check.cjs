const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const [mode, databasePath] = process.argv.slice(2);
const db = new Database(databasePath, { readonly: true });
const count = (sql) => Number(db.prepare(sql).get().count);

if (db.pragma("quick_check", { simple: true }) !== "ok") {
  throw new Error("SQLite quick_check failed");
}

if (mode === "order") {
  const mediaFailures = db.prepare("SELECT status,attempt_count attempts,last_error error,next_attempt_at nextAttemptAt FROM warehouse_media_sync ORDER BY updated_at DESC LIMIT 5").all();
  const uploadRoot = process.env.UPLOAD_DIR || "/data/uploads";
  const imageFiles = db.prepare("SELECT storage_key storageKey FROM product_images").all();
  const imageFilesPresent = imageFiles.filter((row) => fs.existsSync(path.join(uploadRoot, row.storageKey))).length;
  console.log(JSON.stringify({
    quickCheck: "ok",
    products: count("SELECT COUNT(*) count FROM products WHERE archived_at IS NULL"),
    activeProducts: count("SELECT COUNT(*) count FROM products WHERE status='active' AND archived_at IS NULL"),
    warehouseProducts: count("SELECT COUNT(*) count FROM products WHERE warehouse_product_id IS NOT NULL AND archived_at IS NULL"),
    activeSkus: count("SELECT COUNT(*) count FROM product_skus WHERE archived_at IS NULL"),
    warehouseSkus: count("SELECT COUNT(*) count FROM product_skus WHERE warehouse_variant_id IS NOT NULL AND archived_at IS NULL"),
    productImages: count("SELECT COUNT(*) count FROM product_images"),
    warehouseImages: count("SELECT COUNT(*) count FROM product_images WHERE warehouse_asset_id IS NOT NULL"),
    imageFilesPresent,
    pendingMedia: count("SELECT COUNT(*) count FROM warehouse_media_sync WHERE status='pending'"),
    syncedMedia: count("SELECT COUNT(*) count FROM warehouse_media_sync WHERE status='synced'"),
    loyaltyAccounts: count("SELECT COUNT(*) count FROM loyalty_accounts"),
    orders: count("SELECT COUNT(*) count FROM orders"),
    mediaFailures,
  }));
} else if (mode === "warehouse") {
  console.log(JSON.stringify({
    quickCheck: "ok",
    products: count("SELECT COUNT(*) count FROM products"),
    publishedProducts: count("SELECT COUNT(*) count FROM products WHERE status='published'"),
    variants: count("SELECT COUNT(*) count FROM product_variants"),
    publishedVariants: count("SELECT COUNT(*) count FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.status='published'"),
    publishedAssets: count("SELECT COUNT(*) count FROM product_assets a JOIN products p ON p.id=a.product_id WHERE p.status='published'"),
    syncPending: count("SELECT COUNT(*) count FROM order_sync_outbox WHERE status='pending'"),
    syncDelivered: count("SELECT COUNT(*) count FROM order_sync_outbox WHERE status='delivered'"),
    syncDead: count("SELECT COUNT(*) count FROM order_sync_outbox WHERE status='dead'"),
    inventoryOperations: count("SELECT COUNT(*) count FROM inventory_operations"),
  }));
} else {
  throw new Error("mode must be order or warehouse");
}

db.close();
