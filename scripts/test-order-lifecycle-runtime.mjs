import assert from 'node:assert/strict';
import { buyerConfirm, canCustomerEdit, confirmationAfterEdit, merchantConfirm, nextVersion } from '../lib/order-lifecycle.ts';
const base = { status: 'pending_review', orderVersion: 1, merchantConfirmedVersion: 0, buyerConfirmedVersion: 0, confirmationStatus: 'merchant_review', fulfillmentStatus: 'unfulfilled' };
assert.equal(canCustomerEdit(base), true); assert.equal(nextVersion(base), 2);
const merchant = merchantConfirm(base, 1); assert.equal(merchant.confirmationStatus, 'buyer_review');
assert.equal(buyerConfirm({ ...base, ...merchant }, 1).confirmationStatus, 'confirmed');
assert.deepEqual(confirmationAfterEdit(), { confirmationStatus: 'merchant_review', merchantConfirmedVersion: 0, buyerConfirmedVersion: 0 });
assert.throws(() => buyerConfirm(base, 1), /商家先确认/); assert.equal(canCustomerEdit({ ...base, status: 'shipped' }), false);
console.log('order lifecycle state machine PASS');
