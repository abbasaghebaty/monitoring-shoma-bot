# Accounting monthly-income API

The Worker exposes a separate, read-only endpoint for the accounting dashboard:

`GET /api/v1/me/monthly-income`

Authentication: `Authorization: Bearer <ACCOUNTING_API_TOKEN>`

Configure the same random token as a Cloudflare Worker Secret in both projects:
- In this Worker: `ACCOUNTING_API_TOKEN`
- In the accounting Worker: `MONITORING_API_TOKEN`

The endpoint returns the current Persian-calendar month attendance and income for Abbas. Income is calculated on the Worker using the shared payroll rule and the 17,000 toman hourly shop rate: Abbas and Sadegh split the rate only during their actual overlapping attendance intervals. Non-overlapping time is paid at the full rate to the employee who is present. Other employees, including the father accounts, do not participate in wage allocation. Open shifts are included up to the current time.

This route is separate from Telegram webhook POST handling and does not change the bot's commands, menus, or database schema. It does not write to D1.
