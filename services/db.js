// Хранилище на SQLite — локальный файл на диске VPS, без внешней сети.
//
// ПОЧЕМУ ПЕРЕШЛИ С MONGODB: MongoDB Atlas оказался ненадёжен именно с этого
// VPS (DNS/сеть до кластера то работали, то зависали намертво без единой
// ошибки в логах) — вместо продолжения борьбы с непонятной сетевой
// проблемой перенесли данные на локальный файл, который вообще не зависит
// от внешней сети.
//
// АРХИТЕКТУРА: одна таблица на каждую "коллекцию" (users, orders, topups
// и т.д.), в каждой — id (для быстрого поиска/уникальности) и весь объект
// целиком как JSON в поле data. Это НЕ полная нормализация с внешними
// ключами — сделано специально просто, чтобы readDB()/writeDB() отдавали
// и принимали ТОЧНО ТАКОЙ ЖЕ объект, как раньше с MongoDB, и весь
// остальной код (routes/*, services/actions.js, services/listingActions.js)
// продолжает работать без единой правки — он как обращался к db.users,
// db.orders.push(...) и т.д., так и обращается.
//
// Файл базы: /var/www/manushop-backend/data/database.sqlite — создаётся
// автоматически при первом запуске, переживает pm2 restart, reboot VPS,
// npm install и обновления кода (он не в git, см. .gitignore).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // надёжнее при частых записях, меньше риск повреждения при обрыве

// Каждая "коллекция" — своя таблица: id TEXT PRIMARY KEY + весь объект как JSON
const COLLECTIONS = [
  'users', 'orders', 'topups', 'reviews', 'withdrawals',
  'promocodes', 'telegramLinkCodes', 'accountListings', 'accountDeals',
  'supplierGames', // каталог, синхронизированный с Pers Shop — см. services/persshopCatalogSync.js
  'games' // старые статичные игры (Free Fire/PUBG/MLBB и т.д.) — раньше жили в data/games.json
];

// У большинства коллекций первичный ключ — item.id. У игр исторически это
// item.key (так было в data/games.json) — не переименовываем существующее
// поле по всему коду, просто используем его как id при записи в БД.
const ID_FIELD = { games: 'key' };

for (const name of COLLECTIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);

const DEFAULT_SETTINGS = {
  referralBonusAmount: 10,
  topupBonusTiers: [
    { minAmount: 50, bonus: 5 },
    { minAmount: 200, bonus: 10 },
    { minAmount: 500, bonus: 30 }
  ],
  vipTiers: [
    { minSpent: 500, discountPercent: 5, label: 'Постоянный клиент' },
    { minSpent: 1500, discountPercent: 10, label: 'VIP' }
  ],
  firstOrderDiscountEnabled: true,
  firstOrderDiscountPercent: 5,
  listingGames: [
    { key: 'ff', title: 'Free Fire' },
    { key: 'pubg', title: 'PUBG Mobile' },
    { key: 'mlbb', title: 'Mobile Legends' },
    { key: 'delta', title: 'Delta Force (PC и Mobile)' },
    { key: 'standoff2', title: 'Standoff 2' },
    { key: 'roblox', title: 'Roblox' }
  ],
  guarantorCommission: 10,
  persshop: {
    webhookSecret: null,
    webhookUrl: null,
    lastSyncAt: null,
    lastSyncError: null,
    lastSyncSummary: null
  }
};

// При первом запуске — создаём строку настроек по умолчанию (IF NOT EXISTS-подобная логика)
const settingsExists = db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
if (!settingsExists) {
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
}

// ИСПРАВЛЕНИЕ ИЗВЕСТНОГО БАГА: раньше игры (Free Fire/PUBG/MLBB и т.д.) читались
// напрямую из файла data/games.json при каждом запросе и НИКОГДА не сохранялись
// обратно — из-за этого правки цен пропадали после перезапуска сервера, а
// удаление игры не работало вообще (следующий же запрос снова подгружал
// исходный файл). Теперь игры — обычная таблица в БД, как всё остальное.
// Переносим содержимое data/games.json в БД РОВНО ОДИН РАЗ, при первом запуске
// после этого обновления — если в таблице games уже что-то есть, не трогаем.
const gamesCountRow = db.prepare('SELECT COUNT(*) as c FROM games').get();
if (gamesCountRow.c === 0) {
  const staticGames = require('../data/games.json');
  const insertGame = db.prepare('INSERT INTO games (id, data) VALUES (?, ?)');
  for (const g of staticGames) {
    insertGame.run(g.key, JSON.stringify(g));
  }
}

