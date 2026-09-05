const { request } = require('../../utils/request');

Page({
  data: { addresses: [], checkout: false, remark: '', loading: true, onboarding: false },
  onLoad(options) { let remark = ''; try { remark = decodeURIComponent(options.remark || ''); } catch { remark = options.remark || ''; } this.setData({ checkout: options.checkout === '1', remark, onboarding: options.onboarding === '1' }); },
  onShow() { this.load(); },
  load() { request('/api/addresses').then(({ addresses = [] }) => this.setData({ addresses })).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  choose(event) {
    if (!this.data.checkout || this.data.submitting) return;
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', data: { addressId: event.currentTarget.dataset.id, remark: this.data.remark, idempotencyKey: 'mini-' + Date.now() } }).then(() => { wx.showToast({ title: '订单已提交', icon: 'success' }); setTimeout(() => wx.redirectTo({ url: '/pages/orders/orders' }), 500); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ submitting: false }));
  },
  addAddress() {
    wx.chooseAddress({ success: address => request('/api/addresses', { method: 'POST', data: { recipientName: address.userName, phone: address.telNumber, province: address.provinceName, city: address.cityName, district: address.countyName, detail: address.detailInfo, isDefault: true } }).then(() => { if (this.data.onboarding) wx.reLaunch({ url: '/pages/home/home' }); else this.load(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })), fail: () => wx.showToast({ title: '未能读取微信地址', icon: 'none' }) });
  },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openMessages() { wx.reLaunch({ url: '/pages/messages/messages' }); }, openOrders() { wx.reLaunch({ url: '/pages/orders/orders' }); }
});
