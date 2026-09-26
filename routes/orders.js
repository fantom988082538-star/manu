const express = require('express');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { spamGuard } = require('../middleware/spamGuard');
const { notifyAdminWithButtons } = require('../services/telegram');
const { computeVip } = require('../services/vip');
const persshop = require('../services/persshop');
const { applySupplierCompletion, applySupplierFailure, applySupplierBalanceInsufficient } = require('../services/actions');
const { toLegacyGameShape } = require('../services/persshopCatalogSync');

const router = express.Router();
const orderGuard = spamGuard('Слишком много заказов подряд. Попробуйте снова через 30 минут.');

// Статусы заказа: created -> awaiting_payment -> checking -> completed / cancelled
// Выдача донатов ручная: после оплаты заказ просто уходит в "checking",
// а админ сам выдаёт донат и подтверждает через /api/admin/orders/:id/complete

function refundOrder(db, order) {
  if (order.refunded) return;
  const user = db.users.find(u => u.id === order.userId);
  if (user) user.balance = (user.balance || 0) + order.price;
  order.refunded = true;
}

// Создать заказ. Списывает деньги с баланса, если средств хватает, и ставит "на проверку".
// Два типа игр: "fixed" (обычные пакеты, как Free Fire) и "percentage" (свободная сумма + комиссия, например Steam)
router.post('/', requireAuth, orderGuard, async (req, res) => {
  const { gameKey, packId, uid, server, amount } = req.body;
  const db = await readDB();

  // Игра может быть либо старой статической (data/games.json, ручная выдача),
  // либо синхронизированной с Pers Shop (db.supplierGames, автоматическая
  // отправка поставщику ниже). Ключ у supplier-игр вида "persshop:<categoryId>".
  const staticGame = db.games.find(g => g.key === gameKey);
  const supplierGameRecord = staticGame ? null : (db.supplierGames || []).find(g => g.id === gameKey);
  const game = staticGame || (supplierGameRecord ? toLegacyGameShape(supplierGameRecord) : null);
  if (!game) return res.status(400).json({ error: 'Игра не найдена' });
  if (!uid) return res.status(400).json({ error: 'Укажите UID игрока' });
  if (game.needsServer && !server) return res.status(400).json({ error: 'Укажите сервер' });

  let price, packLabel, packIdOut = null, denomOut = null, baseAmount = null, commissionPercent = null;
  let isCustomPack = false;

  if (game.pricingType === 'percentage') {
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Укажите сумму пополнения' });
    commissionPercent = game.commissionPercent || 0;
    price = Math.round(amt * (1 + commissionPercent / 100) * 100) / 100;
    baseAmount = amt;
    packLabel = `Пополнение на ${amt} сомони`;
  } else {
    const pack = game.packs.find(p => p.id === packId);
    if (!pack) return res.status(400).json({ error: 'Пакет не найден' });
    price = pack.price;
    packLabel = pack.label;
    packIdOut = pack.id;
    denomOut = pack.denom;
    isCustomPack = !!pack.isCustom;
  }

  const user = db.users.find(u => u.id === req.user.id);
  const basePrice = price;

  // Скидка: либо VIP-уровень (авто по сумме покупок / ручной от админа / купленный
  // за деньги — берём максимум из трёх, см. services/vip.js), либо скидка на
  // первый заказ — между VIP и первым заказом тоже берём БОЛЬШУЮ, не складываем
  const isFirstOrder = !db.orders.some(o => o.userId === user.id && o.status !== 'cancelled');
  const s = db.settings || {};
  const { currentTier } = computeVip(db, user);
  const vipDiscount = currentTier ? currentTier.discountPercent : 0;
  const firstOrderDiscount = (isFirstOrder && s.firstOrderDiscountEnabled) ? (s.firstOrderDiscountPercent || 0) : 0;

  let discountPercent = 0, discountReason = null;
  if (firstOrderDiscount > vipDiscount) { discountPercent = firstOrderDiscount; discountReason = 'first_order'; }
  else if (vipDiscount > 0) { discountPercent = vipDiscount; discountReason = 'vip'; }

  if (discountPercent > 0) {
    price = Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100;
  }
  if (price < 0) price = 0; // подстраховка, не допускаем отрицательную цену (ТЗ п.17)

  const order = {
    id: 'MS-' + Math.floor(100000 + Math.random() * 900000),
    userId: req.user.id,
    gameKey, gameTitle: game.title,
    packId: packIdOut, packLabel, denom: denomOut,
    baseAmount, commissionPercent,
    basePrice, discountPercent, discountReason,
    price,
    uid, server: server || null,
    provider: (supplierGameRecord && !isCustomPack) ? 'persshop' : null,
    status: 'created',
    refunded: false,
    createdAt: new Date().toISOString()
  };

  if (user.balance < price) {
    return res.status(402).json({ error: 'Недостаточно средств на балансе, пополните баланс' });
  }

  user.balance -= price;
  order.status = 'checking';
  db.orders.push(order);
  await writeDB(db);

  if (supplierGameRecord && !isCustomPack) {
    // Новый путь — товар синхронизирован с Pers Shop, отправляем автоматически.
    // Старые игры (data/games.json) и свои номиналы (isCustom) этот код не
    // затрагивает — для них ниже старое ручное уведомление админу.
    await fulfillPersShopOrder(order.id, supplierGameRecord, game);
  } else {
    // Ручная выдача админом — старые статичные игры И свои номиналы внутри
    // игр Pers Shop (когда админ добавил свой товар и выдаёт его сам).
    notifyAdminWithButtons(
      `🎮 <b>Новый заказ на выдачу</b>\n` +
      `${order.gameTitle} — ${order.packLabel}${isCustomPack ? ' <i>(ваш собственный товар)</i>' : ''}\n` +
      `UID: <b>${order.uid}</b>${order.server ? ' · сервер: ' + order.server : ''}\n` +
      `Сумма: ${order.price} сомони${discountPercent > 0 ? ` (скидка ${discountPercent}%, было ${basePrice})` : ''}`,
      [[
        { text: '✅ Выполнено', callback_data: `order_complete:${order.id}` },
        { text: '❌ Отменить', callback_data: `order_cancel:${order.id}` }
      ]]
    );
  }

  const finalDb = await readDB();
  res.json(finalDb.orders.find(o => o.id === order.id));
});