async function readDB() {
  const result = {};
  for (const name of COLLECTIONS) {
    const rows = db.prepare(`SELECT data FROM ${name}`).all();
    result[name] = rows.map(r => JSON.parse(r.data));
  }

  const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  result.settings = settingsRow ? JSON.parse(settingsRow.data) : { ...DEFAULT_SETTINGS };

  // Те же fallback-заглушки, что были раньше — на случай если база создавалась
  // давно и в ней ещё нет каких-то новых полей настроек.
  if (!result.settings.topupBonusTiers) result.settings.topupBonusTiers = DEFAULT_SETTINGS.topupBonusTiers;
  if (!result.settings.vipTiers) result.settings.vipTiers = DEFAULT_SETTINGS.vipTiers;
  if (result.settings.firstOrderDiscountEnabled === undefined) result.settings.firstOrderDiscountEnabled = true;
  if (result.settings.firstOrderDiscountPercent === undefined) result.settings.firstOrderDiscountPercent = 5;
  if (!result.settings.listingGames) result.settings.listingGames = DEFAULT_SETTINGS.listingGames;
  if (result.settings.guarantorCommission === undefined) result.settings.guarantorCommission = 10;
  if (!result.settings.persshop) result.settings.persshop = { ...DEFAULT_SETTINGS.persshop };

  return result;
}

// Перезаписывает КАЖДУЮ таблицу целиком тем, что передали — ровно то же
// поведение, что раньше было через MongoDB $set на весь документ разом.
// Всё в одной транзакции: либо применится всё, либо (при сбое) не применится
// ничего — база не может остаться в "наполовину записанном" состоянии.
const writeTxn = db.transaction((data) => {
  for (const name of COLLECTIONS) {
    db.prepare(`DELETE FROM ${name}`).run();
    const insert = db.prepare(`INSERT INTO ${name} (id, data) VALUES (?, ?)`);
    const idField = ID_FIELD[name] || 'id';
    for (const item of (data[name] || [])) {
      insert.run(item[idField], JSON.stringify(item));
    }
  }
  db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data.settings || DEFAULT_SETTINGS));
});

async function writeDB(data) {
  writeTxn(data);
}

// Точечная запись — обновляет ТОЛЬКО перечисленные коллекции, остальные
// таблицы вообще не трогает. Нужна для долгих фоновых операций (синхронизация
// каталога Pers Shop держит данные в памяти ~20 минут) — обычный writeDB()
// переписал бы ВСЮ базу устаревшим снимком и стёр бы заказы/пополнения,
// случившиеся за это время. См. services/persshopCatalogSync.js.
const writeCollectionsTxn = db.transaction((partial) => {
  for (const name of Object.keys(partial)) {
    if (!COLLECTIONS.includes(name)) continue;
    db.prepare(`DELETE FROM ${name}`).run();
    const insert = db.prepare(`INSERT INTO ${name} (id, data) VALUES (?, ?)`);
    const idField = ID_FIELD[name] || 'id';
    for (const item of partial[name]) {
      insert.run(item[idField], JSON.stringify(item));
    }
  }
});
async function writeCollections(partial) {
  writeCollectionsTxn(partial);
}

// Точечное обновление настроек Pers Shop (lastSyncAt/webhookSecret/...) —
// перечитывает настройки заново и меняет только ключ persshop, остальные
// поля settings (VIP-уровни, бонусы и т.д.), даже если их кто-то поменял
// параллельно, не трогает.
async function updatePersshopSettings(patch) {
  const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  const current = settingsRow ? JSON.parse(settingsRow.data) : { ...DEFAULT_SETTINGS };
  current.persshop = { ...(current.persshop || {}), ...patch };
  db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(current));
  return current.persshop;
}

module.exports = { readDB, writeDB, writeCollections, updatePersshopSettings };
