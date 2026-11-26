import { routeUpdate } from "./router.js";
import { HOURLY_RATE_TOMAN } from "./handlers/attendance.js";
import { workedMinutesSince, payrollDistributionSince } from "./db/attendance.js";
import { PAYROLL_EMPLOYEE_IDS } from "./db/users.js";
import { startOfLocalMonthIso, formatToman } from "./utils/time.js";

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

export default {
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
