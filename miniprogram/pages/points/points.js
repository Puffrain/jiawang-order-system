const { request } = require('../../utils/request');
Page({ data: { balance: 0, ledger: [], error: '' }, onShow() { request('/api/loyalty').then(({ loyalty }) => this.setData({ balance: Number(loyalty?.balance || 0), ledger: loyalty?.ledger || [] })).catch(error => this.setData({ error: error.message || '积分加载失败' })); } });
