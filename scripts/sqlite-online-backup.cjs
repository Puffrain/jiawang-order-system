const Database = require("better-sqlite3");

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error("usage: node sqlite-online-backup.cjs <source> <destination>");
  process.exit(2);
}

async function main() {
  const db = new Database(source);
  const result = db.pragma("quick_check", { simple: true });
  if (result !== "ok") throw new Error(`SQLite quick_check failed: ${result}`);
  await db.backup(destination);
  db.close();
  console.log("ok");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
