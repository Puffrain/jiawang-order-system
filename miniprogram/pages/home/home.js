const { request } = require('../../utils/request');
const { hydrateProductImages } = require('../../utils/product-image-cache');

function noticeSummary(notice) {
  const blocks = notice && notice.document && Array.isArray(notice.document.blocks) ? notice.document.blocks : [];
  return blocks.map((block) => {
    if (Array.isArray(block.items)) return block.items.join(' ');
    return typeof block.text === 'string' ? block.text : '';
  }).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function lowestPrice(product) {
  const prices = (product.skus || []).map((sku) => Number(sku.basePrice)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : 0;
}

function buildCategories(products) {
  const seen = new Set();
  const categories = [{ key: 'all', name: '全部商品' }];
  (products || []).forEach((product) => {
    const key = product.categoryKey || product.category || 'other';
    if (seen.has(key)) return;
    seen.add(key);
    categories.push({ key, name: product.category || '其他' });
  });
  return categories;
}

Page({
  data: {
    allProducts: [],
    visibleProducts: [],
    categories: [{ key: 'all', name: '全部商品' }],
    activeCategory: 'all',
    keyword: '',
    sort: 'recommend',
    notice: null,
    loading: true,
    error: ''
  },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    Promise.allSettled([request('/api/products'), request('/api/notices')])
      .then(async ([productsResult, noticesResult]) => {
        if (productsResult.status !== 'fulfilled') throw productsResult.reason;
        const { products = [] } = productsResult.value;
        const notices = noticesResult.status === 'fulfilled' ? noticesResult.value.notices || [] : [];
        const notice = notices[0] || null;
        const hydratedProducts = await hydrateProductImages(products);
        this.setData({
          allProducts: hydratedProducts,
          categories: buildCategories(hydratedProducts),
          notice: notice ? Object.assign({}, notice, { summary: noticeSummary(notice) }) : null
        });
        this.applyFilters();
      })
      .catch(error => this.setData({ error: error.message }))
      .finally(() => this.setData({ loading: false }));
  },
  applyFilters() {
    const keyword = String(this.data.keyword || '').trim().toLowerCase();
    const category = this.data.activeCategory;
    const sort = this.data.sort;
    const visibleProducts = this.data.allProducts
      .filter((product) => {
        const matchesCategory = category === 'all' || (product.categoryKey || product.category) === category;
        const searchable = [product.name, product.brand, ...(product.skus || []).map((sku) => sku.skuCode)].join(' ').toLowerCase();
        return matchesCategory && (!keyword || searchable.includes(keyword));
      })
      .map((product, index) => Object.assign({}, product, { lowestPrice: lowestPrice(product), originalIndex: index }))
      .sort((left, right) => {
        if (sort === 'sales') return Number(right.salesCount || 0) - Number(left.salesCount || 0) || left.originalIndex - right.originalIndex;
        if (sort === 'price') return left.lowestPrice - right.lowestPrice || left.originalIndex - right.originalIndex;
        return left.originalIndex - right.originalIndex;
      });
    this.setData({ visibleProducts });
  },
  search(event) { this.setData({ keyword: event.detail.value || '' }); this.applyFilters(); },
  selectCategory(event) { this.setData({ activeCategory: event.currentTarget.dataset.key }); this.applyFilters(); },
  selectSort(event) { this.setData({ sort: event.currentTarget.dataset.sort }); this.applyFilters(); },
  addToCart(event) {
    const product = this.data.allProducts.find((item) => item.id === event.currentTarget.dataset.id);
    const sku = product && product.skus && product.skus[0];
    if (!sku) return wx.showToast({ title: '该商品暂无可购买规格', icon: 'none' });
    request('/api/cart', { method: 'POST', data: { skuId: sku.id, quantity: 1 } })
      .then(() => wx.showToast({ title: '已加入购物车', icon: 'success' }))
      .catch((error) => wx.showToast({ title: error.message || '加入购物车失败', icon: 'none' }));
  },
  openProduct(event) { wx.navigateTo({ url: '/pages/product/product?id=' + event.currentTarget.dataset.id }); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); },
  openCart() { wx.navigateTo({ url: '/pages/cart/cart' }); },
  openMessages() { wx.navigateTo({ url: '/pages/messages/messages' }); },
  openOrders() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  openAddress() { wx.navigateTo({ url: '/pages/address/address' }); }
});
