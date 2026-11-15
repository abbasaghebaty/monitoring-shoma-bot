import { sendMessage } from "../telegram.js";
import { getOpenShift, getOpenShiftOnDate, checkIn, checkOut, replaceDayAttendance, todayMinutes, workedMinutesSince } from "../db/attendance.js";
import { formatTime, formatDuration, formatToman, formatDate, startOfLocalDayIso, startOfLocalMonthIso, localDateKey } from "../utils/time.js";

export const HOURLY_RATE_TOMAN = 16000;

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

export async function handleReplaceAttendance({ env, chatId, user, commands = [] }) {
  if (!employeeOnly(user)) return sendMessage(env, chatId, "این بخش فقط برای حساب‌های کارمندی فعال است.");
  const tz = env.TIMEZONE || "Asia/Tehran";
  try {
    if (!commands.length) throw new Error("دستورهای ورود و خروج را در یک پیام بفرست.");
    const parsedCommands = commands.map((command) => ({ type: command.command, parsed: parseAttendanceTimestamp(command.args, tz) }));
    if (parsedCommands.some((item) => !item.parsed.hasExplicitDate)) throw new Error("برای جایگزینی برنامه یک تاریخ، تاریخ را در تمام دستورها بنویس.");
    const dayKey = parsedCommands[0].parsed.dayKey;
    if (parsedCommands.some((item) => item.parsed.dayKey !== dayKey)) throw new Error("تمام دستورهای یک پیام باید مربوط به یک تاریخ باشند.");
    if (parsedCommands.length % 2 !== 0) throw new Error("برای هر ورود باید خروج همان شیفت هم در همین پیام باشد؛ اطلاعات قبلی تغییری نکرد.");
    const shifts = [];
    for (let i = 0; i < parsedCommands.length; i += 2) {
      const entry = parsedCommands[i];
      const exit = parsedCommands[i + 1];
      if (entry.type !== "/in" || exit.type !== "/out") throw new Error("ترتیب هر شیفت باید ابتدا /in و سپس /out باشد؛ اطلاعات قبلی تغییری نکرد.");
      const start = new Date(entry.parsed.at).getTime();
      const end = new Date(exit.parsed.at).getTime();
      if (end <= start) throw new Error("زمان خروج هر شیفت باید بعد از ورود همان شیفت باشد؛ اطلاعات قبلی تغییری نکرد.");
      if (shifts.length && start <= new Date(shifts[shifts.length - 1].check_out).getTime()) throw new Error("شیفت‌ها نباید با هم هم‌پوشانی داشته باشند؛ اطلاعات قبلی تغییری نکرد.");
      shifts.push({ check_in: entry.parsed.at, check_out: exit.parsed.at, duration_minutes: Math.round((end - start) / 60000) });
    }
    const [year, month, day] = dayKey.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
    const dayStart = localDateTimeToIso(dayKey, 0, 0, tz);
    const dayEnd = localDateTimeToIso(next, 0, 0, tz);
    await replaceDayAttendance(env, user.telegram_id, dayStart, dayEnd, shifts);
    const totalMinutes = shifts.reduce((sum, shift) => sum + shift.duration_minutes, 0);
    return sendMessage(env, chatId, `✅ برنامه کاری ${formatDate(shifts[0].check_in, tz)} جایگزین شد.\n🔁 تعداد شیفت‌ها: ${shifts.length}\n⏱ مجموع کارکرد: ${formatDuration(totalMinutes)}`);
  } catch (error) {
    return sendMessage(env, chatId, `⚠️ ${error.message}\nنمونه: /in 16:00 1405.8.20\n/out 21:30 1405.8.20`);
  }
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
