const IMAGE_QUOTA_PATTERNS = [
  /(?:图片|图像)\s*生成\s*(?:次数|请求)?\s*(?:已用完|用完|上限|限额)/i,
  /(?:图片|图像)\s*(?:额度|配额).{0,30}(?:已用完|用完|上限|限额)/i,
  /(?:image\s+generation|image\s+generations?).{0,80}(?:limit|quota|exhausted|used\s+up|run\s+out)/i,
  /image\s+(?:quota|limit).{0,40}(?:exhausted|used\s+up|reset|again)/i,
  /(?:run\s+out|used\s+up|exhausted).{0,80}image(?:\s+generation)?/i,
];

const ABSOLUTE_RESET = /(今天|明天|后天|today|tomorrow)\s*(?:at|在|的)?\s*(上午|下午|晚上|AM|PM)?\s*(\d{1,2})(?:(?:[:：])(\d{2})|点\s*(\d{1,2})?\s*分?)?\s*(上午|下午|晚上|AM|PM)?/i;
const RELATIVE_RESET = /(?:将在|会在|在|in|within|after)\s*(\d+(?:[.,]\d+)?)\s*(秒钟?|分钟?|小时|天|seconds?|minutes?|hours?|days?)\s*(?:后|之后)?/i;
const RELATIVE_RESET_SUFFIX = /(\d+(?:[.,]\d+)?)\s*(秒钟?|分钟?|小时|天)\s*(?:后|之后)/i;

function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

function pad(value) { return String(value).padStart(2, '0'); }

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

function localOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function localDateTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseMeridiem(value) {
  if (!value) return null;
  if (/下午|晚上|PM/i.test(value)) return 'pm';
  if (/上午|AM/i.test(value)) return 'am';
  return null;
}

function parseAbsolute(text, observedAt) {
  const match = ABSOLUTE_RESET.exec(text);
  if (!match) return null;
  const [, day, beforeMeridiem, rawHour, rawColonMinute, rawPointMinute, afterMeridiem] = match;
  let hour = Number(rawHour), minute = Number(rawColonMinute ?? rawPointMinute ?? 0);
  const meridiem = parseMeridiem(afterMeridiem) || parseMeridiem(beforeMeridiem);
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  const dayOffset = /后天/i.test(day) ? 2 : /明天|tomorrow/i.test(day) ? 1 : 0;
  const reset = new Date(observedAt);
  reset.setHours(0, 0, 0, 0);
  reset.setDate(reset.getDate() + dayOffset);
  reset.setHours(hour, minute, 0, 0);
  return { resetAt: reset.getTime(), source: 'absolute_text', precision: 'minute', matchedText: match[0] };
}

function relativeUnit(value) {
  if (/秒|second/i.test(value)) return 1000;
  if (/分钟|minute/i.test(value)) return 60 * 1000;
  if (/小时|hour/i.test(value)) return 60 * 60 * 1000;
  if (/天|day/i.test(value)) return 24 * 60 * 60 * 1000;
  return null;
}

function parseRelative(text, observedAt) {
  const match = RELATIVE_RESET.exec(text) || RELATIVE_RESET_SUFFIX.exec(text);
  if (!match) return null;
  const amount = Number(String(match[1]).replace(',', '.'));
  const unit = relativeUnit(match[2]);
  if (!Number.isFinite(amount) || amount < 0 || !unit) return null;
  return { resetAt: observedAt + amount * unit, source: 'relative_text', precision: 'relative', matchedText: match[0] };
}

export function isImageGenerationQuota(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return !!value && IMAGE_QUOTA_PATTERNS.some(pattern => pattern.test(value));
}

export function parseImageGenerationQuota(text, observedAt = Date.now()) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!isImageGenerationQuota(value)) return null;
  const observedTimestamp = asTimestamp(observedAt);
  if (!Number.isFinite(observedTimestamp)) return null;
  const parsed = parseAbsolute(value, observedTimestamp) || parseRelative(value, observedTimestamp);
  const resetDate = parsed && Number.isFinite(parsed.resetAt) ? new Date(parsed.resetAt) : null;
  return {
    type: 'image_generation',
    exhausted: true,
    resetAt: resetDate ? resetDate.toISOString() : null,
    resetAtLocal: resetDate ? localDateTime(resetDate) : null,
    resetAtOffset: resetDate ? `${resetDate.getFullYear()}-${pad(resetDate.getMonth() + 1)}-${pad(resetDate.getDate())}T${pad(resetDate.getHours())}:${pad(resetDate.getMinutes())}:${pad(resetDate.getSeconds())}.${String(resetDate.getMilliseconds()).padStart(3, '0')}${localOffset(resetDate)}` : null,
    resetAfterMs: resetDate ? Math.max(0, parsed.resetAt - observedTimestamp) : null,
    precision: parsed?.precision || 'unknown',
    source: parsed?.source || 'unavailable',
    matchedText: parsed?.matchedText || null,
    observedAt: new Date(observedTimestamp).toISOString(),
    timeZone: localTimeZone(),
  };
}
