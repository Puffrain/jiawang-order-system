import fs from "node:fs";

const productionVolumes = new Set([
  "jiawang-commerce-new-order-data",
  "jiawang-commerce-new-warehouse-data",
  "jiawang-commerce-new-warehouse-media",
]);
const requiredVolumes = new Set(["order_data", "warehouse_data", "warehouse_media"]);
const requiredServices = new Set(["order-web", "order-media-worker", "warehouse-volume-init", "warehouse-web", "warehouse-worker", "gateway"]);

const raw = fs.readFileSync(0, "utf8");
const config = JSON.parse(raw);
if (!config || typeof config !== "object") throw new Error("preview Compose config is invalid");
for (const service of requiredServices) {
  if (!config.services?.[service]) throw new Error(`preview is missing service ${service}`);
}
for (const key of requiredVolumes) {
  const name = config.volumes?.[key]?.name;
  if (typeof name !== "string" || !/^jiawang-sync-preview-[a-z0-9][a-z0-9-]*-(?:order-data|warehouse-data|warehouse-media)$/.test(name)) {
    throw new Error(`preview volume ${key} is not isolated: ${String(name)}`);
  }
  if (productionVolumes.has(name)) throw new Error(`preview references production volume ${name}`);
}
for (const [serviceName, service] of Object.entries(config.services)) {
  for (const mount of service.volumes ?? []) {
    if (productionVolumes.has(mount.source)) throw new Error(`${serviceName} mounts production volume ${mount.source}`);
  }
}
for (const serviceName of ["order-web", "order-media-worker", "warehouse-volume-init", "warehouse-web", "warehouse-worker"]) {
  const service = config.services[serviceName];
  if (!service.image || service.build) throw new Error(`${serviceName} must use a prebuilt immutable candidate image`);
  if (!/(?:^sha256:|@sha256:)[a-f0-9]{64}$/.test(service.image)) throw new Error(`${serviceName} candidate image must use an immutable digest`);
}
process.stdout.write("isolated preview Compose safety: PASS\n");
