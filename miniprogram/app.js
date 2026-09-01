const config = require('./utils/config');

App({
  globalData: { apiBaseUrl: config.apiBaseUrl, sessionToken: '', role: '', userId: '' },
  onLaunch() {
    this.globalData.sessionToken = wx.getStorageSync('sessionToken') || '';
    this.globalData.role = wx.getStorageSync('sessionRole') || '';
    this.globalData.userId = wx.getStorageSync('sessionUserId') || '';
  }
});
