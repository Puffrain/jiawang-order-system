const app = getApp();

function apiBaseUrl() {
  const baseUrl = String(app.globalData.apiBaseUrl || '').replace(/\/$/, '');
  if (!/^https:\/\/[^\s/]+/i.test(baseUrl)) throw new Error('小程序服务地址未配置');
  return baseUrl;
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    let baseUrl;
    try { baseUrl = apiBaseUrl(); } catch (error) { reject(error); return; }
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.header || {});
    const token = app.globalData.sessionToken || wx.getStorageSync('sessionToken');
    if (token) headers.Authorization = 'Bearer ' + token;
    wx.request({
      url: baseUrl + path,
      method: options.method || 'GET',
      data: options.data,
      header: headers,
      timeout: 15000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401) {
          wx.removeStorageSync('sessionToken');
          wx.removeStorageSync('sessionRole');
          app.globalData.sessionToken = '';
          app.globalData.role = '';
          wx.reLaunch({ url: '/pages/login/login' });
        }
        reject(new Error((res.data && res.data.error) || '请求失败'));
      },
      fail: (error) => reject(new Error(error?.errMsg || '网络请求失败，请检查小程序合法域名配置'))
    });
  });
}

function assetUrl(path) {
  if (!path) return '';
  if (/^https?:/.test(path)) return path;
  return apiBaseUrl() + path;
}

module.exports = { request, assetUrl };
