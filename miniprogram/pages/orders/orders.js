const { request } = require('../../utils/request');

Page({
  data: { orders: [], visibleOrders: [], filter: 'all', filters: [{ key: 'all', label: '全部' }, { key: 'pending', label: '待处理' }, { key: 'delivery', label: '配送中' }, { key: 'done', label: '已完成' }], loading: true },
  onShow() { request('/api/orders').then(({ orders = [] }) => { this.setData({ orders }); this.applyFilter(orders, this.data.filter); }).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  applyFilter(orders, filter) { const visibleOrders = orders.filter(item => filter === 'all' || filter === 'pending' && ['pending_review', 'pending_payment', 'pending_shipment'].includes(item.status) || filter === 'delivery' && ['assigned', 'out_for_delivery', 'shipped'].includes(item.fulfillmentStatus) || filter === 'done' && ['delivered', 'closed', 'cancelled'].includes(item.status) || filter === 'done' && item.fulfillmentStatus === 'delivered'); this.setData({ visibleOrders }); },
  changeFilter(event) { const filter = event.currentTarget.dataset.key; this.setData({ filter }); this.applyFilter(this.data.orders, filter); },
  action(event) { const { id, action } = event.currentTarget.dataset; const paths = { confirm: '/api/orders/' + id + '/buyer-confirm', cancel: '/api/orders/' + id + '/cancel', withdraw: '/api/orders/' + id + '/withdraw', receive: '/api/orders/' + id + '/receive', hide: '/api/orders/' + id + '/hide' }; const order = this.data.orders.find(item => item.id === id); const data = action === 'confirm' ? { version: order && order.orderVersion } : {}; request(paths[action], { method: 'POST', data }).then(() => { wx.showToast({ title: '操作成功', icon: 'success' }); this.onShow(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); }, openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); }, openAddress() { wx.reLaunch({ url: '/pages/address/address' }); }
});
