// Логика маркетплейса продажи аккаунтов.
//
// СХЕМА СДЕЛКИ (без внешних платёжных систем — используем то, что уже
// есть: внутренний баланс пользователя и ручной вывод через Alif/DC):
//
//   1) Продавец создаёт объявление — публикуется СРАЗУ, без модерации
//      (админ может снять недопустимое объявление постфактум — см. removeListingByAdmin)
//   2) Покупатель жмёт "Купить" — деньги СРАЗУ списываются с его баланса
//      (как при обычном заказе), сделка уходит в статус in_progress
//   3) Продавец передаёт логин/пароль от аккаунта через сайт (не в объявлении,
//      а только после оплаты — чтобы данные не утекли раньше времени)
//   4) Покупатель подтверждает получение — деньги ЗАЧИСЛЯЮТСЯ НА БАЛАНС
//      продавца ЗА ВЫЧЕТОМ комиссии гаранта (db.settings.guarantorCommission,
//      по умолчанию 10 сомони), дальше он выводит их как обычно (заявка на
//      вывод, админ вручную переводит — ничего нового изобретать не пришлось)
//   5) Если покупатель НЕ подтвердил и НЕ пожаловался в течение 24 часов
//      после получения данных аккаунта — сделка завершается автоматически
//      (стандартная практика маркетплейсов). Отзыв при этом остаётся
//      полностью необязательным и никогда не подделывается.
//   6) Если есть спор — сделка замораживается, разбирает вручную админ.

const { writeDB } = require('./db');
const { sendToChat, notifyAdmin } = require('./telegram');
const { v4: uuid } = require('uuid');

const AUTO_COMPLETE_HOURS = 24;

// --- Объявления ---

// Объявления публикуются мгновенно (без модерации до публикации).
// Это — снятие уже опубликованного объявления администратором постфактум
// (например, если оно неуместное или мошенническое).
async function removeListingByAdmin(db, listingId, reviewerId, reason) {
  const listing = db.accountListings.find(l => l.id === listingId);
  if (!listing) return { error: 'Объявление не найдено' };
  if (!['active', 'pending'].includes(listing.status)) return { error: 'Это объявление уже нельзя снять' };

  listing.status = 'removed';
  listing.reviewedBy = reviewerId;
  listing.reviewedAt = new Date().toISOString();
  listing.rejectReason = reason || null;
  await writeDB(db);

  const seller = db.users.find(u => u.id === listing.sellerId);
  if (seller?.telegramChatId) {
    sendToChat(seller.telegramChatId, `❌ Ваше объявление «${listing.title}» снято администратором.${reason ? '\nПричина: ' + reason : ''}`);
  }
  return { ok: true, listing };
}

// --- Покупка ---

async function buyListing(db, listingId, buyerId) {
  const listing = db.accountListings.find(l => l.id === listingId);
  if (!listing) return { error: 'Объявление не найдено' };
  if (listing.status !== 'active') return { error: 'Это объявление уже недоступно' };
  if (listing.sellerId === buyerId) return { error: 'Нельзя купить собственное объявление' };

  const buyer = db.users.find(u => u.id === buyerId);
  if (!buyer) return { error: 'Пользователь не найден' };
  if ((buyer.balance || 0) < listing.buyerPrice) {
    return { error: 'Недостаточно средств на балансе, пополните баланс' };
  }

  buyer.balance -= listing.buyerPrice;
  listing.status = 'sold';

  const deal = {
    id: uuid(),
    listingId: listing.id,
    gameKey: listing.gameKey,
    gameTitle: listing.gameTitle,
    listingTitle: listing.title,
    sellerId: listing.sellerId,
    buyerId,
    price: listing.buyerPrice, // сколько реально заплатил покупатель (для полного возврата при споре)
    commissionMode: listing.commissionMode,
    commission: listing.commission,
    sellerPayout: listing.sellerPayout, // сколько получит продавец при завершении сделки
    status: 'in_progress', // in_progress -> completed / disputed / cancelled
    credentials: null,
    deliveredAt: null,
    autoCompleteAt: null,
    completedAt: null,
    completedBy: null,
    disputeReason: null,
    disputedBy: null,
    createdAt: new Date().toISOString()
  };
  db.accountDeals.push(deal);
  await writeDB(db);

  const seller = db.users.find(u => u.id === listing.sellerId);
  if (seller?.telegramChatId) {
    sendToChat(seller.telegramChatId, `🛒 Ваш аккаунт «${listing.title}» купили за <b>${deal.price} сомони</b>! После завершения сделки вы получите <b>${deal.sellerPayout} сомони</b> (комиссия гаранта: ${deal.commission} сомони).\nЗайдите в личный кабинет → «Мои сделки» и передайте данные для входа покупателю.`);
  }
  notifyAdmin(`🛒 <b>Продажа аккаунта</b>\n${listing.gameTitle} — ${listing.title}\nПродавец: ${seller?.name || '—'}\nПокупатель: ${buyer.name}\nПокупатель заплатил: ${deal.price} сомони\nПродавец получит: ${deal.sellerPayout} сомони`);

  return { ok: true, deal };
}

