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

  topup.status = 'approved';
  topup.reviewedBy = reviewerId;
  topup.reviewedAt = new Date().toISOString();

  // Плашки "Поддержать администрацию ❤️" и "VIP — скидка до 10% 🔥" используют
  // тот же чек + ручное подтверждение, что и обычное пополнение (ТЗ п.15-18),
  // но результат разный — деньги НЕ идут на баланс покупателя.
  const purpose = topup.purpose || 'balance';

  if (purpose === 'vip') {
    const before = user.purchasedVipPercent || 0;
    user.purchasedVipPercent = Math.max(before, topup.vipPercent || 0); // никогда не понижаем (ТЗ п.17)
    if (user.purchasedVipPercent > before) user.vipPurchasedAt = new Date().toISOString();
    await writeDB(db);
    if (user.telegramChatId) {
      sendToChat(user.telegramChatId, `🔥 VIP ${user.purchasedVipPercent}% активирован! Скидка уже применяется к новым заказам.`);
    }
    return { ok: true, topup, user, amountBonus: 0 };
  }

  if (purpose === 'support') {
    await writeDB(db);
    if (user.telegramChatId) {
      sendToChat(user.telegramChatId, `❤️ Спасибо за поддержку администрации! Ваш взнос очень важен для нас.`);
    }
    return { ok: true, topup, user, amountBonus: 0 };
  }

  // purpose === 'balance' — обычное пополнение, поведение НЕ изменилось
  user.balance = (user.balance || 0) + topup.amount;

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

// --- Автоматический жизненный цикл заказов Pers Shop ---
// Отдельно от completeOrder()/cancelOrder() выше (те — для РУЧНОГО подтверждения
// админом старых игр). Здесь инициатор — сам поставщик: ответ на создание
// заказа, вебхук или периодическая сверка статусов (services/persshopReconcile.js).
// Все функции идемпотентны — безопасно вызвать дважды для одного и того же заказа
// (например, вебхук и сверка пришли почти одновременно).

async function applySupplierCompletion(db, orderId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (order.status === 'completed') return { ok: true, order };

  order.status = 'completed';
  order.completedAt = new Date().toISOString();
  const user = db.users.find(u => u.id === order.userId);
  if (user) user.totalSpent = (user.totalSpent || 0) + order.price;
  await writeDB(db);

  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `✅ <b>Заказ выполнен!</b>\n${order.gameTitle} — ${order.packLabel}\n\nСпасибо, что выбираете нас!`);
  }
  return { ok: true, order };
}

// Заказ не выполнен на стороне Pers Shop (failed/refunded) — возвращаем деньги,
// если ещё не возвращены.
async function applySupplierFailure(db, orderId, reasonCode) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (order.status === 'failed' || order.status === 'completed') return { ok: true, order };

  order.status = 'failed';
  order.supplierError = reasonCode || order.supplierError || null;
  const user = db.users.find(u => u.id === order.userId);
  if (!order.refunded) {
    if (user) user.balance = (user.balance || 0) + order.price;
    order.refunded = true;
  }
  await writeDB(db);

  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `❌ Заказ не удалось выполнить (${order.gameTitle} — ${order.packLabel}).\nДеньги возвращены на баланс.`);
  }
  return { ok: true, order };
}

// Отдельный статус для случая "не хватает баланса НАШЕГО аккаунта у Pers Shop"
// (ТЗ п.10) — это не ошибка заказа как такового, админ должен пополнить баланс
// у поставщика. Покупателю в любом случае возвращаем деньги, ложный успех не показываем.
async function applySupplierBalanceInsufficient(db, orderId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (order.status === 'supplier_balance_insufficient' || order.status === 'completed') return { ok: true, order };

  order.status = 'supplier_balance_insufficient';
  const user = db.users.find(u => u.id === order.userId);
  if (!order.refunded) {
    if (user) user.balance = (user.balance || 0) + order.price;
    order.refunded = true;
  }
  await writeDB(db);

  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `⏳ Заказ временно не может быть выполнен поставщиком. Деньги возвращены на баланс, попробуйте немного позже.\n${order.gameTitle} — ${order.packLabel}`);
  }
  return { ok: true, order };
}

// Промежуточный статус "поставщик ещё выполняет заказ" — просто обновляем
// статус, не финализируем и ничего не возвращаем/не списываем.
async function markSupplierFulfilling(db, orderId, supplierStatus) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (order.status === 'completed' || order.status === 'failed') return { ok: true, order }; // уже финализирован — не откатываем
  order.status = 'fulfilling';
  order.supplierStatus = supplierStatus || order.supplierStatus;
  await writeDB(db);
  return { ok: true, order };
}

// Ручное разрешение заказа, который НЕ прошёл у Pers Shop — из-за нехватки
// НАШЕГО баланса (supplier_balance_insufficient) или другой ошибки (failed).
// Деньги покупателю уже вернули в момент сбоя. У админа два варианта:
//  - "complete": он всё же выдал донат сам (например, вручную через личный
//    кабинет Pers Shop после пополнения баланса) — тогда нужно списать оплату
//    у покупателя ЗАНОВО (иначе донат достанется бесплатно — деньги-то вернули).
//  - "reject": донат выдавать не будем, деньги остаются у покупателя как есть,
//    просто закрываем заказ, чтобы не висел в списке "проблемных".
async function resolveFailedSupplierOrder(db, orderId, adminId, resolution) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { error: 'Заказ не найден' };
  if (!['supplier_balance_insufficient', 'failed'].includes(order.status)) {
    return { error: 'Этот заказ не в статусе ошибки поставщика' };
  }
  const user = db.users.find(u => u.id === order.userId);

  if (resolution === 'complete') {
    if (order.refunded) {
      if (!user) return { error: 'Пользователь не найден' };
      if ((user.balance || 0) < order.price) {
        return { error: `У покупателя недостаточно средств на балансе (нужно ${order.price}, есть ${user.balance || 0} сомони) — деньги уже вернулись ему при сбое. Попросите пополнить баланс или спишите вручную после этого.` };
      }
      user.balance -= order.price;
      order.refunded = false;
    }
    order.status = 'completed';
    order.completedAt = new Date().toISOString();
    order.resolvedBy = adminId;
    if (user) user.totalSpent = (user.totalSpent || 0) + order.price;
    await writeDB(db);
    if (user?.telegramChatId) {
      sendToChat(user.telegramChatId, `✅ <b>Заказ выполнен!</b>\n${order.gameTitle} — ${order.packLabel}\n\nСпасибо, что выбираете нас!`);
    }
    return { ok: true, order };
  }

  if (resolution === 'reject') {
    order.status = 'failed';
    order.resolvedBy = adminId;
    await writeDB(db);
    if (user?.telegramChatId) {
      sendToChat(user.telegramChatId, `❌ Заказ не будет выполнен (${order.gameTitle} — ${order.packLabel}). Деньги остаются на вашем балансе.`);
    }
    return { ok: true, order };
  }

  return { error: 'Некорректное действие — ожидалось complete или reject' };
}

module.exports = {
  approveTopup, rejectTopup, completeOrder, cancelOrder,
  applySupplierCompletion, applySupplierFailure, applySupplierBalanceInsufficient, markSupplierFulfilling,
  resolveFailedSupplierOrder
};
