/**
 * Маскирование персональных и платёжных данных.
 *
 * ТЗ §9: нельзя запрашивать или хранить платёжные данные, обязательно
 * учесть приватность клиента. Агент их не просит, но клиент может
 * вставить номер карты сам. Без маскирования номер оседает в журнале
 * сервера, в истории диалога и уходит в модель.
 *
 * Два уровня:
 * - redactPayment — то, что нельзя ни хранить, ни отправлять в модель:
 *   карты, CVV, IBAN. Применяется к реплике ДО всего остального.
 * - redactForLog — плюс контакты и ИИН. Телефон модели нужен (клиент
 *   может оставить его для менеджера), а в журнал он не пишется.
 *
 * Регулярки — литералы, без \b: граница слова в JS не видит кириллицу
 * (AGENTS.md §13).
 */

const CARD_MASK = "[номер карты скрыт]";

/** Проверка Луна: отличает номер карты от случайной длинной цифры. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// 13–19 цифр, допускаются пробелы и дефисы между группами.
const CARD_RE = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;
const CVV_RE = /(cvv2?|cvc2?|свв|свс|cvv-код|код безопасности)[\s:=-]*[0-9]{3,4}(?![0-9])/gi;
const IBAN_RE = /(?<![A-Za-z0-9])KZ[0-9]{2}(?:\s?[A-Z0-9]){16}(?![A-Za-z0-9])/gi;
const IIN_RE = /(иин|бин|iin|bin)[\s:№-]*[0-9]{12}(?![0-9])/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![0-9])(?:\+7|8)[\s(-]*[0-9]{3}[\s)-]*[0-9]{3}[\s-]*[0-9]{2}[\s-]*[0-9]{2}(?![0-9])/g;

export function redactPayment(text: string): string {
  if (!text) return text;
  return text
    .replace(CARD_RE, (m) => (luhn(m.replace(/[ -]/g, "")) ? CARD_MASK : m))
    .replace(CVV_RE, (_m, label: string) => `${label} [скрыт]`)
    .replace(IBAN_RE, "[счёт скрыт]");
}

export function redactForLog(text: string): string {
  return redactPayment(text)
    .replace(IIN_RE, (_m, label: string) => `${label} [скрыт]`)
    .replace(EMAIL_RE, "[email скрыт]")
    .replace(PHONE_RE, "[телефон скрыт]");
}

/** Есть ли в реплике платёжные данные — чтобы агент сказал, что они не нужны. */
export function hasPaymentData(text: string): boolean {
  return redactPayment(text) !== text;
}
