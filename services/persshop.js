// Слой общения с Pers Shop API (persshop.com) — ОСНОВНОЙ и единственный
// активный поставщик для НОВЫХ заказов (см. ТЗ). Старый поставщик ALU
// (services/supplier.js) не трогаем — он остаётся для истории старых
// заказов, для новых больше не используется нигде в коде.
//
// Документация: https://persshop.com/partner/api
// Ключ и базовый URL — ТОЛЬКО из ENV, см. .env.example.

const axios = require('axios');
const crypto = require('crypto');

const client = axios.create({
  baseURL: process.env.PERSSHOP_BASE_URL || 'https://persshop.com/api/v1',
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${process.env.PERSSHOP_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Список категорий (= "игры"). Поддерживает пагинацию через limit/offset —
// НЕ ограничиваемся первой страницей (см. ТЗ п.3). Форма ответа на список
// не была на 100% подтверждена документацией, поэтому в persshopCatalogSync.js
// разбор сделан защитно (categories || items || data) и первая страница
// логируется при первом реальном запуске — проверьте лог после первой синхронизации.
async function getCatalogPage({ q, limit = 100, offset = 0 } = {}) {
  const { data } = await client.get('/catalog', { params: { q, limit, offset } });
  return data;
}

async function getCategory(categoryId) {
  const { data } = await client.get(`/catalog/${encodeURIComponent(categoryId)}`);
  return data.category || data;
}

async function getBalance() {
  const { data } = await client.get('/balance');
  return data;
}

async function createOrder({ categoryId, offerId, amountUsd, fields, idempotencyKey }) {
  const body = { categoryId, fields: fields || {} };
  if (offerId) body.offerId = offerId;
  if (amountUsd !== undefined) body.amountUsd = amountUsd;

  const { data } = await client.post('/orders', body, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
  });
  return data;
}

async function getOrder(idOrNumber) {
  const { data } = await client.get(`/orders/${encodeURIComponent(idOrNumber)}`);
  return data;
}

async function listOrders({ status, limit = 100, offset = 0 } = {}) {
  const { data } = await client.get('/orders', { params: { status, limit, offset } });
  return data;
}

async function checkId({ categoryId, fields }) {
  const { data } = await client.post('/check-id', { categoryId, fields });
  return data;
}

async function getWebhookConfig() {
  const { data } = await client.get('/webhook');
  return data.webhook || data;
}

async function setWebhookUrl(url) {
  const { data } = await client.put('/webhook', { url });
  return data.webhook || data;
}

async function rotateWebhookSecret() {
  const { data } = await client.post('/webhook', { action: 'rotate_secret' });
  return data.webhook || data;
}

// Подпись вебхука: заголовок вида "t=<unix>,v1=<hmac>",
// HMAC-SHA256(secret, "<t>.<rawBody>"). Отклоняем, если событие старше 5 минут.
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = {};
  for (const piece of String(signatureHeader).split(',')) {
    const [k, v] = piece.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 5 * 60) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  let expectedBuf, gotBuf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    gotBuf = Buffer.from(v1, 'hex');
  } catch (e) {
    return false;
  }
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

module.exports = {
  getCatalogPage, getCategory, getBalance, createOrder, getOrder, listOrders,
  checkId, getWebhookConfig, setWebhookUrl, rotateWebhookSecret, verifyWebhookSignature
};
