import { sendMessage } from "../telegram.js";
import { getOpenShift, checkIn, checkOut, todayMinutes, workedMinutesSince } from "../db/attendance.js";
import { formatTime, formatDuration, formatToman, formatDate, startOfLocalDayIso, startOfLocalMonthIso, localDateKey } from "../utils/time.js";

const HOURLY_RATE_TOMAN = 16000;

function employeeOnly(user) {
  return user?.role === "employee";
}

function normalizeDigits(value) {
  return String(value).replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function jalaliToGregorianKey(jy, jm, jd) {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric",
  });
  const start = new Date(Date.UTC(jy + 621, 0, 1, 12));
  start.setUTCDate(start.getUTCDate() - 90);
  for (let i = 0; i < 460; i++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    if (Number(parts.year) === jy && Number(parts.month) === jm && Number(parts.day) === jd) {
      return date.toISOString().slice(0, 10);
    }
  }
  return null;
}

function parseDateKey(raw) {
  const normalized = normalizeDigits(raw);
  const match = normalized.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!match) throw new Error("تاریخ نامعتبر است. نمونه صحیح: 1405/08/24 یا 2026-11-15");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year >= 1200 && year <= 1600) {
    const key = jalaliToGregorianKey(year, month, day);
    if (!key) throw new Error("تاریخ شمسی معتبر نیست.");
    return key;
  }

  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("تاریخ معتبر نیست.");
  }
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("تاریخ میلادی معتبر نیست.");
  }
  return date.toISOString().slice(0, 10);
}

function localDateTimeToIso(dayKey, hour, minute, tz) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(guess);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  const offset = represented - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

function parseAttendanceTimestamp(args, tz) {
  if (!args?.length || args.length > 2) {
    throw new Error("قالب صحیح: /in 14:38 یا /in 14:38 1405/08/24");
  }

  const time = normalizeDigits(args[0]);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) throw new Error("ساعت را با قالب ۲۴ ساعته HH:mm وارد کن؛ نمونه: 14:38");

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) throw new Error("ساعت واردشده معتبر نیست.");

  const now = new Date();
  const todayKey = localDateKey(now.toISOString(), tz);
  const dayKey = args[1] ? parseDateKey(args[1]) : todayKey;

  if (dayKey > todayKey) throw new Error("ثبت ساعت برای تاریخ آینده مجاز نیست.");

  const at = localDateTimeToIso(dayKey, hour, minute, tz);
  if (new Date(at).getTime() > now.getTime()) {
    throw new Error("زمان واردشده در آینده است و امکان ثبت آن وجود ندارد.");
  }
  return at;
}

export async function handleCheckIn({ env, chatId, user, args = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  let at;
  try {
    at = args.length ? parseAttendanceTimestamp(args, env.TIMEZONE || "Asia/Tehran") : new Date().toISOString();
  } catch (error) {
    return sendMessage(env, chatId, `⚠️ ${error.message}\nنمونه: /in 14:38 1405/08/24`);
  }
  if (await getOpenShift(env, user.telegram_id)) {
    return sendMessage(env, chatId, "⚠️ ورود قبلاً ثبت شده و هنوز خروج ثبت نکرده‌اید.");
  }
  const savedAt = await checkIn(env, user.telegram_id, at);
  return sendMessage(env, chatId, `🔵 ورود ثبت شد\n🕒 ${formatTime(savedAt, env.TIMEZONE)}`);
}

export async function handleCheckOut({ env, chatId, user, args = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  let at;
  try {
    at = args.length ? parseAttendanceTimestamp(args, env.TIMEZONE || "Asia/Tehran") : new Date().toISOString();
  } catch (error) {
    return sendMessage(env, chatId, `⚠️ ${error.message}\nنمونه: /out 18:05 1405/08/24`);
  }
  const shift = await getOpenShift(env, user.telegram_id);
  if (!shift) return sendMessage(env, chatId, "⚠️ ورود بازی برای ثبت خروج ندارید.");
  if (new Date(at).getTime() <= new Date(shift.check_in).getTime()) {
    return sendMessage(env, chatId, "⚠️ زمان خروج باید بعد از زمان ورود همان شیفت باشد.");
  }
  const { now, minutes } = await checkOut(env, shift, at);
  return sendMessage(env, chatId, `🔴 خروج ثبت شد\n🕒 ${formatTime(now, env.TIMEZONE)}\n⏱ مدت این شیفت: ${formatDuration(minutes)}`);
}

export async function handleStatus({ env, chatId, user }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "وضعیت حضور فقط برای حساب‌های کارمندی است.");
  const tz = env.TIMEZONE || "Asia/Tehran";
  const now = new Date();
  const todayStart = startOfLocalDayIso(localDateKey(now.toISOString(), tz), tz);
  const monthStart = startOfLocalMonthIso(now, tz);
  const shift = await getOpenShift(env, user.telegram_id);
  const done = await todayMinutes(env, user.telegram_id, todayStart);
  const todayWorked = await workedMinutesSince(env, user.telegram_id, todayStart);
  const monthWorked = await workedMinutesSince(env, user.telegram_id, monthStart);
  const state = shift ? `🟢 ورود ثبت‌شده: ${formatTime(shift.check_in, tz)}` : "🔴 در حال حاضر شیفت بازی ندارید.";
  const todayIncome = todayWorked * HOURLY_RATE_TOMAN / 60;
  const monthIncome = monthWorked * HOURLY_RATE_TOMAN / 60;
  return sendMessage(env, chatId,
    `📅 ${formatDate(now.toISOString(), tz)}\n\n${state}\nمجموع ساعت ثبت‌شده امروز: ${formatDuration(Math.max(done, todayWorked))}\n\n📊 مانیتورینگ درآمد\n💰 درآمد امروز: ${formatToman(todayIncome)}\n💰 درآمد این ماه: ${formatToman(monthIncome)}\n⏱ مجموع ساعت کارکرد این ماه: ${formatDuration(monthWorked)}`
  );
}