// Отправка заказа поставщику Pers Shop + обработка ответа/ошибок (ТЗ п.9-11).
// Idempotency-Key = id нашего заказа — повторная отправка (если вдруг вызовется
// дважды) не создаст два заказа у поставщика (ТЗ п.12).
async function fulfillPersShopOrder(orderId, supplierGameRecord, legacyGame) {
  const fieldKeys = legacyGame.supplierFieldKeys || [];
  let db = await readDB();
  const order = db.orders.find(o => o.id === orderId);
  const fields = {};
  if (fieldKeys[0]) fields[fieldKeys[0]] = order.uid;
  if (fieldKeys[1] && order.server) fields[fieldKeys[1]] = order.server;

  let result;
  try {
    result = await persshop.createOrder({
      categoryId: supplierGameRecord.categoryId,
      offerId: order.packId,
      fields,
      idempotencyKey: order.id
    });
  } catch (e) {
    const code = e.response?.data?.code;
    db = await readDB();
    if (code === 'insufficient_balance') {
      // Это баланс НАШЕГО аккаунта у Pers Shop, а не у покупателя (ТЗ п.10)
      await applySupplierBalanceInsufficient(db, orderId);
      notifyAdminWithButtons(
        `⚠️ <b>Недостаточно баланса Pers Shop</b>\nЗаказ ${orderId} не отправлен поставщику — пополните баланс на persshop.com.`,
        []
      );
      return;
    }
    await applySupplierFailure(db, orderId, code || e.message);
    notifyAdminWithButtons(
      `❌ <b>Ошибка Pers Shop</b>\nЗаказ ${orderId}: ${code || e.message}\nСредства возвращены покупателю.`,
      []
    );
    return;
  }

  db = await readDB();
  const freshOrder = db.orders.find(o => o.id === orderId);
  const supplierOrder = result.order || result;
  freshOrder.supplierOrderId = supplierOrder.id;
  freshOrder.supplierOrderNumber = supplierOrder.number || null;
  freshOrder.supplierStatus = supplierOrder.status;
  await writeDB(db);

  if (supplierOrder.status === 'fulfilled') {
    const fresh = await readDB();
    await applySupplierCompletion(fresh, orderId);
  } else if (supplierOrder.status === 'refunded' || supplierOrder.status === 'failed') {
    const fresh = await readDB();
    await applySupplierFailure(fresh, orderId, supplierOrder.status);
  }
  // иначе остаётся 'fulfilling' — статус уточнит вебхук или периодическая сверка
}

router.get('/:id/status', requireAuth, async (req, res) => {
  const db = await readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.userId !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
  res.json(order);
});

router.get('/', requireAuth, async (req, res) => {
  const db = await readDB();
  const myOrders = db.orders.filter(o => o.userId === req.user.id).reverse();
  res.json(myOrders);
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const db = await readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.userId !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
  if (order.status !== 'awaiting_payment') return res.status(409).json({ error: 'Можно отменить только неоплаченный заказ' });
  order.status = 'cancelled';
  await writeDB(db);
  res.json(order);
});

module.exports = router;
