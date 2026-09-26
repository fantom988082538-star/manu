const express = require('express');
const { readDB, writeDB } = require('../services/db');
const supplier = require('../services/supplier');
const persshop = require('../services/persshop');
const { applySupplierCompletion, applySupplierFailure, markSupplierFulfilling } = require('../services/actions');

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

// Вебхук Pers Shop (ТЗ п.13). Подпись обязательна — без корректной подписи
// запрос отклоняется, вебхуку не доверяем "на слово". Секрет получен один раз
// при регистрации вебхука (см. POST /api/admin/supplier/webhook/register)
// и хранится в settings.persshop.webhookSecret.
router.post('/persshop', async (req, res) => {
  const rawBody = req.body.toString('utf-8');
  const signature = req.headers['x-persshop-signature'];

  const db = await readDB();
  const secret = db.settings?.persshop?.webhookSecret;
  const isValid = persshop.verifyWebhookSignature(rawBody, signature, secret);
  if (!isValid) {
    console.warn('[webhook persshop] Неверная подпись — запрос отклонён');
    return res.status(401).json({ error: 'Неверная подпись' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Некорректное тело запроса' });
  }

  const supplierOrder = payload.order;
  if (!supplierOrder || !supplierOrder.id) {
    return res.status(400).json({ error: 'Нет данных заказа' });
  }

  const order = db.orders.find(o => o.supplierOrderId === supplierOrder.id);
  if (!order) {
    // Переживаем "вебхук не по порядку" — если заказ ещё не успел получить
    // supplierOrderId (ответ на создание заказа ещё не записан), это не ошибка
    // клиента поставщика, а гонка на нашей стороне — сверка (persshopReconcile)
    // всё равно подхватит статус позже.
    console.warn('[webhook persshop] Заказ не найден по supplierOrderId:', supplierOrder.id);
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  if (supplierOrder.status === 'fulfilled') {
    await applySupplierCompletion(db, order.id);
  } else if (supplierOrder.status === 'refunded' || supplierOrder.status === 'failed') {
    await applySupplierFailure(db, order.id, supplierOrder.status);
  } else {
    await markSupplierFulfilling(db, order.id, supplierOrder.status);
  }

  console.log(`[webhook persshop] Заказ ${order.id} обновлён по вебхуку: ${supplierOrder.status}`);
  res.json({ ok: true });
});

module.exports = router;
