const express = require('express');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdminWithButtons } = require('../services/telegram');

const router = express.Router();

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
router.post('/', requireAuth, async (req, res) => {
  const { gameKey, packId, uid, server, amount } = req.body;
  const db = await readDB();
  const game = db.games.find(g => g.key === gameKey);
  if (!game) return res.status(400).json({ error: 'Игра не найдена' });
  if (!uid) return res.status(400).json({ error: 'Укажите UID игрока' });
  if (game.needsServer && !server) return res.status(400).json({ error: 'Укажите сервер' });

  let price, packLabel, packIdOut = null, denomOut = null, baseAmount = null, commissionPercent = null;

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
  }

  const user = db.users.find(u => u.id === req.user.id);
  const basePrice = price;

  // Скидка: либо VIP-уровень (по общей сумме потраченного), либо скидка на первый заказ — берём БОЛЬШУЮ, не складываем
  const isFirstOrder = !db.orders.some(o => o.userId === user.id && o.status !== 'cancelled');
  const s = db.settings || {};
  const vipTiers = (s.vipTiers || []).slice().sort((a, b) => b.minSpent - a.minSpent);
  const autoVipTier = vipTiers.find(t => (user.totalSpent || 0) >= t.minSpent);
  const vipDiscount = user.manualVipTier ? user.manualVipTier.discountPercent : (autoVipTier ? autoVipTier.discountPercent : 0);
  const firstOrderDiscount = (isFirstOrder && s.firstOrderDiscountEnabled) ? (s.firstOrderDiscountPercent || 0) : 0;

  let discountPercent = 0, discountReason = null;
  if (firstOrderDiscount > vipDiscount) { discountPercent = firstOrderDiscount; discountReason = 'first_order'; }
  else if (vipDiscount > 0) { discountPercent = vipDiscount; discountReason = 'vip'; }

  if (discountPercent > 0) {
    price = Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100;
  }

  const order = {
    id: 'MS-' + Math.floor(100000 + Math.random() * 900000),
    userId: req.user.id,
    gameKey, gameTitle: game.title,
    packId: packIdOut, packLabel, denom: denomOut,
    baseAmount, commissionPercent,
    basePrice, discountPercent, discountReason,
    price,
    uid, server: server || null,
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
  notifyAdminWithButtons(
    `🎮 <b>Новый заказ на выдачу</b>\n` +
    `${order.gameTitle} — ${order.packLabel}\n` +
    `UID: <b>${order.uid}</b>${order.server ? ' · сервер: ' + order.server : ''}\n` +
    `Сумма: ${order.price} сомони${discountPercent > 0 ? ` (скидка ${discountPercent}%, было ${basePrice})` : ''}`,
    [[
      { text: '✅ Выполнено', callback_data: `order_complete:${order.id}` },
      { text: '❌ Отменить', callback_data: `order_cancel:${order.id}` }
    ]]
  );
  res.json(order);
});

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
