import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'project.config.json', 'app.json', 'app.js', 'app.wxss', 'sitemap.json',
  'utils/config.js', 'utils/request.js',
  'pages/login/login.js', 'pages/home/home.js', 'pages/product/product.js',
  'pages/cart/cart.js', 'pages/address/address.js', 'pages/orders/orders.js'
];
required.push('pages/courier-login/courier-login.js','pages/courier-orders/courier-orders.js');
for (const file of required) if (!fs.existsSync(path.join(root, 'miniprogram', file))) throw new Error(`missing ${file}`);
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['.js', '.wxml']) if (!fs.existsSync(path.join(root, 'miniprogram', `${page}${ext}`))) throw new Error(`missing page asset ${page}${ext}`);
const config = fs.readFileSync(path.join(root, 'miniprogram/utils/config.js'), 'utf8');
if (!config.includes('apiBaseUrl')) throw new Error('apiBaseUrl missing');
if (!/apiBaseUrl:\s*['"]https:\/\/[^'"]+['"]/.test(config)) throw new Error('apiBaseUrl must be an explicit HTTPS origin');
if (!config.includes('kunshanjiawang.cn')) throw new Error('apiBaseUrl must match the configured production origin');
const login = fs.readFileSync(path.join(root, 'app/api/auth/wechat/login/route.ts'), 'utf8');
for (const marker of ['WECHAT_MINI_APPID', 'WECHAT_MINI_SECRET', 'sessionToken', 'jscode2session']) if (!login.includes(marker)) throw new Error(`wechat login marker missing: ${marker}`);
const proxy = fs.readFileSync(path.join(root, 'proxy.ts'), 'utf8');
for (const marker of ['authorization', 'hs_session', 'sec-fetch-site']) if (!proxy.includes(marker)) throw new Error(`bearer security marker missing: ${marker}`);
const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
for (const marker of ['WECHAT_MINI_APPID', 'WECHAT_MINI_SECRET']) if (!compose.includes(marker)) throw new Error(`production compose missing ${marker}`);
for (const file of required.map(item => path.join(root, 'miniprogram', item))) {
  const text = fs.readFileSync(file, 'utf8');
  if (/WECHAT_MINI_SECRET|appid.{0,20}secret/i.test(text)) throw new Error(`secret-like content in ${file}`);
}
const courierLogin = fs.readFileSync(path.join(root, 'app/api/auth/courier/login/route.ts'), 'utf8');
if (!courierLogin.includes('sessionToken')) throw new Error('courier login must return a session token');
const courierPage = fs.readFileSync(path.join(root, 'miniprogram/pages/courier-orders/courier-orders.js'), 'utf8');
for (const marker of ['/api/courier/orders', "action === 'deliver'", "action === 'fail'"]) if (!courierPage.includes(marker)) throw new Error('courier page contract missing ' + marker);
if (/courierFailReason|courierSigner/.test(courierPage)) throw new Error('courier proof must be entered through a modal');
console.log('miniprogram contract: required assets, API contract, and secret boundaries verified');
