require('dotenv').config();
const path = require('path');
const express = require('express');
require('express-async-errors'); // см. пояснение ниже — критичный фикс стабильности
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhook');
const topupsRoutes = require('./routes/topups');
const reviewsRoutes = require('./routes/reviews');
const withdrawalsRoutes = require('./routes/withdrawals');
const promocodesRoutes = require('./routes/promocodes');
const referralsRoutes = require('./routes/referrals');
const telegramRoutes = require('./routes/telegram');
const settingsRoutes = require('./routes/settings');
const statsRoutes = require('./routes/stats');
const listingsRoutes = require('./routes/listings');
const dealsRoutes = require('./routes/deals');
const { readDB, writeDB } = require('./services/db');
const { v4: uuid } = require('uuid');

const app = express();

// Render (и большинство хостингов) работают через свой прокси.
// Без этой строки Express видит IP прокси у ВСЕХ посетителей одинаково,
// из-за чего лимит запросов (rate limit) считается на всех разом, а не по-отдельности.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());

// Фото объявлений — публичные картинки маркетплейса, отдаём напрямую с диска.
// helmet() по умолчанию запрещает загрузку ресурсов с другого домена
// (Cross-Origin-Resource-Policy: same-origin) — а сайт живёт на Netlify,
// картинки отдаём с api.manushop.store, это РАЗНЫЕ домены. Без явного
// разрешения ниже браузер тихо блокировал бы показ фото.
// Чеки пополнений (uploads/receipts) СЮДА НЕ включены и статикой не раздаются —
// это платёжные данные, доступны только через авторизованный админ-эндпоинт
// в routes/topups.js, не напрямую по URL.
app.use('/uploads/listings', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads', 'listings')));

// Вебхуку нужно "сырое" тело для проверки подписи — подключаем ДО express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use(limiter);

// ВАЖНО: строгий лимит (20/15мин) применяется ТОЛЬКО к чувствительным
// эндпоинтам входа/регистрации (защита от подбора пароля) — сам лимит
// теперь настроен внутри routes/auth.js на конкретные /register, /login,
// /google. Раньше он стоял на ВЕСЬ префикс /api/auth целиком, из-за чего
// под него попадал и /api/auth/me — а это запрос "кто я / какой баланс",
// который сайт дёргает при КАЖДОЙ загрузке страницы. 20 переходов по
// сайту — и всё, блокировка на 15 минут для самого частого запроса.

app.use('/api/auth', authRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/topups', topupsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/withdrawals', withdrawalsRoutes);
app.use('/api/promocodes', promocodesRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/deals', dealsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

async function bootstrapSuperAdmin() {
  if (!process.env.ADMIN_PHONE || !process.env.ADMIN_PASSWORD) {
    console.warn('[bootstrap] ADMIN_PHONE / ADMIN_PASSWORD не заданы в .env — супер-админ не создан');
    return;
  }
  const db = await readDB();
  const exists = db.users.find(u => u.phone === process.env.ADMIN_PHONE);
  if (exists) return;
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  db.users.push({
    id: uuid(),
    name: 'Manu (Super Admin)',
    phone: process.env.ADMIN_PHONE,
    passwordHash,
    role: 'super_admin',
    balance: 0,
    createdAt: new Date().toISOString()
  });
  await writeDB(db);
  console.log(`[bootstrap] Супер-админ создан: ${process.env.ADMIN_PHONE}`);
}

const PORT = process.env.PORT || 4000;

// Страховка на случай ошибки ВНЕ обычного запроса (например, "запустил и
// не жду" вызов в Telegram — sendToChat/notifyAdmin не всегда ожидаются
// через await). Без этого такая ошибка в Node 22 роняет ВЕСЬ процесс
// целиком — не один запрос, а сайт полностью, пока PM2 не поднимет заново.
// Логируем и продолжаем работать вместо падения.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

bootstrapSuperAdmin()
  .then(() => {
    app.listen(PORT, () => console.log(`ManuShop API запущен на порту ${PORT}`));
  })
  .catch((e) => {
    console.error('[bootstrap] Не удалось запустить сервер:', e.message);
    process.exit(1);
  });
