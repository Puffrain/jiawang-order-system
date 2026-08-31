const { request } = require('../../utils/request');

Page({
  data: { orders: [], visibleOrders: [], filter: 'all', filters: [{ key: 'all', label: '全部' }, { key: 'pending', label: '待处理' }, { key: 'delivery', label: '配送中' }, { key: 'done', label: '已完成' }], loading: true },
  onShow() { request('/api/orders').then(({ orders = [] }) => { const normalized = orders.map(item => Object.assign({}, item, this.statusPresentation(item))); this.setData({ orders: normalized }); this.applyFilter(normalized, this.data.filter); }).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  statusPresentation(item) {
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
  changeFilter(event) { const filter = event.currentTarget.dataset.key; this.setData({ filter }); this.applyFilter(this.data.orders, filter); },
  action(event) { const { id, action } = event.currentTarget.dataset; const paths = { confirm: '/api/orders/' + id + '/buyer-confirm', cancel: '/api/orders/' + id + '/cancel', withdraw: '/api/orders/' + id + '/withdraw', receive: '/api/orders/' + id + '/receive', hide: '/api/orders/' + id + '/hide' }; const order = this.data.orders.find(item => item.id === id); const data = action === 'confirm' ? { version: order && order.orderVersion } : {}; request(paths[action], { method: 'POST', data }).then(() => { wx.showToast({ title: '操作成功', icon: 'success' }); this.onShow(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openAddress() { wx.reLaunch({ url: '/pages/address/address' }); }
});
