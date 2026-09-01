const app = getApp();
const cache = new Map();

function absoluteUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const baseUrl = String(app.globalData.apiBaseUrl || '').replace(/\/$/, '');
  return baseUrl ? baseUrl + path : '';
}

function token() {
  return app.globalData.sessionToken || wx.getStorageSync('sessionToken') || '';
}

function downloadProductImage(path) {
  const url = absoluteUrl(path);
  const sessionToken = token();
  if (!url || !sessionToken) return Promise.resolve('');

  const key = sessionToken + ':' + url;
  if (cache.has(key)) return cache.get(key);

  const pending = new Promise((resolve) => {
    wx.downloadFile({
      url,
      header: { Authorization: 'Bearer ' + sessionToken },
      timeout: 15000,
      success(result) {
        resolve(result.statusCode >= 200 && result.statusCode < 300 ? result.tempFilePath : '');
      },
      fail() { resolve(''); }
    });
  });
  cache.set(key, pending);
  return pending;
}

function hydrateProductImages(products) {
  return Promise.all((products || []).map(async (product) => Object.assign({}, product, {
    imageUrl: await downloadProductImage(product.primaryImage && product.primaryImage.url)
  })));
}

function hydrateImages(images) {
  return Promise.all((images || []).map(async (image) => Object.assign({}, image, {
    imageUrl: await downloadProductImage(image.url)
  })));
}

module.exports = { downloadProductImage, hydrateProductImages, hydrateImages };
