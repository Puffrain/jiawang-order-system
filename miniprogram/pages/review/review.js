const { request } = require('../../utils/request');
Page({
  data: { rating: 5, content: '', orderId: '', orderItemId: '', productName: '', submitting: false, submitted: false },
  onLoad(o) { this.setData({ orderId: o.orderId || '', orderItemId: o.orderItemId || '', productName: o.productName || '' }); },
  chooseRating(e) { if (!this.data.submitting && !this.data.submitted) this.setData({ rating: Number(e.currentTarget.dataset.value) }); },
  onInput(e) { this.setData({ content: e.detail.value }); },
  async submit() {
    if (this.data.submitting || this.data.submitted) return;
    if (!this.data.orderId || !this.data.orderItemId) return wx.showToast({ title: '订单信息不完整，请返回重试', icon: 'none' });
    if (!this.data.content.trim()) return wx.showToast({ title: '请填写评价内容', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await request('/api/reviews', { method: 'POST', data: { orderId: this.data.orderId, orderItemId: this.data.orderItemId, rating: this.data.rating, content: this.data.content } });
      this.setData({ submitted: true });
      wx.showToast({ title: '评价已提交', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      wx.showToast({ title: error.message || '提交失败，请重试', icon: 'none' });
    } finally { this.setData({ submitting: false }); }
  }
});
