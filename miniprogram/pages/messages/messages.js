const { request } = require('../../utils/request');

function formatMessage(message) {
  const content = String(message.content || '').trim();
  return Object.assign({}, message, {
    content: content || '系统消息',
    isMine: message.fromUserId === getApp().globalData.userId,
    isSystem: message.type !== 'text',
    createdAt: String(message.createdAt || '').replace('T', ' ').slice(0, 16)
  });
}

Page({
  data: { messages: [], content: '', cursor: 0, loading: true, sending: false, error: '', scrollIntoView: '' },
  onShow() {
    this.loadIdentity().then(() => {
      this.loadMessages();
      this.startPolling();
    }).catch(() => this.stopPolling());
  },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.loadMessages(true), 10000);
  },
  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  },
  loadIdentity() {
    const app = getApp();
    if (app.globalData.userId) return Promise.resolve(app.globalData.userId);
    return request('/api/auth/me').then(({ user }) => {
      if (!user || !user.id) throw new Error('当前登录信息无效，请重新登录');
      app.globalData.userId = user.id;
      wx.setStorageSync('sessionUserId', user.id);
      return user.id;
    }).catch((error) => {
      this.setData({ loading: false, error: error.message || '无法读取当前登录信息' });
      throw error;
    });
  },
  loadMessages(silent) {
    if (this.loadingMessages) return Promise.resolve();
    this.loadingMessages = true;
    if (!silent) this.setData({ loading: true, error: '' });
    return request('/api/chat/messages')
      .then(({ messages = [], cursor = 0 }) => {
        const normalized = messages.map(formatMessage);
        const last = normalized[normalized.length - 1];
        this.setData({ messages: normalized, cursor, scrollIntoView: last ? 'message-' + last.id : '' });
      })
      .catch((error) => { if (!silent) this.setData({ error: error.message || '消息加载失败' }); })
      .finally(() => {
        this.loadingMessages = false;
        if (!silent) this.setData({ loading: false });
      });
  },
  inputContent(event) { this.setData({ content: event.detail.value || '' }); },
  sendMessage() {
    const content = String(this.data.content || '').trim();
    if (!content || this.data.sending) return;
    const clientMessageId = Date.now() + '-' + Math.random().toString(36).slice(2);
    this.setData({ sending: true, error: '' });
    request('/api/chat/messages', { method: 'POST', data: { content, clientMessageId } })
      .then(() => {
        this.setData({ content: '' });
        return this.loadMessages(true);
      })
      .catch((error) => this.setData({ error: error.message || '消息发送失败' }))
      .finally(() => this.setData({ sending: false }));
  },
  openHome() { wx.reLaunch({ url: '/pages/home/home' }); },
  openCart() { wx.reLaunch({ url: '/pages/cart/cart' }); },
  openOrders() { wx.reLaunch({ url: '/pages/orders/orders' }); },
  openAddress() { wx.reLaunch({ url: '/pages/address/address' }); }
});
