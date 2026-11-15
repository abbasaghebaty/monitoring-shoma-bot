import { routeUpdate } from "./router.js";
import { HOURLY_RATE_TOMAN } from "./handlers/attendance.js";
import { workedMinutesSince } from "./db/attendance.js";
import { startOfLocalMonthIso, formatToman } from "./utils/time.js";

const PERSONAL_EMPLOYEE_NAME = "عباس";

async function handleMonthlyIncomeApi(request, env) {
  if (!env.ACCOUNTING_API_TOKEN) {
    return Response.json({ error: "API is not configured" }, { status: 503 });
  }
  const authorization = request.headers.get("Authorization") || "";
  if (authorization !== `Bearer ${env.ACCOUNTING_API_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE full_name = ? AND role = 'employee' AND is_active = 1 LIMIT 2"
  ).bind(PERSONAL_EMPLOYEE_NAME).all();
  if (!results || results.length !== 1) {
    return Response.json({ error: "Employee account is missing or ambiguous" }, { status: 409 });
  }

  const tz = env.TIMEZONE || "Asia/Tehran";
  const now = new Date();
  const monthStart = startOfLocalMonthIso(now, tz);
  const minutes = await workedMinutesSince(env, results[0].telegram_id, monthStart);
  const income = Math.round(minutes * HOURLY_RATE_TOMAN / 60);
  const month = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: tz, month: "long", year: "numeric"
  }).format(now);

  return Response.json({
    employee: PERSONAL_EMPLOYEE_NAME,
    month,
    minutes,
    hours: Math.round(minutes / 60 * 10) / 10,
    hourlyRateToman: HOURLY_RATE_TOMAN,
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
