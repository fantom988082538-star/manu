// Слой общения с ALU API (aluu.in) — реальный поставщик игровых донатов.
// Сейчас НЕ вызывается автоматически (выдача донатов ручная), но код оставлен
// на будущее, если решите включить автоматическую отправку заказов.

const axios = require('axios');
const crypto = require('crypto');

const client = axios.create({
  baseURL: process.env.SUPPLIER_BASE_URL, // https://aluu.in/api/v.1
  timeout: 15000,
  headers: {
    'x-api-key': process.env.SUPPLIER_API_KEY,
    'Content-Type': 'application/json'
  }
});

async function getBalance() {
  const { data } = await client.get('/balance');
  return data.data;
}

async function getGames() {
  const { data } = await client.get('/games');
  return data.data;
}

async function getProducts(gamecode) {
  const { data } = await client.get(`/products/${gamecode}`);
  return data.data;
}

async function getServerOptions(gamecode) {
  const { data } = await client.get('/server-options', { params: { gamecode } });
  return data;
}

async function createSupplierOrder({ gamecode, denom, userid, serverid, charname, partnerOrderId }) {
  const { data } = await client.post('/create', {
    game: gamecode,
    denom,
    userid,
    serverid: serverid || '',
    charname: charname || '',
    partner_webhook_url: process.env.WEBHOOK_BASE_URL ? `${process.env.WEBHOOK_BASE_URL}/api/webhook/alu` : undefined,
    partner_orderid: partnerOrderId
  });
  return data.data;
}

async function getOrder(partnerOrderId) {
  const { data } = await client.get(`/${partnerOrderId}`);
  return data.data;
}

async function trackOrder(partnerOrderId) {
  const { data } = await client.post(`/${partnerOrderId}/track`);
  return data.data;
}

// Проверка подписи вебхука от ALU: HMAC-SHA256(secret, timestamp + "." + rawBody)
function verifyWebhookSignature(rawBody, signature, timestamp) {
  const secret = process.env.SUPPLIER_SECRET_KEY;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(String(signature || ''), 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = {
  getBalance, getGames, getProducts, getServerOptions,
  createSupplierOrder, getOrder, trackOrder, verifyWebhookSignature
};
