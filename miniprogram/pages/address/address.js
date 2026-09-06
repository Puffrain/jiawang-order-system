const { request } = require('../../utils/request');

Page({
  data: {
    addresses: [], checkout: false, remark: '', loading: true, onboarding: false,
    manualOpen: false, saving: false,
    manual: { recipientName: '', phone: '', province: '', city: '', district: '', detail: '', isDefault: true }
  },
  onLoad(options) { let remark = ''; try { remark = decodeURIComponent(options.remark || ''); } catch { remark = options.remark || ''; } this.setData({ checkout: options.checkout === '1', remark, onboarding: options.onboarding === '1' }); },
  onShow() { this.load(); },
  load() { this.setData({ loading: true, error: '' }); request('/api/addresses').then(({ addresses = [] }) => this.setData({ addresses })).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  choose(event) {
    if (!this.data.checkout || this.data.submitting) return;
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', data: { addressId: event.currentTarget.dataset.id, remark: this.data.remark, idempotencyKey: 'mini-' + Date.now() } }).then(() => { wx.showToast({ title: '订单已提交', icon: 'success' }); setTimeout(() => wx.redirectTo({ url: '/pages/orders/orders' }), 500); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ submitting: false }));
  },
  addAddress() {
    wx.chooseAddress({ success: address => request('/api/addresses', { method: 'POST', data: { recipientName: address.userName, phone: address.telNumber, province: address.provinceName, city: address.cityName, district: address.countyName, detail: address.detailInfo, isDefault: true } }).then(() => { if (this.data.onboarding) wx.reLaunch({ url: '/pages/home/home' }); else this.load(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })), fail: () => wx.showToast({ title: '未能读取微信地址', icon: 'none' }) });
  },
  openManual() {
    this.setData({ manualOpen: true, formError: '', manual: { recipientName: '', phone: '', province: '', city: '', district: '', detail: '', isDefault: this.data.addresses.length === 0 } });
  },
  closeManual() { if (!this.data.saving) this.setData({ manualOpen: false, formError: '' }); },
  noop() {},
  updateManual(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['manual.' + field]: event.detail.value, formError: '' });
  },
  toggleDefault(event) { this.setData({ 'manual.isDefault': Boolean(event.detail.value.length) }); },
  async saveManual() {
    if (this.data.saving) return;
    const data = this.data.manual;
    if (!data.recipientName.trim() || !/^1\d{10}$/.test(data.phone.trim()) || !data.province.trim() || !data.city.trim() || !data.district.trim() || !data.detail.trim()) {
      this.setData({ formError: '请完整填写收货信息，并检查手机号' });
      return;
    }
    this.setData({ saving: true, formError: '' });
    try {
      await request('/api/addresses', { method: 'POST', data });
      wx.showToast({ title: '地址已保存', icon: 'success' });
      if (this.data.onboarding) wx.reLaunch({ url: '/pages/home/home' });
      else { this.setData({ manualOpen: false }); this.load(); }
    } catch (error) { this.setData({ formError: error.message || '地址保存失败，请重试' }); }
    finally { this.setData({ saving: false }); }
  },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openMessages() { wx.reLaunch({ url: '/pages/messages/messages' }); }, openOrders() { wx.reLaunch({ url: '/pages/orders/orders' }); }
});
