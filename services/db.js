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
  'promocodes', 'telegramLinkCodes', 'accountListings', 'accountDeals'
];

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
  guarantorCommission: 10
};

// При первом запуске — создаём строку настроек по умолчанию (IF NOT EXISTS-подобная логика)
const settingsExists = db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
if (!settingsExists) {
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
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

  result.games = require('../data/games.json');
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
    for (const item of (data[name] || [])) {
      insert.run(item.id, JSON.stringify(item));
    }
  }
  db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data.settings || DEFAULT_SETTINGS));
});

async function writeDB(data) {
  writeTxn(data);
}

module.exports = { readDB, writeDB };
