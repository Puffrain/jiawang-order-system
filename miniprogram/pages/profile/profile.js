const { request, assetUrl } = require('../../utils/request');
Page({
  data: { profile: {}, points: 0, avatarLetter: '佳', saving: false, loading: true, error: '', onboarding: false },
  onLoad(options) { this.setData({ onboarding: options && options.onboarding === '1' }); },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    Promise.all([request('/api/customers/profile'), request('/api/loyalty')]).then(([profileData, loyaltyData]) => {
      const profile = profileData.profile || {};
      if (profile.avatarUrl) profile.avatarUrl = assetUrl(profile.avatarUrl);
      this.setData({ profile, points: Number(loyaltyData.loyalty?.balance || 0) });
    }).catch(error => this.setData({ error: error.message || '资料加载失败' })).finally(() => this.setData({ loading: false }));
  },
  inputName(e) { this.setData({ 'profile.displayName': e.detail.value }); },
  inputShop(e) { this.setData({ 'profile.shopName': e.detail.value }); },
  inputType(e) { this.setData({ 'profile.businessType': e.detail.value }); },
  save() {
    if (this.data.saving) return;
    this.setData({ saving: true, error: '' });
    request('/api/customers/profile', { method: 'PATCH', data: { displayName: this.data.profile.displayName, shopName: this.data.profile.shopName, businessType: this.data.profile.businessType } })
      .then(({ profile }) => {
        const next = Object.assign({}, profile, { avatarUrl: assetUrl(profile?.avatarUrl) });
        this.setData({ profile: next });
        if (this.data.onboarding) {
          if (Number(next.addressCount || 0)) wx.reLaunch({ url: '/pages/home/home' });
          else wx.navigateTo({ url: '/pages/address/address?onboarding=1' });
        }
      })
      .catch(error => this.setData({ error: error.message || '资料保存失败' }))
      .finally(() => this.setData({ saving: false }));
  },
  chooseAvatar() {
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: ({ tempFilePaths }) => {
      const path = tempFilePaths && tempFilePaths[0]; if (!path) return;
      const app = getApp(); const token = app.globalData.sessionToken || wx.getStorageSync('sessionToken');
      wx.uploadFile({ url: app.globalData.apiBaseUrl + '/api/customers/profile/avatar', filePath: path, name: 'avatar', header: { Authorization: 'Bearer ' + token }, success: res => {
        try { const payload = JSON.parse(res.data || '{}'); if (res.statusCode >= 300) throw new Error(payload.error || '头像上传失败'); this.setData({ 'profile.avatarUrl': assetUrl(payload.avatarUrl) }); } catch (error) { this.setData({ error: error.message }); }
      }, fail: error => this.setData({ error: error.errMsg || '头像上传失败' }) });
    } });
  },
  logout() { const app = getApp(); ['sessionToken', 'sessionRole', 'sessionUserId'].forEach(k => wx.removeStorageSync(k)); app.globalData.sessionToken = ''; app.globalData.role = ''; app.globalData.userId = ''; wx.reLaunch({ url: '/pages/login/login' }); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openMessages() { wx.reLaunch({ url: '/pages/messages/messages' }); }, openOrders() { wx.reLaunch({ url: '/pages/orders/orders' }); }, openAddress() { wx.navigateTo({ url: '/pages/address/address' }); }, openPoints() { wx.navigateTo({ url: '/pages/points/points' }); }
});
