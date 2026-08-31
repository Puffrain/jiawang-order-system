const { request } = require('../../utils/request');

Page({
  data: { orders: [], loading: true },
  onShow() { request('/api/orders').then(({ orders = [] }) => this.setData({ orders })).catch(error => this.setData({ error: error.message })).finally(() => this.setData({ loading: false })); },
  action(event) { const { id, action } = event.currentTarget.dataset; const paths = { confirm: '/api/orders/' + id + '/buyer-confirm', cancel: '/api/orders/' + id + '/cancel', withdraw: '/api/orders/' + id + '/withdraw', receive: '/api/orders/' + id + '/receive', hide: '/api/orders/' + id + '/hide' }; const order = this.data.orders.find(item => item.id === id); const data = action === 'confirm' ? { version: order && order.orderVersion } : {}; request(paths[action], { method: 'POST', data }).then(() => { wx.showToast({ title: '操作成功', icon: 'success' }); this.onShow(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); }
});
