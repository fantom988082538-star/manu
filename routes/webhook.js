const express = require('express');
const { readDB, writeDB } = require('../services/db');
const supplier = require('../services/supplier');

const router = express.Router();

router.post('/alu', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.body.toString('utf-8');

  const isValid = supplier.verifyWebhookSignature(rawBody, signature, timestamp);
  if (!isValid) {
    console.warn('[webhook] Неверная подпись — запрос отклонён');
    return res.status(401).json({ error: 'Неверная подпись' });
  }

  const payload = JSON.parse(rawBody);
  const orderData = payload.data;

  const db = await readDB();
  const order = db.orders.find(o => o.id === orderData.orderid);
  if (!order) {
    console.warn('[webhook] Заказ не найден:', orderData.orderid);
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  order.status = orderData.status === 'successful' ? 'completed'
               : orderData.status === 'failed' ? 'failed'
               : 'fulfilling';
  order.supplierProviderId = orderData.provider_order_id || order.supplierProviderId;
  await writeDB(db);

  console.log(`[webhook] Заказ ${order.id} обновлён: ${order.status}`);
  res.json({ ok: true });
});

module.exports = router;
