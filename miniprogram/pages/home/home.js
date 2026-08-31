const { request, assetUrl } = require('../../utils/request');

Page({
  data: { products: [], loading: true, error: '' },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true });
    request('/api/products').then(({ products = [] }) => this.setData({ products: products.map(item => Object.assign(item, { imageUrl: assetUrl(item.primaryImage && item.primaryImage.url) })) })).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false }));
  },
  openProduct(event) { wx.navigateTo({ url: '/pages/product/product?id=' + event.currentTarget.dataset.id }); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); },
  openCart() { wx.navigateTo({ url: '/pages/cart/cart' }); },
  openOrders() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  openAddress() { wx.navigateTo({ url: '/pages/address/address' }); }
});
