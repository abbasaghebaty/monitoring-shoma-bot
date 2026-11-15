# Accounting monthly-income API

The Worker exposes a separate, read-only endpoint for the accounting dashboard:

`GET /api/v1/me/monthly-income`

Authentication: `Authorization: Bearer <ACCOUNTING_API_TOKEN>`

Configure the same random token as a Cloudflare Worker Secret in both projects:
- In this Worker: `ACCOUNTING_API_TOKEN`
- In the accounting Worker: `MONITORING_API_TOKEN`

The endpoint calculates the current Persian-calendar month income for the single active employee account named «عباس», using the existing attendance records and the configured hourly rate (16,000 toman). It includes an open shift using the same elapsed-time calculation as the existing status command.

This route is separate from Telegram webhook POST handling and does not change the bot's commands, menus, or database schema. It does not write to D1.
