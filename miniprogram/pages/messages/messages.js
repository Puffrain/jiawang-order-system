const { request, assetUrl } = require('../../utils/request');

function formatMessage(message) {
  const content = String(message.content || '').trim();
  return Object.assign({}, message, {
    content: content || '系统消息',
    isMine: message.fromUserId === getApp().globalData.userId,
    isImage: message.type === 'image',
    isSystem: message.type !== 'text' && message.type !== 'image',
    createdAt: String(message.createdAt || '').replace('T', ' ').slice(0, 16)
  });
}

Page({
  data: { messages: [], content: '', cursor: 0, loading: true, sending: false, error: '', scrollIntoView: '' },
  hydrateMessageImages(messages) {
    const app = getApp();
    const token = app.globalData.sessionToken || wx.getStorageSync('sessionToken') || '';
    return Promise.all((messages || []).map((message) => {
      if (!message.isImage || !message.payload || !message.payload.mediaUrl || !token) return Promise.resolve(message);
      return new Promise((resolve) => {
        wx.downloadFile({
          url: assetUrl(message.payload.mediaUrl),
          header: { Authorization: 'Bearer ' + token },
          timeout: 15000,
          success: (result) => resolve(Object.assign({}, message, { localImageUrl: result.statusCode >= 200 && result.statusCode < 300 ? result.tempFilePath : '' })),
          fail: () => resolve(message)
        });
      });
    }));
  },
  previewImage(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  chooseImage() {
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: ({ tempFilePaths }) => {
      const filePath = tempFilePaths && tempFilePaths[0]; if (!filePath) return;
      const app = getApp(); const token = app.globalData.sessionToken || wx.getStorageSync('sessionToken');
      this.setData({ sending: true, error: '' });
      wx.uploadFile({ url: app.globalData.apiBaseUrl + '/api/chat/image', filePath, name: 'image', header: { Authorization: 'Bearer ' + token }, formData: { clientMessageId: Date.now() + '-' + Math.random().toString(36).slice(2) }, success: res => {
        try { const payload = JSON.parse(res.data || '{}'); if (res.statusCode >= 300) throw new Error(payload.error || '图片发送失败'); this.loadMessages(true); } catch (error) { this.setData({ error: error.message }); }
      }, fail: error => this.setData({ error: error.errMsg || '图片发送失败' }), complete: () => this.setData({ sending: false }) });
    } });
  },
  onShow() {
    request('/api/customers/profile').then(({ profile }) => {
      if (profile && !profile.profileCompleted) {
        this.stopPolling();
        wx.reLaunch({ url: '/pages/profile/profile?onboarding=1' });
        return;
      }
      return this.loadIdentity().then(() => {
        this.loadMessages();
        this.startPolling();
      });
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
        return this.hydrateMessageImages(normalized).then((hydrated) => {
          const last = hydrated[hydrated.length - 1];
          this.setData({ messages: hydrated, cursor, scrollIntoView: last ? 'message-' + last.id : '' });
        });
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
  openAddress() { wx.reLaunch({ url: '/pages/address/address' }); },
  openProfile() { wx.reLaunch({ url: '/pages/profile/profile' }); }
});
