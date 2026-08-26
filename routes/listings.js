const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { readDB, writeDB, saveListingPhotos, loadListingPhotos, deleteListingPhotos } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdmin } = require('../services/telegram');
const { removeListingByAdmin } = require('../services/listingActions');

const router = express.Router();

// Лимит 20 фото — не прихоть, а защита от падения бесплатного тарифа Render:
// multer держит все файлы запроса в оперативной памяти во время загрузки,
// и слишком много файлов разом может её исчерпать и уронить сервер.
// Сами фото хранятся в ОТДЕЛЬНОЙ коллекции Mongo (см. services/db.js) —
// поэтому большое количество фото не бьёт по лимиту в 16 МБ на документ,
// который иначе сломал бы запись в базу для всего сайта.
const MAX_PHOTOS = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 МБ на файл
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Разрешены только изображения (jpg, png, webp)'), ok);
  }
});

// ВАЖНО: multer-мидлвар должен сам поймать свою ошибку и вернуть JSON —
// если этого не сделать явно, Express 4 не перехватывает такие ошибки
// автоматически, и фронтенд получает нечитаемый (не-JSON) ответ вместо
// понятного сообщения. Это и была причина "ошибки отправки".
function uploadListingPhotos(req, res, next) {
  upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Каждое фото должно быть меньше 2 МБ'
        : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Максимум ${MAX_PHOTOS} фото за раз`
        : err.message || 'Не удалось загрузить фото';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// Публичные поля объявления БЕЗ фото — фото отдаём отдельно (см. ниже),
// чтобы список объявлений не тянул мегабайты картинок разом.
function publicListingSummary(listing, db) {
  const seller = db.users.find(u => u.id === listing.sellerId);
  return {
    id: listing.id,
    gameKey: listing.gameKey,
    gameTitle: listing.gameTitle,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    buyerPrice: listing.buyerPrice,
    sellerPayout: listing.sellerPayout,
    commission: listing.commission,
    commissionMode: listing.commissionMode,
    photoCount: listing.photoCount || 0,
    status: listing.status,
    sellerName: seller?.name || 'Продавец',
    createdAt: listing.createdAt
  };
}

// Считаем, сколько заплатит покупатель и сколько получит продавец —
// в зависимости от того, кто платит комиссию гаранта. Продавец выбирает
// режим при создании объявления, значения фиксируются НАВСЕГДА на этом
// объявлении (даже если админ потом поменяет размер комиссии в настройках —
// уже опубликованные объявления не должны "плыть" в цене).
function computeCommissionSplit(price, mode, commission) {
  if (mode === 'buyer') {
    return { buyerPrice: price + commission, sellerPayout: price, commission, commissionMode: mode };
  }
  if (mode === 'split') {
    const half = commission / 2;
    return { buyerPrice: price + half, sellerPayout: Math.max(0, price - half), commission, commissionMode: mode };
  }
  // 'seller' (по умолчанию) — покупатель платит цену как есть, комиссия вычитается из выплаты продавцу
  return { buyerPrice: price, sellerPayout: Math.max(0, price - commission), commission, commissionMode: 'seller' };
}

// --- Список игр, доступных для продажи (управляется админом) ---
router.get('/games', async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.settings.listingGames || []);
  } catch (e) {
    console.error('[listings] GET /games', e);
    res.status(500).json({ error: 'Не удалось загрузить список игр' });
  }
});

// --- Создать объявление (нужен вход). Публикуется СРАЗУ, без модерации. ---
router.post('/', requireAuth, uploadListingPhotos, async (req, res) => {
  try {
    const { gameKey, title, description, price, commissionMode } = req.body;
    const priceNum = Number(price);
    const mode = ['seller', 'buyer', 'split'].includes(commissionMode) ? commissionMode : 'seller';

    const db = await readDB();
    const game = (db.settings.listingGames || []).find(g => g.key === gameKey);
    if (!game) return res.status(400).json({ error: 'Эта игра недоступна для продажи аккаунтов' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'Укажите название объявления' });
    if (!priceNum || priceNum <= 0) return res.status(400).json({ error: 'Укажите цену' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Прикрепите хотя бы одно фото аккаунта' });

    const photos = req.files.map(f => `data:${f.mimetype};base64,${f.buffer.toString('base64')}`);
    const commissionAmount = (db.settings && db.settings.guarantorCommission) || 0;
    const split = computeCommissionSplit(priceNum, mode, commissionAmount);

    const listing = {
      id: uuid(),
      sellerId: req.user.id,
      gameKey,
      gameTitle: game.title,
      title: title.trim().slice(0, 120),
      description: (description || '').trim().slice(0, 2000),
      price: priceNum,
      ...split,
      photoCount: photos.length,
      status: 'active', // публикуется сразу
      reviewedBy: null,
      reviewedAt: null,
      rejectReason: null,
      createdAt: new Date().toISOString()
    };
    db.accountListings.push(listing);
    await writeDB(db);
    await saveListingPhotos(listing.id, photos); // отдельная коллекция — см. комментарий выше

    const seller = db.users.find(u => u.id === req.user.id);
    notifyAdmin(
      `🎮 <b>Новое объявление опубликовано</b>\n` +
      `${listing.gameTitle} — ${listing.title}\n` +
      `Покупатель заплатит: <b>${listing.buyerPrice} сомони</b> (продавец получит ${listing.sellerPayout})\n` +
      `Продавец: ${seller?.name || '—'} (${seller?.phone || '—'})\n` +
      `Публикуется автоматически. Вкладка «Объявления» в админке — если нужно снять.`
    );

    res.json({ ...publicListingSummary(listing, db), photos });
  } catch (e) {
    console.error('[listings] POST /', e);
    res.status(500).json({ error: 'Не удалось создать объявление, попробуйте ещё раз' });
  }
});

// --- Публичный список (только активные, БЕЗ фото — см. /:id/photos) ---
router.get('/', async (req, res) => {
  try {
    const db = await readDB();
    let list = db.accountListings.filter(l => l.status === 'active');
    if (req.query.gameKey) list = list.filter(l => l.gameKey === req.query.gameKey);
    res.json(list.reverse().map(l => publicListingSummary(l, db)));
  } catch (e) {
    console.error('[listings] GET /', e);
    res.status(500).json({ error: 'Не удалось загрузить объявления' });
  }
});

// --- Мои объявления (все статусы, без фото) ---
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const mine = db.accountListings.filter(l => l.sellerId === req.user.id).reverse();
    res.json(mine);
  } catch (e) {
    console.error('[listings] GET /mine', e);
    res.status(500).json({ error: 'Не удалось загрузить объявления' });
  }
});

// --- Одно объявление (метаданные, без фото — фото см. /:id/photos) ---
router.get('/:id', async (req, res) => {
  try {
    const db = await readDB();
    const listing = db.accountListings.find(l => l.id === req.params.id);
    if (!listing) return res.status(404).json({ error: 'Объявление не найдено' });

    if (listing.status !== 'active') {
      const header = req.headers.authorization;
      let userId = null;
      let role = null;
      if (header && header.startsWith('Bearer ')) {
        try {
          const jwt = require('jsonwebtoken');
          const payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
          userId = payload.id;
          role = payload.role;
        } catch (e) { /* не залогинен / токен невалиден — считаем как гостя */ }
      }
      const isAdmin = ['super_admin', 'checker_admin'].includes(role);
      if (userId !== listing.sellerId && !isAdmin) return res.status(404).json({ error: 'Объявление не найдено' });
    }
    res.json(publicListingSummary(listing, db));
  } catch (e) {
    console.error('[listings] GET /:id', e);
    res.status(500).json({ error: 'Не удалось загрузить объявление' });
  }
});

// --- Фото объявления — отдельным запросом (любое количество, не тормозит список) ---
router.get('/:id/photos', async (req, res) => {
  try {
    const db = await readDB();
    const listing = db.accountListings.find(l => l.id === req.params.id);
    if (!listing) return res.status(404).json({ error: 'Объявление не найдено' });
    const photos = await loadListingPhotos(req.params.id);
    res.json({ photos });
  } catch (e) {
    console.error('[listings] GET /:id/photos', e);
    res.status(500).json({ error: 'Не удалось загрузить фото' });
  }
});

// --- Продавец снимает своё объявление с публикации ---
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const listing = db.accountListings.find(l => l.id === req.params.id);
    if (!listing) return res.status(404).json({ error: 'Объявление не найдено' });
    if (listing.sellerId !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    if (listing.status !== 'active') {
      return res.status(409).json({ error: 'Это объявление уже нельзя снять' });
    }
    listing.status = 'removed';
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    console.error('[listings] DELETE /:id', e);
    res.status(500).json({ error: 'Не удалось снять объявление' });
  }
});

// --- Админ: список объявлений (без фото — см. /admin/:id/photos) ---
router.get('/admin/list', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    const status = req.query.status || 'active';
    const list = db.accountListings
      .filter(l => status === 'all' || l.status === status)
      .reverse()
      .map(l => {
        const seller = db.users.find(u => u.id === l.sellerId);
        return { ...l, sellerName: seller?.name, sellerPhone: seller?.phone };
      });
    res.json(list);
  } catch (e) {
    console.error('[listings] GET /admin/list', e);
    res.status(500).json({ error: 'Не удалось загрузить список' });
  }
});

router.get('/admin/:id/photos', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    const listing = db.accountListings.find(l => l.id === req.params.id);
    if (!listing) return res.status(404).json({ error: 'Объявление не найдено' });
    const photos = await loadListingPhotos(req.params.id);
    res.json({ photos });
  } catch (e) {
    console.error('[listings] GET /admin/:id/photos', e);
    res.status(500).json({ error: 'Не удалось загрузить фото' });
  }
});

router.post('/admin/:id/remove', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const db = await readDB();
    const result = await removeListingByAdmin(db, req.params.id, req.user.id, reason);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[listings] POST /admin/:id/remove', e);
    res.status(500).json({ error: 'Не удалось снять объявление' });
  }
});

// --- Админ: управление списком игр, доступных для продажи ---
router.get('/admin/games', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.settings.listingGames || []);
  } catch (e) {
    console.error('[listings] GET /admin/games', e);
    res.status(500).json({ error: 'Не удалось загрузить список игр' });
  }
});

router.post('/admin/games', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const { key, title } = req.body;
    if (!key || !key.trim() || !title || !title.trim()) {
      return res.status(400).json({ error: 'Укажите key и title' });
    }
    const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanKey) return res.status(400).json({ error: 'Некорректный key (латиница/цифры)' });

    const db = await readDB();
    if (!db.settings.listingGames) db.settings.listingGames = [];
    if (db.settings.listingGames.some(g => g.key === cleanKey)) {
      return res.status(409).json({ error: 'Игра с таким key уже есть' });
    }
    db.settings.listingGames.push({ key: cleanKey, title: title.trim() });
    await writeDB(db);
    res.json(db.settings.listingGames);
  } catch (e) {
    console.error('[listings] POST /admin/games', e);
    res.status(500).json({ error: 'Не удалось добавить игру' });
  }
});

router.delete('/admin/games/:key', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    db.settings.listingGames = (db.settings.listingGames || []).filter(g => g.key !== req.params.key);
    await writeDB(db);
    res.json(db.settings.listingGames);
  } catch (e) {
    console.error('[listings] DELETE /admin/games/:key', e);
    res.status(500).json({ error: 'Не удалось удалить игру' });
  }
});

module.exports = router;
