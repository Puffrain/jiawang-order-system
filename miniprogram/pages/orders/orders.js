const { request } = require('../../utils/request');

Page({
  data: { orders: [], visibleOrders: [], filter: 'all', filters: [{ key: 'all', label: '全部' }, { key: 'pending', label: '待处理' }, { key: 'delivery', label: '配送中' }, { key: 'done', label: '已完成' }], loading: true, paymentAvailable: false, payingId: '' },
  onShow() {
    if (this.data.reviewOrderId) this.loadReviewItems(this.data.reviewOrderId);
    this.setData({ loading: true, error: '' });
    request('/api/customers/profile').then(({ profile }) => {
      if (profile && !profile.profileCompleted) {
        wx.reLaunch({ url: '/pages/profile/profile?onboarding=1' });
        return;
      }
      return Promise.all([request('/api/orders'), request('/api/payments/capabilities').catch(() => ({ wechat: { available: false } }))]).then(([payload, capabilities]) => { const normalized = (payload.orders || []).map(item => Object.assign({}, item, this.statusPresentation(item))); this.setData({ orders: normalized, paymentAvailable: Boolean(capabilities.wechat && capabilities.wechat.available) }); this.applyFilter(normalized, this.data.filter); });
    }).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false }));
  },
  statusPresentation(item) {
    if (item.status === 'cancelled') return { statusLabel: '已取消', statusTone: 'danger' };
    if (item.status === 'closed') return { statusLabel: '已完成', statusTone: 'success' };
    if (item.confirmationStatus === 'buyer_review') return { statusLabel: '待确认', statusTone: 'warning' };
    if (item.fulfillmentStatus === 'out_for_delivery') return { statusLabel: '配送中', statusTone: 'info' };
    if (item.fulfillmentStatus === 'delivered' && item.status !== 'closed') return { statusLabel: '已送达', statusTone: 'success' };
    if (item.status === 'cancelled') return { statusLabel: '已取消', statusTone: 'danger' };
    if (item.status === 'closed') return { statusLabel: '已完成', statusTone: 'success' };
    if (item.status === 'pending_review') return { statusLabel: '待商家审核', statusTone: 'warning' };
    if (item.status === 'pending_payment') return { statusLabel: '待付款', statusTone: 'warning' };
    return { statusLabel: item.status || '处理中', statusTone: 'info' };
  },
  applyFilter(orders, filter) { const visibleOrders = orders.filter(item => filter === 'all' || filter === 'pending' && ['pending_review', 'pending_payment', 'pending_shipment'].includes(item.status) || filter === 'delivery' && ['assigned', 'out_for_delivery', 'shipped'].includes(item.fulfillmentStatus) || filter === 'done' && ['delivered', 'closed', 'cancelled'].includes(item.status) || filter === 'done' && item.fulfillmentStatus === 'delivered'); this.setData({ visibleOrders }); },
  openReviews(event) { this.loadReviewItems(event.currentTarget.dataset.id); },
  selectReviewOrder() {
    const orders = (this.data.orders || []).filter(order => order.status === 'closed' && order.paymentStatus === 'paid');
    if (!orders.length) return wx.showToast({ title: '暂无已付款的完成订单', icon: 'none' });
    this.setData({ reviewPicker: true, reviewOrders: orders });
  },
  closeReviewPicker() { this.setData({ reviewPicker: false }); },
  async loadReviewItems(id) {
    const sequence = (this.reviewSequence || 0) + 1;
    this.reviewSequence = sequence;
    this.setData({ reviewOrderId: id, reviewItems: [], reviewLoading: true, reviewError: '' });
    try {
      const { order } = await request('/api/orders/' + encodeURIComponent(id));
      if (sequence === this.reviewSequence) this.setData({ reviewItems: order.items || [] });
    } catch (error) {
      if (sequence === this.reviewSequence) this.setData({ reviewError: error.message || '商品读取失败' });
    } finally {
      if (sequence === this.reviewSequence) this.setData({ reviewLoading: false });
    }
  },
  retryReviews() { this.loadReviewItems(this.data.reviewOrderId); },
  closeReviews() { this.reviewSequence = (this.reviewSequence || 0) + 1; this.setData({ reviewOrderId: '', reviewItems: [] }); },
  writeReview(event) {
    const item = (this.data.reviewItems || []).find(value => value.id === event.currentTarget.dataset.id);
    if (!item || !item.canReview || item.reviewId) return;
    wx.navigateTo({ url: '/pages/review/review?orderId=' + encodeURIComponent(this.data.reviewOrderId) + '&orderItemId=' + encodeURIComponent(item.id) + '&productName=' + encodeURIComponent(item.productName) });
  },
  changeFilter(event) { const filter = event.currentTarget.dataset.key; this.setData({ filter }); this.applyFilter(this.data.orders, filter); },
  action(event) { const { id, action } = event.currentTarget.dataset; if (action === 'pay') return this.pay(id); const paths = { confirm: '/api/orders/' + id + '/buyer-confirm', cancel: '/api/orders/' + id + '/cancel', withdraw: '/api/orders/' + id + '/withdraw', receive: '/api/orders/' + id + '/receive', hide: '/api/orders/' + id + '/hide' }; const order = this.data.orders.find(item => item.id === id); const data = action === 'confirm' ? { version: order && order.orderVersion } : {}; request(paths[action], { method: 'POST', data }).then(() => { wx.showToast({ title: '操作成功', icon: 'success' }); this.onShow(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  pay(id) { if (this.data.payingId) return; this.setData({ payingId: id }); request('/api/orders/' + id + '/payment-intent', { method: 'POST' }).then(params => new Promise((resolve, reject) => { wx.requestPayment({ timeStamp: params.timeStamp, nonceStr: params.nonceStr, package: params.package, signType: params.signType, paySign: params.paySign, success: resolve, fail: reject }); })).catch(error => wx.showToast({ title: error.message || '支付未完成', icon: 'none' })).then(() => request('/api/orders/' + id + '/payment-status').catch(() => null)).then(() => this.onShow()).finally(() => this.setData({ payingId: '' })); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openMessages() { wx.reLaunch({ url: '/pages/messages/messages' }); }, openAddress() { wx.reLaunch({ url: '/pages/address/address' }); }, openProfile() { wx.reLaunch({ url: '/pages/profile/profile' }); }
});
