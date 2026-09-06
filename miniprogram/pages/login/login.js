const { request } = require('../../utils/request');

Page({
  data: { loading: false, error: '', loginTicket: '', phone: '', code: '', challengeId: '', developmentCode: '', countdown: 0 },
  onUnload() { this.stopCountdown(); },
  stopCountdown() { if (this.countdownTimer) clearInterval(this.countdownTimer); this.countdownTimer = null; },
  startCountdown() {
    this.stopCountdown();
    this.setData({ countdown: 60 });
    this.countdownTimer = setInterval(() => {
      const next = Math.max(0, Number(this.data.countdown || 0) - 1);
      this.setData({ countdown: next });
      if (!next) this.stopCountdown();
    }, 1000);
  },
  inputPhone(event) { this.setData({ phone: String(event.detail.value || '').replace(/\D/g, '').slice(0, 11) }); },
  inputCode(event) { this.setData({ code: String(event.detail.value || '').replace(/\D/g, '').slice(0, 6) }); },
  saveSession(payload) {
    const token = payload.sessionToken || '';
    if (!token) throw new Error('登录凭证未返回，请联系管理员');
    getApp().globalData.sessionToken = token;
    getApp().globalData.role = payload.role || 'buyer';
    wx.setStorageSync('sessionToken', token);
    wx.setStorageSync('sessionRole', payload.role || 'buyer');
    wx.removeStorageSync('sessionUserId');
    getApp().globalData.userId = '';
    wx.reLaunch({ url: payload.profile && !payload.profile.profileCompleted ? '/pages/profile/profile?onboarding=1' : '/pages/home/home' });
  },
  login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    wx.login({
      success: ({ code }) => {
        if (!code) {
          this.setData({ error: '微信没有返回登录凭证，请在微信开发者工具中配置有效 AppID 后重新编译' });
          this.setData({ loading: false });
          return;
        }
        request('/api/auth/wechat/login', { method: 'POST', data: { code } }).then((payload) => {
          if (payload.requiresPhoneBinding) {
            this.setData({ loginTicket: payload.loginTicket || '', error: '' });
            return;
          }
          this.saveSession(payload);
        }).catch((error) => this.setData({ error: error?.message || error?.errMsg || '登录请求失败，请检查小程序合法域名配置' })).finally(() => this.setData({ loading: false }));
      },
      fail: (error) => {
        const detail = String(error && (error.errMsg || error.message) || '');
        const hint = /appid|app id|invalid/i.test(detail)
          ? '当前小程序未配置有效 AppID，请打开上传副本或在开发者工具中填写 AppID 后重新编译'
          : '无法获取微信登录凭证，请确认已在微信开发者工具中运行并重试';
        this.setData({ error: hint, loading: false });
      }
    });
  },
  sendCode() {
    if (this.data.loading || this.data.countdown > 0) return;
    if (!/^1\d{10}$/.test(this.data.phone)) return this.setData({ error: '请输入正确的 11 位手机号' });
    this.setData({ loading: true, error: '' });
    request('/api/auth/buyer/send-code', { method: 'POST', data: { phone: this.data.phone, purpose: 'wechat_bind' } })
      .then((payload) => { this.setData({ challengeId: payload.challengeId || '', developmentCode: payload.developmentCode || '' }); this.startCountdown(); })
      .catch((error) => this.setData({ error: error?.message || '验证码发送失败' }))
      .finally(() => this.setData({ loading: false }));
  },
  bindPhone() {
    if (this.data.loading) return;
    if (!this.data.challengeId) return this.sendCode();
    this.setData({ loading: true, error: '' });
    request('/api/auth/wechat/bind-phone', { method: 'POST', data: { loginTicket: this.data.loginTicket, phone: this.data.phone, code: this.data.code, challengeId: this.data.challengeId } })
      .then((payload) => this.saveSession(payload))
      .catch((error) => this.setData({ error: error?.message || '手机号绑定失败' }))
      .finally(() => this.setData({ loading: false }));
  },
  courierLogin() { wx.navigateTo({ url: '/pages/courier-login/courier-login' }); }
});
