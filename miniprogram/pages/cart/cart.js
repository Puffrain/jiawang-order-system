const { request, assetUrl } = require('../../utils/request');

Page({
  data: { items: [], invalidItems: [], loading: true, submitting: false, remark: '' },
  onShow() { this.load(); },
  load() { request('/api/cart').then(({ items = [], invalidItems = [] }) => this.setData({ items, invalidItems, total: items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0).toFixed(2) })).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  inputRemark(event) { this.setData({ remark: event.detail.value }); },
  changeQuantity(event) { const item = event.currentTarget.dataset.item; const quantity = Math.max(1, item.quantity + Number(event.currentTarget.dataset.step)); request('/api/cart', { method: 'POST', data: { skuId: item.skuId, quantity } }).then(() => this.load()).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  remove(event) { request('/api/cart?skuId=' + encodeURIComponent(event.currentTarget.dataset.id), { method: 'DELETE' }).then(() => this.load()).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  checkout() {
    if (!this.data.items.length || this.data.submitting) return;
    wx.navigateTo({ url: '/pages/address/address?checkout=1&remark=' + encodeURIComponent(this.data.remark || '') });
  },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); },
  openMessages() { wx.reLaunch({ url: '/pages/messages/messages' }); },
  openOrders() { wx.reLaunch({ url: '/pages/orders/orders' }); },
  openAddress() { wx.reLaunch({ url: '/pages/address/address' }); }
});
