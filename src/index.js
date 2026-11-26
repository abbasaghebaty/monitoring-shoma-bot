import { routeUpdate } from "./router.js";
import { handleStatus, HOURLY_RATE_TOMAN } from "./handlers/attendance.js";
import { workedMinutesSince, payrollDistributionSince } from "./db/attendance.js";
import { PAYROLL_EMPLOYEE_IDS } from "./db/users.js";
import { startOfLocalMonthIso, formatToman, localDateKey } from "./utils/time.js";

// API فقط‌خواندنی درآمد ماهانه عباس را با همان منطق تقسیم حقوقِ فرمان وضعیت محاسبه می‌کند.
async function handleMonthlyIncomeApi(request, env) {
  if (!env.ACCOUNTING_API_TOKEN) {
    return Response.json({ error: "API is not configured" }, { status: 503 });
  }
  const authorization = request.headers.get("Authorization") || "";
  if (authorization !== `Bearer ${env.ACCOUNTING_API_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const employeeId = PAYROLL_EMPLOYEE_IDS[0];
  const employee = await env.DB.prepare(
    "SELECT full_name FROM users WHERE telegram_id = ? AND role = 'employee' AND is_active = 1"
  ).bind(employeeId).first();
  if (!employee) {
    return Response.json({ error: "Employee account is missing or inactive" }, { status: 409 });
  }

  const tz = env.TIMEZONE || "Asia/Tehran";
  const now = new Date();
  const monthStart = startOfLocalMonthIso(now, tz);
  const minutes = await workedMinutesSince(env, employeeId, monthStart);
  const payroll = await payrollDistributionSince(env, monthStart, HOURLY_RATE_TOMAN);
  const employeePayroll = payroll[String(employeeId)] || { allocatedMinutes: 0, incomeToman: 0 };
  const income = employeePayroll.incomeToman;
  const month = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: tz, month: "long", year: "numeric"
  }).format(now);

  return Response.json({
    employee: employee.full_name,
    month,
    minutes,
    hours: Math.round(minutes / 60 * 10) / 10,
    hourlyRateToman: HOURLY_RATE_TOMAN,
    allocatedMinutes: Math.round(employeePayroll.allocatedMinutes),
    incomeToman: income,
    incomeFormatted: formatToman(income),
    updatedAt: now.toISOString()
  }, {
    headers: { "Cache-Control": "no-store" }
  });
}


// زمان‌بندی گزارش پایان ماه شمسی؛ Cloudflare Cron بر مبنای UTC اجرا می‌شود.
// 20:29 UTC برابر 23:59 در Asia/Tehran است.
function persianMonthKey(dayKey, timeZone) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone, year: "numeric", month: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function nextGregorianDayKey(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
}

// بررسی می‌کند اجرای زمان‌بندی دقیقاً در 23:59 تهران و در آخرین روز ماه شمسی باشد.
function isPersianMonthEndAt2359(date, timeZone) {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(clock.map((part) => [part.type, part.value]));
  if (values.hour !== "23" || values.minute !== "59") return false;

  const todayKey = localDateKey(date.toISOString(), timeZone);
  const tomorrowKey = nextGregorianDayKey(todayKey);
  return persianMonthKey(todayKey, timeZone) !== persianMonthKey(tomorrowKey, timeZone);
}

// همان handler وضعیت دستی برای تمام کارکنان فعال فراخوانی می‌شود تا متن و محاسبات یکی بماند.
// کلید KV مانع ارسال دوباره گزارش یک ماه در صورت تکرار اجرای Cron می‌شود.
async function sendPersianMonthEndStatuses(env, scheduledTime) {
  const timeZone = env.TIMEZONE || "Asia/Tehran";
  const scheduledAt = new Date(scheduledTime || Date.now());
  if (!isPersianMonthEndAt2359(scheduledAt, timeZone)) return;

  const dayKey = localDateKey(scheduledAt.toISOString(), timeZone);
  const monthKey = persianMonthKey(dayKey, timeZone);
  const sentKey = `monthly-status-sent:${monthKey}`;
  if (await env.SESSION_KV.get(sentKey)) return;

  const { results = [] } = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE role = 'employee' AND is_active = 1 ORDER BY telegram_id"
  ).all();

  for (const employee of results) {
    await handleStatus({
      env,
      chatId: employee.telegram_id,
      user: { telegram_id: employee.telegram_id, role: "employee" },
    });
  }

  // حتی در ماه بدون کارمند فعال نیز اجرای همان ماه تکرار نمی‌شود.
  await env.SESSION_KV.put(sentKey, "sent", { expirationTtl: 60 * 60 * 24 * 45 });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendPersianMonthEndStatuses(env, controller.scheduledTime).catch((error) => {
      console.error("Persian month-end status failed:", error);
    }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/me/monthly-income") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      try {
        return await handleMonthlyIncomeApi(request, env);
      } catch (error) {
        console.error("Monthly income API failed:", error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    }
    if (request.method === "GET") return new Response("monitoring_shoma OK");
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    ctx.waitUntil(routeUpdate(update, env).catch((error) => console.error("update error:", error)));
    return new Response("ok");
  },
};
