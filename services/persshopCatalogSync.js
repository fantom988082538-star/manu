// Синхронизация каталога Pers Shop → отдельная таблица db.supplierGames.
// НЕ трогает data/games.json (старые статические игры) вообще.
// НЕ удаляет и не затирает ручные поля админа (customTitle/customDescription/
// customImage/published/active/sortOrder на уровне игры, customTitle/customPrice/
// markup/active/sortOrder на уровне номинала) — обновляет только supplier*-поля.
// См. ТЗ п.3–6.

const { readDB, writeDB } = require('./db');
const persshop = require('./persshop');

const PAGE_LIMIT = 100;
// У Pers Shop лимит 120 запросов/мин на ключ. Берём с запасом (100/мин),
// чтобы оставалось место для запросов баланса/статуса, которые админка
// может слать параллельно, пока синхронизация ещё идёт.
const REQUEST_DELAY_MS = 600;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAllCategories() {
  const categories = [];
  let offset = 0;
  for (;;) {
    const data = await persshop.getCatalogPage({ limit: PAGE_LIMIT, offset });
    const page = data.categories || data.items || data.data || [];
    if (offset === 0) {
      // Форма ответа /catalog не была на 100% подтверждена документацией —
      // логируем начало первого ответа, чтобы можно было сверить при первом
      // реальном запуске синхронизации.
      console.log('[persshop sync] пример ответа GET /catalog:', JSON.stringify(data).slice(0, 500));
    }
    categories.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    if (offset > 5000) {
      console.warn('[persshop sync] остановка пагинации на offset > 5000 — проверьте формат ответа API');
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return categories;
}

// Прогресс текущей синхронизации — в памяти процесса. При 1850+ категориях
// и паузах между запросами синхронизация занимает 15-20+ минут, поэтому она
// не может идти в рамках одного HTTP-запроса от админки (браузер/nginx оборвут
// по таймауту). Админка запускает её и опрашивает этот прогресс отдельно
// (см. GET /api/admin/supplier/status → syncProgress).
let syncProgress = { running: false, startedAt: null, categoriesSeen: 0, totalCategories: 0 };
function getSyncProgress() {
  return syncProgress;
}

async function syncCatalog() {
  if (syncProgress.running) {
    throw new Error('Синхронизация уже идёт, дождитесь её завершения');
  }
  syncProgress = { running: true, startedAt: new Date().toISOString(), categoriesSeen: 0, totalCategories: 0 };

  const summary = { categoriesSeen: 0, created: 0, updated: 0, markedUnavailable: 0, skippedSteam: 0, errors: [] };
  try {
    const db = await readDB();
    if (!db.supplierGames) db.supplierGames = [];
    if (!db.settings) db.settings = {};

    let categoriesList;
    try {
      categoriesList = await fetchAllCategories();
    } catch (e) {
      const message = e.response?.data?.error || e.message;
      db.settings.persshop = { ...(db.settings.persshop || {}), lastSyncAt: new Date().toISOString(), lastSyncError: message };
      await writeDB(db);
      throw new Error(`Не удалось получить каталог Pers Shop: ${message}`);
    }
    syncProgress.totalCategories = categoriesList.length;

    const seenIds = new Set();

    for (const cat of categoriesList) {
    summary.categoriesSeen++;
    syncProgress.categoriesSeen = summary.categoriesSeen;
    let full;
    try {
      full = await persshop.getCategory(cat.id);
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'rate_limited') {
        // Слишком быстро — притормаживаем и пробуем этот же товар ещё раз,
        // а не просто теряем его с ошибкой.
        await sleep(3000);
        try {
          full = await persshop.getCategory(cat.id);
        } catch (e2) {
          summary.errors.push({ categoryId: cat.id, error: e2.response?.data?.error || e2.message });
          await sleep(REQUEST_DELAY_MS);
          continue;
        }
      } else {
        summary.errors.push({ categoryId: cat.id, error: e.response?.data?.error || e.message });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
    }
    await sleep(REQUEST_DELAY_MS);

    if (full.steamTopup) {
      // Пополнение Steam устроено иначе (сумма в USD + логин, без offerId) —
      // отдельная механика заказа, в эту синхронизацию не входит.
      summary.skippedSteam++;
      continue;
    }

    const recordId = `persshop:${full.id}`;
    seenIds.add(recordId);
    let record = db.supplierGames.find(g => g.id === recordId);
    if (!record) {
      record = {
        id: recordId,
        provider: 'persshop',
        categoryId: full.id,
        customTitle: null,
        customDescription: null,
        customImage: null,
        active: false,    // новый товар не публикуется сам — админ включает вручную (ТЗ п.4)
        published: false,
        sortOrder: 0,
        offers: [],
        createdAt: new Date().toISOString()
      };
      db.supplierGames.push(record);
      summary.created++;
    } else {
      summary.updated++;
    }

    // supplier*-поля — перезаписываем всегда, это данные поставщика, не наши ручные
    record.supplierTitle = full.title;
    record.kind = full.kind;
    record.supplierFields = full.fields || [];
    record.idCheckField = full.idCheckField || null;
    record.unsupportedFields = (full.fields || []).length > 2;
    record.supplierAvailable = true;
    record.lastSyncedAt = new Date().toISOString();

    const incomingOffers = full.offers || [];
    const incomingIds = new Set(incomingOffers.map(o => o.offerId));

    for (const off of incomingOffers) {
      let existingOffer = record.offers.find(o => o.offerId === off.offerId);
      if (!existingOffer) {
        existingOffer = { offerId: off.offerId, customTitle: null, customPrice: null, markup: 0, active: true, sortOrder: 0 };
        record.offers.push(existingOffer);
      }
      existingOffer.supplierTitle = off.title;
      existingOffer.supplierPriceTjs = off.priceTjs;
      existingOffer.supplierRetailPriceTjs = off.retailPriceTjs;
      existingOffer.supplierAvailable = true;
    }
    // Номиналы, пропавшие у поставщика, — НЕ удаляем, просто гасим доступность (ТЗ п.6)
    for (const off of record.offers) {
      if (!incomingIds.has(off.offerId)) off.supplierAvailable = false;
    }
  }

  // Категории, пропавшие у поставщика целиком, — тоже не удаляем
  for (const record of db.supplierGames) {
    if (record.provider === 'persshop' && !seenIds.has(record.id)) {
      if (record.supplierAvailable !== false) summary.markedUnavailable++;
      record.supplierAvailable = false;
    }
  }

    db.settings.persshop = {
      ...(db.settings.persshop || {}),
      lastSyncAt: new Date().toISOString(),
      lastSyncError: null,
      lastSyncSummary: summary
    };
    await writeDB(db);
    return summary;
  } finally {
    syncProgress.running = false;
  }
}

// Запуск синхронизации в фоне — не блокирует HTTP-ответ админке (при 1000+
// категориях полная синхронизация занимает 15-20+ минут, дольше таймаута
// браузера/nginx). Ошибку тоже сохраняем в settings.persshop.lastSyncError,
// чтобы админка увидела её через GET /admin/supplier/status, а не потеряла.
function startSyncInBackground() {
  if (syncProgress.running) {
    throw new Error('Синхронизация уже идёт, дождитесь её завершения');
  }
  syncCatalog().catch(async (e) => {
    try {
      const db = await readDB();
      db.settings.persshop = { ...(db.settings.persshop || {}), lastSyncAt: new Date().toISOString(), lastSyncError: e.message };
      await writeDB(db);
    } catch (e2) {
      console.error('[persshop sync] не удалось сохранить ошибку синхронизации:', e2.message);
    }
  });
}

// --- Преобразование в формат, который уже понимает старый фронтенд (db.games) ---

function computeOfferPrice(offer) {
  if (offer.customPrice != null) return offer.customPrice;
  const markup = offer.markup || 0;
  return Math.round((offer.supplierPriceTjs || 0) * (1 + markup / 100) * 100) / 100;
}

function toLegacyGameShape(record) {
  const fields = record.supplierFields || [];
  const offers = (record.offers || [])
    .filter(o => o.active !== false && o.supplierAvailable !== false)
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  return {
    key: record.id,
    title: record.customTitle || record.supplierTitle,
    image: record.customImage || null,
    description: record.customDescription || null,
    provider: 'persshop',
    categoryId: record.categoryId,
    needsServer: fields.length > 1,
    idLabel: fields[0]?.label || 'ID',
    idPlaceholder: '',
    serverLabel: fields[1]?.label || 'Сервер',
    serverPlaceholder: '',
    supplierFieldKeys: fields.map(f => f.key),
    idCheckField: record.idCheckField || null,
    pricingType: 'fixed',
    packs: offers.map(o => ({
      id: o.offerId,
      label: o.customTitle || o.supplierTitle,
      price: computeOfferPrice(o),
      denom: ''
    }))
  };
}

function isPubliclyVisible(record) {
  return record.published !== false && record.active !== false &&
    record.supplierAvailable !== false && !record.unsupportedFields &&
    (record.offers || []).some(o => o.active !== false && o.supplierAvailable !== false);
}

module.exports = { syncCatalog, startSyncInBackground, getSyncProgress, toLegacyGameShape, isPubliclyVisible, computeOfferPrice };
