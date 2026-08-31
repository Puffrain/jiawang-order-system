const { request } = require('../../utils/request');

Page({
  data: { loading: false, error: '' },
  login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    wx.login({
      success: ({ code }) => {
        request('/api/auth/wechat/login', { method: 'POST', data: { code } }).then((payload) => {
          const token = payload.sessionToken || '';
          if (!token) throw new Error('登录凭证未返回，请联系管理员');
          getApp().globalData.sessionToken = token;
          getApp().globalData.role = payload.role || 'buyer';
          wx.setStorageSync('sessionToken', token);
          wx.setStorageSync('sessionRole', payload.role || 'buyer');
          wx.reLaunch({ url: '/pages/home/home' });
        }).catch((error) => this.setData({ error: error.message })).finally(() => this.setData({ loading: false }));
      },
      fail: () => { this.setData({ error: '无法获取微信登录凭证' }); this.setData({ loading: false }); }
    });
  },
  courierLogin() { wx.navigateTo({ url: '/pages/courier-login/courier-login' }); }
});
