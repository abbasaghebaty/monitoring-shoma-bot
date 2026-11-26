import { mergeAttendanceIntervals } from "../utils/attendance.js";
import { PAYROLL_EMPLOYEE_IDS } from "./users.js";

export async function getOpenShift(env, telegramId) {
  return env.DB.prepare(
    "SELECT * FROM attendance WHERE telegram_id = ? AND check_out IS NULL ORDER BY id DESC LIMIT 1"
  ).bind(telegramId).first();
}

export async function getOpenShiftOnDate(env, telegramId, dayStartIso, dayEndIso) {
  return env.DB.prepare(
    "SELECT * FROM attendance WHERE telegram_id = ? AND check_out IS NULL AND check_in >= ? AND check_in < ? ORDER BY id DESC LIMIT 1"
  ).bind(telegramId, dayStartIso, dayEndIso).first();
}

export async function updateCheckIn(env, shift, at) {
  const result = await env.DB.prepare(
    "UPDATE attendance SET check_in = ? WHERE id = ? AND check_out IS NULL"
  ).bind(at, shift.id).run();
  if (!result.meta?.changes) throw new Error("این ورود قبلاً بسته شده یا دیگر قابل ویرایش نیست.");
  return at;
}

export async function checkIn(env, telegramId, at = new Date().toISOString()) {
  await env.DB.prepare("INSERT INTO attendance (telegram_id, check_in) VALUES (?, ?)").bind(telegramId, at).run();
  return at;
}

export async function checkOut(env, shift, at = new Date().toISOString()) {
  const minutes = Math.max(0, Math.round((new Date(at).getTime() - new Date(shift.check_in).getTime()) / 60000));
  const result = await env.DB.prepare("UPDATE attendance SET check_out = ?, duration_minutes = ? WHERE id = ? AND check_out IS NULL")
    .bind(at, minutes, shift.id).run();
  if (!result.meta?.changes) throw new Error("این شیفت قبلاً بسته شده یا دیگر قابل ویرایش نیست.");
  return { now: at, minutes };
}

// بازه‌های گزارش باید شیفت‌هایی را هم بگیرند که قبل از شروع گزارش آغاز و داخل بازه تمام شده‌اند.
export async function getAttendanceSince(env, sinceIso) {
  const { results } = await env.DB.prepare(
    `SELECT a.telegram_id, a.check_in, a.check_out, a.duration_minutes, u.full_name
     FROM attendance a JOIN users u ON u.telegram_id = a.telegram_id
     WHERE a.check_in < ? AND (a.check_out >= ? OR a.check_out IS NULL) ORDER BY a.check_in ASC`
  ).bind(new Date().toISOString(), sinceIso).all();
  return results || [];
}

export async function todayMinutes(env, telegramId, sinceIso) {
  return workedMinutesSince(env, telegramId, sinceIso);
}

// محاسبه زمان یکتای کار از اجتماع بازه‌ها؛ مبنای گزارش روزانه، ماهانه و درآمد.
export async function workedMinutesSince(env, telegramId, sinceIso) {
  const { results } = await env.DB.prepare(
    "SELECT id, check_in, check_out, duration_minutes FROM attendance WHERE telegram_id = ? AND check_in < ? AND (check_out >= ? OR check_out IS NULL)"
  ).bind(telegramId, new Date().toISOString(), sinceIso).all();
  return mergeAttendanceIntervals(results || [], { from: new Date(sinceIso).getTime(), to: Date.now() })
    .reduce((sum, interval) => sum + interval.duration_minutes, 0);
}


export async function getShiftsOnDate(env, telegramId, dayStartIso, dayEndIso) {
  const { results } = await env.DB.prepare(
    "SELECT id, check_in, check_out, duration_minutes FROM attendance WHERE telegram_id = ? AND check_in >= ? AND check_in < ? ORDER BY check_in ASC, id ASC"
  ).bind(telegramId, dayStartIso, dayEndIso).all();
  return results || [];
}

export async function appendDayAttendance(env, telegramId, shifts) {
  if (!shifts.length) return;
  await env.DB.batch(shifts.map((shift) => env.DB.prepare(
    "INSERT INTO attendance (telegram_id, check_in, check_out, duration_minutes) VALUES (?, ?, ?, ?)"
  ).bind(telegramId, shift.check_in, shift.check_out, shift.duration_minutes)));
}

export async function deleteShiftsByIds(env, telegramId, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare("DELETE FROM attendance WHERE telegram_id = ? AND id IN (" + placeholders + ")")
    .bind(telegramId, ...ids).run();
}

export async function deleteDayAttendance(env, telegramId, dayStartIso, dayEndIso) {
  await env.DB.prepare(
    "DELETE FROM attendance WHERE telegram_id = ? AND check_in >= ? AND check_in < ?"
  ).bind(telegramId, dayStartIso, dayEndIso).run();
}


// درآمد را بر اساس زمان حضور هم‌زمان دو کارمند مشمول حقوق تقسیم می‌کند.
// ابتدا بازه‌های خام هر فرد جداگانه ادغام می‌شوند تا ثبت‌های تکراری یک نفر حقوق مضاعف نسازند.
// سپس خط زمانی به قطعه‌های بدون تغییرِ تعداد افراد حاضر شکسته می‌شود؛ هر قطعه فقط یک نرخ ساعتی دارد.
export async function payrollDistributionSince(env, sinceIso, hourlyRateToman) {
  const now = new Date();
  const nowIso = now.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, telegram_id, check_in, check_out
     FROM attendance
     WHERE telegram_id IN (?, ?)
       AND check_in < ?
       AND (check_out >= ? OR check_out IS NULL)`
  ).bind(...PAYROLL_EMPLOYEE_IDS, nowIso, sinceIso).all();

  const rangeStart = new Date(sinceIso).getTime();
  const rangeEnd = now.getTime();
  const intervalsByEmployee = Object.fromEntries(PAYROLL_EMPLOYEE_IDS.map((id) => [
    String(id),
    mergeAttendanceIntervals(
      (results || []).filter((row) => Number(row.telegram_id) === id),
      { from: rangeStart, to: rangeEnd }
    )
  ]));

  const boundaries = [...new Set(
    Object.values(intervalsByEmployee).flatMap((items) =>
      items.flatMap((item) => [item.start, item.end])
    )
  )].sort((a, b) => a - b);

  const allocatedMilliseconds = Object.fromEntries(PAYROLL_EMPLOYEE_IDS.map((id) => [String(id), 0]));

  // در هر قطعه، نرخ پایه فروشگاه فقط یک بار بین افراد واجد شرایطِ حاضر تقسیم می‌شود.
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    const activeIds = PAYROLL_EMPLOYEE_IDS.filter((id) =>
      intervalsByEmployee[String(id)].some((item) => item.start <= start && item.end >= end)
    );
    if (!activeIds.length) continue;

    const share = (end - start) / activeIds.length;
    for (const id of activeIds) allocatedMilliseconds[String(id)] += share;
  }

  return Object.fromEntries(PAYROLL_EMPLOYEE_IDS.map((id) => {
    const allocatedMs = allocatedMilliseconds[String(id)];
    return [String(id), {
      allocatedMinutes: allocatedMs / 60000,
      incomeToman: Math.round(allocatedMs * hourlyRateToman / 3600000)
    }];
  }));
}
