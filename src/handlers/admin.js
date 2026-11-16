import { sendMessage } from "../telegram.js";
import { listUsers, upsertUser } from "../db/users.js";
import { getAttendanceSince } from "../db/attendance.js";
import { formatDuration, daysAgoKey, localDateKey, startOfLocalDayIso } from "../utils/time.js";
import { mergeAttendanceIntervals } from "../utils/attendance.js";

function ownerOnly(user) {
  return user?.role === "owner";
}

export async function handleListUsers({ env, chatId, user }) {
  if (!ownerOnly(user)) return sendMessage(env, chatId, "⛔ فقط مدیر کل به این بخش دسترسی دارد.");
  const users = await listUsers(env);
  const lines = users.map((u) => `${u.is_active ? "🟢" : "⚪"} ${u.full_name} — ${u.role === "owner" ? "مدیر کل" : "کارمند"} — ${u.telegram_id}`);
  return sendMessage(env, chatId, "👥 کاربران ثبت‌شده:\n" + (lines.join("\n") || "کاربری ثبت نشده است."));
}

export async function handleAddUser({ env, chatId, args, user }) {
  if (!ownerOnly(user)) return sendMessage(env, chatId, "⛔ فقط مدیر کل اجازه افزودن کاربر دارد.");
  const [id, ...nameParts] = args;
  const fullName = nameParts.join(" ").trim();
  if (!/^\d+$/.test(id || "") || !fullName) {
    return sendMessage(env, chatId, "فرمت صحیح:\n/adduser <آیدی عددی> <نام>");
  }
  await upsertUser(env, { telegramId: Number(id), fullName, role: "employee" });
  return sendMessage(env, chatId, `✅ ${fullName} به‌عنوان کارمند اضافه شد.`);
}

async function buildReport(env, days) {
  const tz = env.TIMEZONE || "Asia/Tehran";
  const startKey = days === 1 ? localDateKey(new Date().toISOString(), tz) : daysAgoKey(days - 1, tz);
  const rows = await getAttendanceSince(env, startOfLocalDayIso(startKey, tz));
  const byEmployee = new Map();
  for (const row of rows) {
    if (!byEmployee.has(row.telegram_id)) byEmployee.set(row.telegram_id, { name: row.full_name, rows: [] });
    byEmployee.get(row.telegram_id).rows.push(row);
  }
  const from = new Date(startOfLocalDayIso(startKey, tz)).getTime();
  const to = Date.now();
  return [...byEmployee.values()].map((employee) => {
    const intervals = mergeAttendanceIntervals(employee.rows, { from, to });
    return {
      name: employee.name,
      minutes: intervals.reduce((sum, item) => sum + item.duration_minutes, 0),
      shifts: intervals.length,
      open: intervals.some((item) => item.open),
    };
  }).sort((a, b) => b.minutes - a.minutes);
}

export async function handleReport({ env, chatId, user, days = 1 }) {
  if (!ownerOnly(user)) return sendMessage(env, chatId, "⛔ فقط مدیر کل اجازه مشاهده گزارش را دارد.");
  const totals = await buildReport(env, days);
  const title = days === 1 ? "گزارش امروز" : `گزارش ${days} روز اخیر`;
  const body = totals.length
    ? totals.map((x) => `• ${x.name}: ${formatDuration(x.minutes)} در ${x.shifts} شیفت${x.open ? " (شیفت باز)" : ""}`).join("\n")
    : "در این بازه هنوز ورود و خروجی ثبت نشده است.";
  return sendMessage(env, chatId, `📊 ${title}\n\n${body}`);
}

export async function handleChart({ env, chatId, user }) {
  if (!ownerOnly(user)) return sendMessage(env, chatId, "⛔ فقط مدیر کل اجازه مشاهده نمودار را دارد.");
  const totals = await buildReport(env, 7);
  if (!totals.length) return sendMessage(env, chatId, "برای ساخت نمودار هنوز داده‌ای ثبت نشده است.");
  const max = Math.max(1, ...totals.map((x) => x.minutes));
  const chart = totals.map((x) => {
    const blocks = Math.max(1, Math.round((x.minutes / max) * 16));
    return `${x.name}\n${"▰".repeat(blocks)} ${formatDuration(x.minutes)}`;
  }).join("\n\n");
  return sendMessage(env, chatId, `📈 نمودار ساعت کاری ۷ روز اخیر\n\n${chart}`);
}
