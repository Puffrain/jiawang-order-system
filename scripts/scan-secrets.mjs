#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".next", ".task-backups", ".task-runs", "node_modules", "uploads", "data", "backups", "coverage", "test-results", "playwright-report"]);
const ignoredExtensions = new Set([".ico", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".db", ".sqlite", ".sqlite3", ".jwbackup", ".lock", ".tsbuildinfo"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Alibaba Cloud access key", /LTAI[0-9A-Za-z]{12,}/],
  ["GitHub token", /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["OpenAI-style key", /sk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
];

const findings = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!entry.isFile() || ignoredExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (relative === 'server.env') continue;
    if (/(^|\/)\.env(?:$|\.)/.test(relative) && !relative.endsWith('/.env.example') && relative !== '.env.example') {
      findings.push(`${relative}: environment file must not be committed`);
      continue;
    }
    const text = fs.readFileSync(absolute, "utf8");
    for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${relative}: ${label}`);
  }
}
walk(root);
if (findings.length) {
  console.error("secret scan failed");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
process.stdout.write("secret scan: PASS\n");
