// Проверка ника Free Fire по UID.
//
// Источник: HL Gaming Official — единственный найденный сервис, который
// реально бесплатен (без оплаты, без карты). Лимит: 25 запросов/сутки НА
// АККАУНТ. Получение ключа: https://www.hlgamingofficial.com/p/api.html
//
// (Раньше здесь стоял Free Fire Community API — оказалось, что их
// "Trial Pass" не бесплатный, а разовая оплата $1 за 500 запросов.
// Убрали его, чтобы не платить за то, что должно быть бесплатным.)
//
// ПОДДЕРЖКА НЕСКОЛЬКИХ АККАУНТОВ: если добавить в .env второй набор
// ключей (HL_GAMING_USERUID_2 / HL_GAMING_API_KEY_2), код автоматически
// переключится на него, как только первый аккаунт исчерпает свой
// дневной лимит. По официальной документации HL Gaming, лимит исчерпан —
// это КОНКРЕТНО HTTP 429 с телом {"error":"Quota exceeded."}, поэтому
// переключаемся только на эту ошибку, а не на любую другую (иначе можно
// зря спалить лимит второго аккаунта из-за обычного сбоя сервиса).
//
// Если вообще ни один аккаунт не настроен — функция бросает ошибку с
// кодом NO_API_KEY, роут games.js превращает это в понятный ответ
// («проверка не настроена»), а не врёт про игрока.

const axios = require('axios');

const BASE_URL = 'https://proapis.hlgamingofficial.com/main/games/freefire/validation/api';

// Перебираем регионы по порядку, пока один не подтвердит игрока —
// мы не знаем точно, к какому региону Garena относит таджикские аккаунты.
const REGIONS = ['CIS', 'ME', 'PK', 'IND', 'BD', 'RU', 'BR', 'SG', 'ID', 'TW', 'US', 'VN', 'TH'];

const client = axios.create({ timeout: 15000 });

function loadAccounts() {
  const accounts = [];
  if (process.env.HL_GAMING_USERUID && process.env.HL_GAMING_API_KEY) {
    accounts.push({ label: '1', useruid: process.env.HL_GAMING_USERUID, apiKey: process.env.HL_GAMING_API_KEY });
  }
  if (process.env.HL_GAMING_USERUID_2 && process.env.HL_GAMING_API_KEY_2) {
    accounts.push({ label: '2', useruid: process.env.HL_GAMING_USERUID_2, apiKey: process.env.HL_GAMING_API_KEY_2 });
  }
  return accounts;
}

function isQuotaExceeded(e) {
  const status = e.response ? e.response.status : null;
  const errMsg = e.response && e.response.data ? String(e.response.data.error || '') : '';
  return status === 429 || /quota/i.test(errMsg);
}

// Возвращает:
//   { nickname }                          — нашли игрока
//   { nickname: null, serviceReachable }  — не нашли; serviceReachable
//                                            говорит, отвечал ли вообще API
// Бросает ошибку с кодом NO_API_KEY, если ни один аккаунт не настроен.
async function checkFreeFireNickname(uid) {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    const err = new Error('HL_GAMING_USERUID / HL_GAMING_API_KEY не заданы в .env — проверка ника отключена');
    err.code = 'NO_API_KEY';
    throw err;
  }

  let reachable = false;

  for (const account of accounts) {
    let quotaHit = false;

    for (const region of REGIONS) {
      try {
        const { data } = await client.get(BASE_URL, {
          params: { sectionName: 'freefireValidation', useruid: account.useruid, api: account.apiKey, uid, region },
          headers: {
            // HL Gaming проверяет домен по заголовку Origin/Referer (не по IP),
            // а обычный серверный запрос (axios) его не отправляет — из-за
            // этого был "403 Not Allowed" даже с доменом в белом списке.
            Origin: 'https://bec-u15k.onrender.com',
            Referer: 'https://bec-u15k.onrender.com/'
          }
        });
        reachable = true;
        const result = data && data.result;
        if (result && result.valid && result.AccountName) {
          return { nickname: result.AccountName };
        }
        console.log(`[ff nickname check] аккаунт ${account.label}, регион ${region}: ответ без игрока —`, JSON.stringify(data));
      } catch (e) {
        const status = e.response ? e.response.status : null;
        const body = e.response ? JSON.stringify(e.response.data) : e.code || e.message;

        if (isQuotaExceeded(e)) {
          reachable = true;
          quotaHit = true;
          console.warn(`[ff nickname check] аккаунт ${account.label}: дневной лимит исчерпан, переключаемся на следующий аккаунт (если есть)`);
          break; // не перебираем остальные регионы этим аккаунтом — лимит общий на аккаунт
        }

        console.error(`[ff nickname check] аккаунт ${account.label}, регион ${region}: ошибка — status=${status} body=${body}`);
        continue;
      }
    }

    if (!quotaHit) {
      // Этот аккаунт реально ответил (не лимит) и не нашёл игрока ни в
      // одном регионе — переключаться на следующий аккаунт бессмысленно,
      // у всех аккаунтов одни и те же данные Garena.
      break;
    }
  }

  return { nickname: null, serviceReachable: reachable };
}

module.exports = { checkFreeFireNickname };
