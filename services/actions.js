// Общая логика для действий, которые можно выполнить двумя путями:
// либо через кнопку в админ-панели (HTTP-запрос), либо через кнопку
// прямо в Telegram-уведомлении. Чтобы не дублировать код (бонусы,
// начисления, уведомления) — вся логика лежит тут в одном месте.

const { writeDB } = require('./db');
const { sendToChat } = require('./telegram');

async function approveTopup(db, topupId, reviewerId) {
  const topup = db.topups.find(t => t.id === topupId);
  if (!topup) return { error: 'Заявка не найдена' };
  if (topup.status !== 'pending') return { error: 'Заявка уже обработана' };

  const user = db.users.find(u => u.id === topup.userId);
  if (!user) return { error: 'Пользователь не найден' };

  user.balance = (user.balance || 0) + topup.amount;
  topup.status = 'approved';
  topup.reviewedBy = reviewerId;
  topup.reviewedAt = new Date().toISOString();

  // Бонус за сумму пополнения — самый крупный подходящий порог, не складываем
  const tiers = (db.settings?.topupBonusTiers || []).slice().sort((a, b) => b.minAmount - a.minAmount);
  const matchedTier = tiers.find(t => topup.amount >= t.minAmount);
  let amountBonus = 0;
  if (matchedTier) {
    amountBonus = matchedTier.bonus;
    user.balance += amountBonus;
    topup.bonusApplied = amountBonus;
  }

  // Реферальный бонус — при ПЕРВОМ одобренном пополнении приглашённого
  if (user.referredBy && !user.referralBonusPaid) {
    const referrer = db.users.find(u => u.id === user.referredBy);
    const bonus = db.settings?.referralBonusAmount ?? 0;
    if (referrer && bonus > 0) {
      referrer.balance = (referrer.balance || 0) + bonus;
      referrer.referralEarnings = (referrer.referralEarnings || 0) + bonus;
      user.referralBonusPaid = true;
      if (referrer.telegramChatId) {
        sendToChat(referrer.telegramChatId, `🎉 Ваш друг <b>${user.name}</b> совершил первое пополнение — вам начислен бонус <b>${bonus} сомони</b>!`);
      }
    }
  }

  await writeDB(db);

  if (user.telegramChatId) {
    const bonusLine = amountBonus > 0 ? `\n🎁 Бонус за сумму пополнения: +${amountBonus} сомони!` : '';
    sendToChat(user.telegramChatId, `✅ Баланс пополнен на <b>${topup.amount} сомони</b>.${bonusLine}\nТекущий баланс: ${user.balance} сомони.`);
  }

  return { ok: true, topup, user, amountBonus };
}

async function rejectTopup(db, topupId, reviewerId, reason) {
  const topup = db.topups.find(t => t.id === topupId);
  if (!topup) return { error: 'Заявка не найдена' };
  if (topup.status !== 'pending') return { error: 'Заявка уже обработана' };

  topup.status = 'rejected';
  topup.reviewedBy = reviewerId;
  topup.reviewedAt = new Date().toISOString();
  topup.rejectReason = reason || null;
  await writeDB(db);

  const user = db.users.find(u => u.id === topup.userId);
  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `❌ Заявка на пополнение (${topup.amount} сомони) отклонена.${reason ? '\nПричина: ' + reason : ''}`);
  }
  return { ok: true, topup };
}

async function completeOrder(db, orderId, reviewerId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (order.status !== 'checking') return { error: 'Заказ не находится в статусе проверки' };

  order.status = 'completed';
  order.completedBy = reviewerId;
  order.completedAt = new Date().toISOString();
  const user = db.users.find(u => u.id === order.userId);
  if (user) user.totalSpent = (user.totalSpent || 0) + order.price;
  await writeDB(db);

  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `✅ <b>Заказ выполнен!</b>\n${order.gameTitle} — ${order.packLabel}\nUID: ${order.uid}${order.server ? '\nСервер: ' + order.server : ''}\n\nСпасибо, что выбираете ManuShop!`);
  }
  return { ok: true, order };
}

async function cancelOrder(db, orderId, reviewerId, reason) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (!['checking', 'awaiting_payment'].includes(order.status)) return { error: 'Этот заказ уже нельзя отменить' };

  order.status = 'cancelled';
  order.cancelReason = reason || null;
  const user = db.users.find(u => u.id === order.userId);
  if (!order.refunded) {
    if (user) user.balance = (user.balance || 0) + order.price;
    order.refunded = true;
  }
  await writeDB(db);

  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `❌ Заказ отменён (${order.gameTitle} — ${order.packLabel}).${reason ? '\nПричина: ' + reason : ''}\nДеньги возвращены на баланс.`);
  }
  return { ok: true, order };
}

module.exports = { approveTopup, rejectTopup, completeOrder, cancelOrder };
