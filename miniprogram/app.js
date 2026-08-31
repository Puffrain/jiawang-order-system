const config = require('./utils/config');

App({
  globalData: { apiBaseUrl: config.apiBaseUrl, sessionToken: '', role: '' },
  onLaunch() {
    this.globalData.sessionToken = wx.getStorageSync('sessionToken') || '';
    this.globalData.role = wx.getStorageSync('sessionRole') || '';
  }
});
