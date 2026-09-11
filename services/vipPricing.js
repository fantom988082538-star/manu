// Фиксированная сетка цен на покупку VIP (сомони за уровень) — ТЗ п.16.
// Отдельный модуль, чтобы routes/topups.js мог провалидировать присланный
// percent/amount на backend — фронту не доверяем финальную сумму.

const VIP_PRICE_PER_PERCENT = 15; // 1% = 15 сомони, 2% = 30, ... 10% = 150

function vipPriceFor(percent) {
  return percent * VIP_PRICE_PER_PERCENT;
}

function isValidVipPercent(percent) {
  return Number.isInteger(percent) && percent >= 1 && percent <= 10;
}

module.exports = { VIP_PRICE_PER_PERCENT, vipPriceFor, isValidVipPercent };
