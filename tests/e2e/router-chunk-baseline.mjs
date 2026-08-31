import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const routes = ["/", "/admin", "/buyer", "/customer-entry", "/diagnostics/buttons", "/admin/login", "/buyer/login"];
const publicBrandAsset = new URL("/brand/portrait.jpg", baseUrl);
const brandResponse = await fetch(publicBrandAsset, { redirect: "manual" });
assert.equal(brandResponse.status, 200, "public brand asset must not be redirected to login");
assert.match(brandResponse.headers.get("content-type") || "", /^image\//, "public brand asset must return image content");
const failures = [];

async function checkRoute(path) {
  const chain = [];
  let current = new URL(path, baseUrl);
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(current, { redirect: "manual", headers: { "Cache-Control": "no-cache" } });
    chain.push({ url: current.toString(), status: response.status, location: response.headers.get("location") });
    if (response.status < 300 || response.status >= 400) {
      assert.equal(response.status, 200, `${path} ended with ${response.status}: ${JSON.stringify(chain)}`);
      const html = await response.text();
      const chunks = [...html.matchAll(/(?:src|href)="([^"?]*\/_next\/static\/[^"?]+)(?:\?[^"}]*)?"/g)].map(match => new URL(match[1], current).toString());
      for (const chunk of new Set(chunks)) {
        const asset = await fetch(chunk, { cache: "no-store" });
        if (!asset.ok) throw new Error(`${path} referenced unavailable asset ${chunk} (${asset.status})`);
        const type = asset.headers.get("content-type") || "";
        if (!/(javascript|css|font|image)/i.test(type)) throw new Error(`${chunk} returned unexpected content-type ${type}`);
      }
      return { path, chain, chunks: chunks.length };
    }
    const location = response.headers.get("location");
    assert.ok(location, `${path} returned ${response.status} without Location`);
    current = new URL(location, current);
  }
  throw new Error(`${path} redirect chain exceeded limit: ${JSON.stringify(chain)}`);
}

for (const path of routes) {
  try {
    const result = await checkRoute(path);
    console.log(`✓ ${path} -> ${result.chain.map(item => item.status).join(" -> ")} (${result.chunks} assets)`);
  } catch (error) {
    failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    console.error(`✗ ${path}: ${failures.at(-1).error}`);
  }
}

const staleChunk = process.env.STALE_CHUNK_URL;
if (staleChunk) {
  const response = await fetch(new URL(staleChunk, baseUrl), { cache: "no-store" });
  console.log(`ℹ stale chunk probe ${staleChunk}: ${response.status} ${response.headers.get("content-type") || ""}`);
}

if (failures.length) {
  console.error(JSON.stringify({ baseUrl, failures }, null, 2));
  process.exitCode = 1;
}
