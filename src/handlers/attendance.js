import { sendMessage, answerCallback } from "../telegram.js";
import { getOpenShift, getOpenShiftOnDate, getShiftsOnDate, checkIn, checkOut, appendDayAttendance, deleteShiftsByIds, deleteDayAttendance, todayMinutes, workedMinutesSince } from "../db/attendance.js";
import { formatTime, formatDuration, formatToman, formatDate, startOfLocalDayIso, startOfLocalMonthIso, localDateKey } from "../utils/time.js";
import { mergeAttendanceIntervals } from "../utils/attendance.js";

export const HOURLY_RATE_TOMAN = 16000;

// ورودی‌های متنی تلگرام را مستقل از شکل ارقام و جداکننده‌ها به داده استاندارد تبدیل می‌کنیم.
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
  const start = new Date(Date.UTC(jy + 621, 2, 1, 12));
  for (let i = 0; i < 400; i++) {
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

function getDayBounds(dayKey, tz) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
  return { dayStart: localDateTimeToIso(dayKey, 0, 0, tz), dayEnd: localDateTimeToIso(next, 0, 0, tz) };
}

export async function handleAppendAttendance({ env, chatId, user, commands = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  const tz = env.TIMEZONE || "Asia/Tehran";
  try {
    if (!commands.length || commands.length % 2 !== 0) throw new Error("برای هر ورود باید خروج همان شیفت را هم وارد کنی؛ سوابق قبلی حفظ می‌شوند.");
    const parsed = commands.map((item) => ({ type: item.command, value: parseAttendanceTimestamp(item.args, tz) }));
    if (parsed.some((x) => !x.value.hasExplicitDate)) throw new Error("برای ثبت چند شیفت، تاریخ را در تمام دستورها بنویس.");
    const dayKey = parsed[0].value.dayKey;
    if (parsed.some((x) => x.value.dayKey !== dayKey)) throw new Error("تمام دستورها باید مربوط به یک تاریخ باشند.");
    const shifts = [];
    for (let i = 0; i < parsed.length; i += 2) {
      const entry = parsed[i], exit = parsed[i + 1];
      if (entry.type !== "/in" || exit.type !== "/out") throw new Error("ترتیب هر شیفت باید /in و سپس /out باشد.");
      const start = new Date(entry.value.at).getTime(), end = new Date(exit.value.at).getTime();
      if (end <= start) throw new Error("زمان خروج باید بعد از ورود همان شیفت باشد.");
      if (shifts.length && start < new Date(shifts[shifts.length - 1].check_out).getTime()) throw new Error("شیفت‌های جدید با یکدیگر هم‌پوشانی دارند.");
      shifts.push({ check_in: entry.value.at, check_out: exit.value.at, duration_minutes: Math.round((end - start) / 60000) });
    }
    const bounds = getDayBounds(dayKey, tz);
    const existing = await getShiftsOnDate(env, user.telegram_id, bounds.dayStart, bounds.dayEnd);
    const all = [...existing, ...shifts].sort((x, y) => new Date(x.check_in) - new Date(y.check_in));
    // هم‌پوشانی در زمان نمایش و محاسبه ادغام می‌شود؛ رکورد خام برای حفظ سابقه حذف یا بازنویسی نمی‌شود.
    await appendDayAttendance(env, user.telegram_id, shifts);
    const total = shifts.reduce((sum, x) => sum + x.duration_minutes, 0);
    return sendMessage(env, chatId, "✅ " + shifts.length + " شیفت جدید به " + formatDate(shifts[0].check_in, tz) + " اضافه شد.\nشیفت‌های قبلی تغییری نکردند.\n⏱ مجموع زمان شیفت‌های جدید: " + formatDuration(total));
  } catch (error) {
    return sendMessage(env, chatId, "⚠️ " + error.message + "\nنمونه:\n/in 09:00 1405/08/24\n/out 12:00 1405/08/24");
  }
}

export async function handleInfo({ env, chatId, user, args = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  try {
    if (args.length !== 1) throw new Error("تاریخ را وارد کن؛ نمونه: /info 1405/08/24");
    const tz = env.TIMEZONE || "Asia/Tehran";
    const dayKey = parseDateKey(args[0]);
    const bounds = getDayBounds(dayKey, tz);
    const rawShifts = await getShiftsOnDate(env, user.telegram_id, bounds.dayStart, bounds.dayEnd);
    const shifts = mergeAttendanceIntervals(rawShifts);
    if (!shifts.length) return sendMessage(env, chatId, "برای " + formatDate(bounds.dayStart, tz) + " هیچ شیفتی ثبت نشده است.");
    const dateParts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
      timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    }).formatToParts(new Date(bounds.dayStart));
    const dateValues = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    const prettyDate = dateValues.weekday + "، " + dateValues.day + " " + dateValues.month + " " + dateValues.year;
    const clock = (iso) => new Intl.DateTimeFormat("fa-IR", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(iso));
    const sections = shifts.map((s, i) => [
      "🔹 شیفت " + (i + 1) + (s.check_out ? "  •  بسته‌شده" : "  •  🔴 باز"),
      "🟢 ورود: " + clock(s.check_in),
      "🔴 خروج: " + (s.check_out ? clock(s.check_out) : "ثبت نشده"),
      "⏱ مدت: " + (s.open ? "در حال محاسبه" : formatDuration(s.duration_minutes)),
    ].join("\n"));
    const closedGroups = shifts.filter((s) => !s.open);
    const total = closedGroups.reduce((sum, s) => sum + s.duration_minutes, 0);
    const closedCount = closedGroups.length;
    const message = [
      "📋 گزارش شیفت‌های روزانه",
      "📅 " + prettyDate,
      "━━━━━━━━━━━━━━",
      sections.join("\n\n"),
      "━━━━━━━━━━━━━━",
      "📊 خلاصه گزارش",
      "• تعداد کل بازه‌های ادغام‌شده: " + shifts.length,
      "• شیفت‌های بسته: " + closedCount,
      "⏱ مجموع زمان شیفت‌های بسته: " + formatDuration(total),
    ].join("\n");
    return sendMessage(env, chatId, message);
  } catch (error) { return sendMessage(env, chatId, "⚠️ " + error.message); }
}

