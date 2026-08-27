import fs from "node:fs/promises";
import path from "node:path";
import db from "@/lib/db";
import { uploadRoot } from "@/lib/product-catalog";

export async function retryProductFileCleanup(limit = 20, unlink: typeof fs.unlink = fs.unlink) {
  const rows = db.prepare("SELECT storage_key storageKey FROM product_file_cleanup ORDER BY updated_at LIMIT ?").all(limit) as Array<{ storageKey: string }>;
  for (const row of rows) {
    try {
      const stillReferenced = db.prepare("SELECT 1 FROM product_images WHERE storage_key=? LIMIT 1").get(row.storageKey);
      if (stillReferenced) {
        db.prepare("DELETE FROM product_file_cleanup WHERE storage_key=?").run(row.storageKey);
        continue;
      }
      await unlink(path.join(uploadRoot,row.storageKey)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      db.prepare("DELETE FROM product_file_cleanup WHERE storage_key=?").run(row.storageKey);
    } catch (error) {
      db.prepare("UPDATE product_file_cleanup SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE storage_key=?").run(error instanceof Error ? error.message.slice(0,300) : "unlink_failed",row.storageKey);
    }
  }
}
