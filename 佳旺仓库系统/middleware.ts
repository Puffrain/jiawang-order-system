// Next 15 uses the `middleware.ts` convention (the `proxy.ts` convention is
// recognized by newer Next releases). Keep the implementation in proxy.ts so
// both development and the Docker build apply the same origin and security
// header checks.
export { default, proxy, config } from './proxy';