export async function handleDeleteAttendance({ env, chatId, user, args = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  try {
    if (!args.length) throw new Error("نمونه: /delete 1405/08/24 2 یا /delete 2 1405.8.24");
    const tz = env.TIMEZONE || "Asia/Tehran";
    // تاریخ را از هر جای آرگومان‌ها پیدا می‌کنیم؛ ترتیب تاریخ و شماره بازه مهم نیست.
    const dateIndex = args.findIndex((value) => /^(?:\\d{4})[./-]\\d{1,2}[./-]\\d{1,2}$/.test(normalizeDigits(value)));
    if (dateIndex < 0) throw new Error("تاریخ را در دستور وارد کن؛ نمونه: /delete 2 1405.8.24");
    const dateRaw = args[dateIndex];
    const dayKey = parseDateKey(dateRaw);
    const indexes = args.filter((_, index) => index !== dateIndex).map((value) => Number(normalizeDigits(value)));
    const bounds = getDayBounds(dayKey, tz);
    const rawShifts = await getShiftsOnDate(env, user.telegram_id, bounds.dayStart, bounds.dayEnd);
    const shifts = mergeAttendanceIntervals(rawShifts);
    if (!shifts.length) return sendMessage(env, chatId, "برای این تاریخ شیفتی پیدا نشد.");
    if (!indexes.length) {
      return sendMessage(env, chatId, "⚠️ تأیید حذف تمام " + rawShifts.length + " رکورد در " + shifts.length + " بازه روز " + formatDate(bounds.dayStart, tz) + "\nاین کار قابل بازگشت نیست. مطمئنی؟", {
        reply_markup: { inline_keyboard: [[{ text: "🗑 بله، حذف همه شیفت‌ها", callback_data: "attdel:" + dayKey }], [{ text: "انصراف", callback_data: "attcancel" }]] }
      });
    }
    if (indexes.some(n => !Number.isInteger(n) || n < 1 || n > shifts.length)) throw new Error("شماره بازه باید بین ۱ تا " + shifts.length + " باشد. برای دیدن شماره‌ها /info " + dateRaw + " را بزن.");
    const unique = [...new Set(indexes)];
    const ids = unique.flatMap((n) => shifts[n - 1].ids);
    await deleteShiftsByIds(env, user.telegram_id, ids);
    return sendMessage(env, chatId, "✅ بازه‌های " + unique.sort((x, y) => x - y).join("، ") + " از " + formatDate(bounds.dayStart, tz) + " حذف شدند.");
  } catch (error) { return sendMessage(env, chatId, "⚠️ " + error.message); }
}

export async function handleAttendanceCallback({ env, callback, user }) {
  const data = String(callback.data || "");
  await answerCallback(env, callback.id);
  if (!employeeOnly(user)) return;
  if (data === "attcancel") return sendMessage(env, callback.message?.chat?.id, "حذف لغو شد؛ اطلاعات تغییری نکرد.");
  const match = data.match(/^attdel:(\d{4}-\d{2}-\d{2})$/);
  if (!match) return;
  const tz = env.TIMEZONE || "Asia/Tehran";
  const bounds = getDayBounds(match[1], tz);
  const shifts = await getShiftsOnDate(env, user.telegram_id, bounds.dayStart, bounds.dayEnd);
  if (!shifts.length) return sendMessage(env, callback.message?.chat?.id, "شیفتی برای حذف باقی نمانده است.");
  await deleteDayAttendance(env, user.telegram_id, bounds.dayStart, bounds.dayEnd);
  return sendMessage(env, callback.message?.chat?.id, "✅ تمام " + shifts.length + " شیفت روز " + formatDate(bounds.dayStart, tz) + " حذف شدند.");
}

function parseAttendanceTimestamp(args, tz) {
  const numbers = normalizeDigits((args || []).join(" ")).match(/\d+/g) || [];
  if (numbers.length !== 2 && numbers.length !== 5) {
    throw new Error("ساعت را وارد کن و در صورت نیاز تاریخ را هم بنویس؛ نمونه: /in 16:00 1405.8.20");
  }

  const hour = Number(numbers[0]);
  const minute = Number(numbers[1]);
  if (hour > 23 || minute > 59) throw new Error("ساعت واردشده معتبر نیست.");

  const now = new Date();
  const todayKey = localDateKey(now.toISOString(), tz);
  const hasExplicitDate = numbers.length === 5;
  const dayKey = hasExplicitDate ? parseDateKey(numbers.slice(2).join("/")) : todayKey;

  if (dayKey > todayKey) throw new Error("ثبت ساعت برای تاریخ آینده مجاز نیست.");

  const at = localDateTimeToIso(dayKey, hour, minute, tz);
  if (new Date(at).getTime() > now.getTime()) {
    throw new Error("زمان واردشده در آینده است و امکان ثبت آن وجود ندارد.");
  }
  return { at, dayKey, hasExplicitDate };
}

export async function handleCheckIn({ env, chatId, user, args = [], msg }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  const tz = env.TIMEZONE || "Asia/Tehran";
  if (String(msg?.text || "").trim().match(/^\/in(?:@\w+)?$/i)) {
    return sendMessage(env, chatId, "⚠️ برای ثبت دستی ورود، ساعت را هم وارد کن. نمونه: /in 13:00");
  }
  let parsed;
  try {
    parsed = args.length ? parseAttendanceTimestamp(args, tz) : { at: new Date().toISOString(), dayKey: localDateKey(new Date().toISOString(), tz), hasExplicitDate: false };
  } catch (error) {
    return sendMessage(env, chatId, `⚠️ ${error.message}\nنمونه: /in 14:38 1405/08/24`);
  }

  const openShift = await getOpenShift(env, user.telegram_id);
  if (openShift) {
    return sendMessage(env, chatId,
      `⚠️ هنوز یک شیفت باز دارید (ورود: ${formatTime(openShift.check_in, tz)}). ابتدا خروج آن را ثبت کن.`
    );
  }

  const savedAt = await checkIn(env, user.telegram_id, parsed.at);
  return sendMessage(env, chatId, `🔵 ورود ثبت شد\n🕒 ${formatTime(savedAt, tz)}`);
}

export async function handleCheckOut({ env, chatId, user, args = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  const tz = env.TIMEZONE || "Asia/Tehran";
  let parsed;
  try {
    parsed = args.length ? parseAttendanceTimestamp(args, tz) : { at: new Date().toISOString(), dayKey: localDateKey(new Date().toISOString(), tz) };
  } catch (error) {
    return sendMessage(env, chatId, `⚠️ ${error.message}\nنمونه: /out 18:05 1405/08/24`);
  }
  const [year, month, day] = parsed.dayKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
  const dayStart = localDateTimeToIso(parsed.dayKey, 0, 0, tz);
  const dayEnd = localDateTimeToIso(next, 0, 0, tz);
  const shift = await getOpenShiftOnDate(env, user.telegram_id, dayStart, dayEnd);
  if (!shift) return sendMessage(env, chatId, "⚠️ برای این تاریخ ورود بازی جهت ثبت خروج پیدا نشد.");
  if (new Date(parsed.at).getTime() <= new Date(shift.check_in).getTime()) {
    return sendMessage(env, chatId, "⚠️ زمان خروج باید بعد از زمان ورود همان شیفت باشد.");
  }
  const { now, minutes } = await checkOut(env, shift, parsed.at);
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
