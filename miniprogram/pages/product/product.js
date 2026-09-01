const { request } = require('../../utils/request');
const { hydrateImages } = require('../../utils/product-image-cache');

Page({
  data: { product: null, selectedSku: null, quantity: 1, loading: true, error: '' },
  onLoad(options) { this.id = options.id; this.load(); },
  load() {
    request('/api/products/' + encodeURIComponent(this.id)).then(async ({ product }) => {
      if (!product) throw new Error('商品不存在或已下架');
      product.images = await hydrateImages(product.images);
      this.setData({ product, selectedSku: product.skus && product.skus[0] });
    }).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false }));
  },
  selectSku(event) { const sku = this.data.product.skus.find(item => item.id === event.currentTarget.dataset.id); this.setData({ selectedSku: sku, quantity: 1 }); },
  changeQuantity(event) { const next = Math.max(1, Math.min(Number(this.data.selectedSku.stock || 1), this.data.quantity + Number(event.currentTarget.dataset.step))); this.setData({ quantity: next }); },
  addToCart() {
    const sku = this.data.selectedSku;
    if (!sku) return;
    request('/api/cart', { method: 'POST', data: { skuId: sku.id, quantity: this.data.quantity } }).then(() => wx.showToast({ title: '已加入购物车', icon: 'success' })).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  openCart() { wx.navigateTo({ url: '/pages/cart/cart' }); }
});
