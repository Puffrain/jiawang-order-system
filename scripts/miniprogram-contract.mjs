import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'project.config.json', 'app.json', 'app.js', 'app.wxss', 'sitemap.json',
  'utils/config.js', 'utils/request.js',
  'pages/login/login.js', 'pages/home/home.js', 'pages/product/product.js',
  'pages/cart/cart.js', 'pages/messages/messages.js', 'pages/address/address.js', 'pages/orders/orders.js'
];
required.push('pages/courier-login/courier-login.js','pages/courier-orders/courier-orders.js');
required.push('utils/product-image-cache.js');
for (const file of required) if (!fs.existsSync(path.join(root, 'miniprogram', file))) throw new Error(`missing ${file}`);
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
if (!app.pages.includes('pages/messages/messages')) throw new Error('messages page must be registered');
for (const page of app.pages) for (const ext of ['.js', '.wxml']) if (!fs.existsSync(path.join(root, 'miniprogram', `${page}${ext}`))) throw new Error(`missing page asset ${page}${ext}`);
const config = fs.readFileSync(path.join(root, 'miniprogram/utils/config.js'), 'utf8');
if (!config.includes('apiBaseUrl')) throw new Error('apiBaseUrl missing');
if (!/apiBaseUrl:\s*['"]https:\/\/[^'"]+['"]/.test(config)) throw new Error('apiBaseUrl must be an explicit HTTPS origin');
if (!config.includes('kunshanjiawang.cn')) throw new Error('apiBaseUrl must match the configured production origin');
const appStyles = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');
const loginStyles = fs.readFileSync(path.join(root, 'miniprogram/pages/login/login.wxss'), 'utf8');
if (!/button\s*\{[^}]*font-size:\s*28rpx/.test(appStyles)) throw new Error('global mini-program buttons must use the compact brand font size');
for (const marker of ['.login-button { margin-top: 40rpx; height: 88rpx; font-size: 30rpx;', '.courier-entry { margin-top: 16rpx; height: 78rpx; font-size: 28rpx;', '.error { margin-top: 20rpx; padding: 18rpx; border-radius: 10rpx; background: #fff0ed; color: #c43d2e; font-size: 26rpx;']) if (!loginStyles.includes(marker)) throw new Error('login screen typography contract missing: ' + marker);
for (const marker of ['.login-button, .courier-entry { display: flex;', 'align-items: center;', 'justify-content: center;', 'padding: 0;']) if (!loginStyles.includes(marker)) throw new Error('login buttons must keep their labels centered: ' + marker);
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
const ordersPage = fs.readFileSync(path.join(root, 'miniprogram/pages/orders/orders.js'), 'utf8');
const ordersView = fs.readFileSync(path.join(root, 'miniprogram/pages/orders/orders.wxml'), 'utf8');
for (const marker of ["paymentAvailable: false", "/api/payments/capabilities", "capabilities.wechat && capabilities.wechat.available"]) if (!ordersPage.includes(marker)) throw new Error('payment availability contract missing ' + marker);
if (!ordersView.includes("paymentAvailable && item.status === 'pending_payment'")) throw new Error('payment button must be server-capability gated');
const homePage = fs.readFileSync(path.join(root, 'miniprogram/pages/home/home.js'), 'utf8');
const homeView = fs.readFileSync(path.join(root, 'miniprogram/pages/home/home.wxml'), 'utf8');
const productImages = fs.readFileSync(path.join(root, 'miniprogram/utils/product-image-cache.js'), 'utf8');
for (const marker of ["request('/api/notices')", 'Promise.allSettled', 'hydrateProductImages', 'noticeSummary', 'buildCategories', 'applyFilters', 'salesCount', '/api/cart']) if (!homePage.includes(marker)) throw new Error('home notice, catalog, or image hydration contract missing ' + marker);
for (const marker of ['wx.downloadFile', "Authorization: 'Bearer ' + sessionToken"]) if (!productImages.includes(marker)) throw new Error('authenticated product image contract missing ' + marker);
for (const marker of ['placeholder="搜索商品、品牌或规格"', 'category-list', 'product-list', 'data-sort="sales"', 'catchtap="addToCart"']) if (!homeView.includes(marker)) throw new Error('home catalog view contract missing ' + marker);
for (const forbidden of ['quick-actions', '在线选品，下单后由商家审核报价', 'product-grid']) if (homeView.includes(forbidden)) throw new Error('duplicate home shortcut, static notice, or legacy product grid remains');
const productView = fs.readFileSync(path.join(root, 'miniprogram/pages/product/product.wxml'), 'utf8');
if (!productView.includes('gallery-placeholder') || productView.includes('brand-banner.jpg')) throw new Error('product gallery must use product images or a neutral placeholder');
const messagesPage = fs.readFileSync(path.join(root, 'miniprogram/pages/messages/messages.js'), 'utf8');
const messagesView = fs.readFileSync(path.join(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
const messagesStyles = fs.readFileSync(path.join(root, 'miniprogram/pages/messages/messages.wxss'), 'utf8');
for (const marker of ['/api/auth/me', '/api/chat/messages', 'clientMessageId', 'setInterval', 'clearInterval']) if (!messagesPage.includes(marker)) throw new Error('messages page contract missing ' + marker);
for (const marker of ['scroll-into-view', 'bindconfirm="sendMessage"', 'message-row', 'openOrders']) if (!messagesView.includes(marker)) throw new Error('messages view contract missing ' + marker);
for (const marker of ['.send-button { flex: 0 0 112rpx; display: flex;', 'align-items: center;', 'justify-content: center;', 'padding: 0;']) if (!messagesStyles.includes(marker)) throw new Error('message send button must keep its label centered: ' + marker);
const homeStyles = fs.readFileSync(path.join(root, 'miniprogram/pages/home/home.wxss'), 'utf8');
for (const marker of ['flex: 0 0 52rpx', 'width: 52rpx', 'height: 52rpx']) if (!homeStyles.includes(marker)) throw new Error('home add-to-cart button must remain a fixed circle');
for (const page of ['home', 'cart', 'orders', 'address']) {
  const script = fs.readFileSync(path.join(root, 'miniprogram/pages', page, `${page}.js`), 'utf8');
  const view = fs.readFileSync(path.join(root, 'miniprogram/pages', page, `${page}.wxml`), 'utf8');
  if (!script.includes('openMessages') || !view.includes('消息')) throw new Error(`${page} navigation must link to messages`);
}
for (const page of ['cart', 'orders', 'address']) {
  const view = fs.readFileSync(path.join(root, 'miniprogram/pages', page, `${page}.wxml`), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages', page, `${page}.wxss`), 'utf8');
  if (!view.includes('scroll-view') || !styles.includes('height: 100vh') || /position:\s*sticky/.test(styles)) throw new Error(`${page} must keep its bottom navigation outside a scrollable content area`);
}
console.log('miniprogram contract: required assets, API contract, and secret boundaries verified');