// --- Передача данных аккаунта ---

async function deliverCredentials(db, dealId, sellerId, credentials) {
  const deal = db.accountDeals.find(d => d.id === dealId);
  if (!deal) return { error: 'Сделка не найдена' };
  if (deal.sellerId !== sellerId) return { error: 'Нет доступа к этой сделке' };
  if (deal.status !== 'in_progress') return { error: 'Сделка не в статусе ожидания передачи данных' };
  if (!credentials || !credentials.trim()) return { error: 'Укажите логин и пароль от аккаунта' };

  deal.credentials = credentials.trim().slice(0, 2000);
  deal.deliveredAt = new Date().toISOString();
  deal.autoCompleteAt = new Date(Date.now() + AUTO_COMPLETE_HOURS * 60 * 60 * 1000).toISOString();
  await writeDB(db);

  const buyer = db.users.find(u => u.id === deal.buyerId);
  if (buyer?.telegramChatId) {
    sendToChat(buyer.telegramChatId, `📦 Продавец передал данные аккаунта «${deal.listingTitle}». Зайдите в «Мои сделки» на сайте, проверьте доступ и подтвердите получение.\n\n⏳ Если вы не подтвердите и не пожалуетесь в течение 24 часов, сделка завершится автоматически.`);
  }
  return { ok: true, deal };
}

// --- Подтверждение получения ---

async function confirmDeal(db, dealId, actorId, source) {
  const deal = db.accountDeals.find(d => d.id === dealId);
  if (!deal) return { error: 'Сделка не найдена' };
  if (source === 'buyer' && deal.buyerId !== actorId) return { error: 'Нет доступа к этой сделке' };
  if (deal.status !== 'in_progress') return { error: 'Сделку нельзя подтвердить в текущем статусе' };

  const payout = deal.sellerPayout;

  deal.status = 'completed';
  deal.completedAt = new Date().toISOString();
  deal.completedBy = source; // 'buyer' | 'auto' | 'admin'

  const seller = db.users.find(u => u.id === deal.sellerId);
  if (seller) seller.balance = (seller.balance || 0) + payout;
  await writeDB(db);

  if (seller?.telegramChatId) {
    const line = source === 'auto'
      ? `✅ Сделка «${deal.listingTitle}» завершена автоматически (прошло 24 часа без спора). На баланс зачислено <b>${payout} сомони</b>.`
      : `✅ Покупатель подтвердил получение аккаунта «${deal.listingTitle}». На баланс зачислено <b>${payout} сомони</b>.`;
    sendToChat(seller.telegramChatId, line);
  }
  return { ok: true, deal };
}

// --- Спор ---

