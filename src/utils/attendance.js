/**
 * Canonical attendance view: merge overlapping or directly adjacent records.
 * Raw D1 rows remain untouched so their audit trail and deletion IDs are preserved.
 */
export function mergeAttendanceIntervals(rows = [], { from = -Infinity, to = Date.now() } = {}) {
  const intervals = (rows || []).map((row) => {
    const rawStart = new Date(row.check_in).getTime();
    const rawEnd = row.check_out ? new Date(row.check_out).getTime() : to;
    const start = Math.max(rawStart, from);
    const end = Math.min(rawEnd, to);
    return { row, start, end, open: !row.check_out };
  }).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const item of intervals) {
    const current = merged[merged.length - 1];
    if (current && item.start <= current.end) {
      current.end = Math.max(current.end, item.end);
      current.open = current.open || item.open;
      current.rows.push(item.row);
      current.ids.push(item.row.id);
    } else {
      merged.push({
        start: item.start,
        end: item.end,
        open: item.open,
        rows: [item.row],
        ids: item.row.id == null ? [] : [item.row.id],
      });
    }
  }

  return merged.map((group) => ({
    ...group,
    check_in: new Date(group.start).toISOString(),
    check_out: group.open ? null : new Date(group.end).toISOString(),
    duration_minutes: Math.max(0, Math.round((group.end - group.start) / 60000)),
  }));
}