async function disputeDeal(db, dealId, actorId, reason) {
  const deal = db.accountDeals.find(d => d.id === dealId);
  if (!deal) return { error: 'Сделка не найдена' };
  if (deal.buyerId !== actorId && deal.sellerId !== actorId) return { error: 'Нет доступа к этой сделке' };
  if (deal.status !== 'in_progress') return { error: 'Спор можно открыть только по активной сделке' };
  if (!reason || !reason.trim()) return { error: 'Опишите проблему' };

  deal.status = 'disputed';
  deal.disputeReason = reason.trim().slice(0, 1000);
  deal.disputedBy = actorId === deal.buyerId ? 'buyer' : 'seller';
  await writeDB(db);

  notifyAdmin(
    `⚠️ <b>Спор по сделке</b>\n${deal.gameTitle} — ${deal.listingTitle}\nПокупатель заплатил: ${deal.price} сомони (продавцу причиталось: ${deal.sellerPayout} сомони)\nОткрыл: ${deal.disputedBy === 'buyer' ? 'покупатель' : 'продавец'}\nПричина: ${deal.disputeReason}\nРазберите в админ-панели: вкладка «Споры»`
  );
  return { ok: true, deal };
}

// Спор решён в пользу покупателя — деньги возвращаются ему на баланс
async function resolveDisputeToBuyer(db, dealId, reviewerId) {
  const deal = db.accountDeals.find(d => d.id === dealId);
  if (!deal) return { error: 'Сделка не найдена' };
  if (deal.status !== 'disputed') return { error: 'Эта сделка не в статусе спора' };

  deal.status = 'cancelled';
  deal.completedAt = new Date().toISOString();
  deal.completedBy = 'admin';
  const buyer = db.users.find(u => u.id === deal.buyerId);
  if (buyer) buyer.balance = (buyer.balance || 0) + deal.price;
  await writeDB(db);

  if (buyer?.telegramChatId) {
    sendToChat(buyer.telegramChatId, `↩️ Спор по сделке «${deal.listingTitle}» решён в вашу пользу. ${deal.price} сомони возвращены на баланс.`);
  }
  const seller = db.users.find(u => u.id === deal.sellerId);
  if (seller?.telegramChatId) {
    sendToChat(seller.telegramChatId, `⚠️ Спор по сделке «${deal.listingTitle}» решён в пользу покупателя. Выплата отменена.`);
  }
  return { ok: true, deal };
}

// Спор решён в пользу продавца — деньги зачисляются ему как обычно
async function resolveDisputeToSeller(db, dealId, reviewerId) {
  const deal = db.accountDeals.find(d => d.id === dealId);
  if (!deal) return { error: 'Сделка не найдена' };
  if (deal.status !== 'disputed') return { error: 'Эта сделка не в статусе спора' };

  const payout = deal.sellerPayout;

  deal.status = 'completed';
  deal.completedAt = new Date().toISOString();
  deal.completedBy = 'admin';
  const seller = db.users.find(u => u.id === deal.sellerId);
  if (seller) seller.balance = (seller.balance || 0) + payout;
  await writeDB(db);

  if (seller?.telegramChatId) {
    sendToChat(seller.telegramChatId, `✅ Спор по сделке «${deal.listingTitle}» решён в вашу пользу. ${payout} сомони зачислены на баланс.`);
  }
  const buyer = db.users.find(u => u.id === deal.buyerId);
  if (buyer?.telegramChatId) {
    sendToChat(buyer.telegramChatId, `⚠️ Спор по сделке «${deal.listingTitle}» решён в пользу продавца.`);
  }
  return { ok: true, deal };
}

// Автозавершение сделок, где прошло 24 часа с момента передачи данных,
// а покупатель не подтвердил и не пожаловался. НИКАКИХ поддельных отзывов —
// только перевод денег продавцу, как на любом обычном маркетплейсе.
// Вызывается "лениво" при чтении списков сделок — отдельного планировщика
// (cron) на бесплатном хостинге нет, а такой подход не требует его.
async function sweepAutoCompleteDeals(db) {
  const now = Date.now();
  const due = db.accountDeals.filter(d =>
    d.status === 'in_progress' && d.autoCompleteAt && new Date(d.autoCompleteAt).getTime() <= now
  );
  for (const deal of due) {
    await confirmDeal(db, deal.id, null, 'auto');
  }
  return due.length;
}

module.exports = {
  removeListingByAdmin,
  buyListing, deliverCredentials, confirmDeal, disputeDeal,
  resolveDisputeToBuyer, resolveDisputeToSeller,
  sweepAutoCompleteDeals
};
