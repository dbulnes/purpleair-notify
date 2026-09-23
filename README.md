# purpleair-notify

Receive a complete email alert whenever your selected [PurpleAir][purpleair] sensor(s) report air quality PM2.5 as unhealthy—without opening or signing in to GitHub.

![AQI PM2.5 Table](/aqi_pm25_table.png?raw=true)

---

## How It Works

1. A scheduled GitHub Actions workflow runs periodically (default: twice an hour at `:17` and `:47`) or manually via `workflow_dispatch`.
2. It queries the **PurpleAir API v1** for current PM2.5 values of your configured sensors.
3. If PM2.5 first exceeds the threshold (default: `60` for outside, `30` for inside), it sends a formatted email through [Resend][resend] containing every sensor reading, threshold, AQI status, and the check time.
4. The workflow remains failed for as long as any sensor is above its threshold. This state suppresses repeat emails during the same unhealthy-air event.
5. When every sensor returns below its threshold, it sends one recovery email and the workflow returns to a successful state.

The alert and recovery emails contain all relevant information and do not require a GitHub link or sign-in.

### Email Notification Behavior

- **New alert:** Sends one `⚠️ Unhealthy air` email when one or more sensors first cross their thresholds.
- **Ongoing event:** Keeps each unhealthy workflow run failed, but suppresses repeat emails while readings remain elevated.
- **Recovery:** Sends one `✅ Air quality recovered` email after every monitored sensor returns below its threshold.
- **Manual test:** The workflow's `send_test_email` option sends a `🧪 PurpleAir email test` containing the current readings.
- **Complete message:** Both HTML and plain-text versions include the sensor name, location type, PM2.5 reading, threshold, AQI category, status, and check time.
- **Duplicate protection:** Each Resend request includes an idempotency key tied to the GitHub workflow run.

Deduplication reads the latest completed run of `scrape.yml` specifically, so unrelated CI workflows cannot reset the alert state.

---

## Setup & Configuration

### 1. Get a PurpleAir Read API Key
PurpleAir API v1 requires a Read API key:
1. Visit [develop.purpleair.com](https://develop.purpleair.com/).
2. Create or log in to your PurpleAir account and generate a free **Read API Key**.

### 2. Find Your Sensor ID(s)
1. Navigate to the [PurpleAir Map][purpleair].
2. Click on the sensor you want to monitor.
3. Look at the URL or click the sensor details to find its integer sensor index (e.g. `19189`).

### 3. Create a Resend Account and API Key

1. Go to [resend.com][resend] and select **Get Started**.
2. Create an account and verify your email address.
3. In the Resend dashboard, open **API Keys** and select **Create API Key**.
4. Name it `PurpleAir Notify`.
5. Choose **Sending access**. If Resend asks for a domain restriction, select the domain you intend to send from.
6. Create the key and copy the value beginning with `re_`. Resend only shows the complete key once.

For the first test, you can use the built-in `onboarding@resend.dev` sender. Set `ALERT_EMAIL` to the same address you used for your Resend account. For regular use or additional recipients, [verify a domain in Resend](https://resend.com/docs/dashboard/domains/introduction) and configure `ALERT_FROM_EMAIL` as described below.

### 4. Configure GitHub Secrets

In your repository, go to **Settings > Secrets and variables > Actions > Secrets**, then select **New repository secret** for each value below.

| Secret | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PURPLEAIR_API_KEY` | **Yes** | — | PurpleAir v1 Read API key |
| `RESEND_API_KEY` | **Yes** | — | Resend API key beginning with `re_` |
| `ALERT_EMAIL` | **Yes** | — | Recipient address; comma-separate multiple addresses |
| `SENSOR_IDS` | Optional | `19189,62565` | Comma-separated PurpleAir sensor IDs to monitor |
| `OUTSIDE_THRESHOLD` | Optional | `60` | PM2.5 concentration threshold for outdoor sensors |
| `INSIDE_THRESHOLD` | Optional | `30` | PM2.5 concentration threshold for indoor sensors |

Do not put API keys directly in the workflow file or commit them to the repository.

### 5. Configure Optional GitHub Variables

On the same GitHub page, open **Variables** and add either of these if needed:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ALERT_FROM_EMAIL` | `PurpleAir Notify <onboarding@resend.dev>` | Sender name and address. The address must use a domain verified in Resend. Example: `PurpleAir Notify <alerts@example.com>` |
| `ALERT_TIME_ZONE` | `UTC` | IANA time zone used in the email timestamp. Example: `America/Los_Angeles` |

### 6. Send a Test Email

1. Open the repository's **Actions** tab.
2. Select **PurpleAir Check**.
3. Select **Run workflow**.
4. Check **Send a test email containing the current readings**.
5. Select the green **Run workflow** button.
6. Confirm that the email arrives and contains the sensor readings. Check the spam folder if necessary.

If a sensor is currently over threshold, the test run will still fail intentionally because unhealthy runs are used as the deduplication state.

### 7. Turn Off GitHub's Generic Actions Emails

Only do this after the custom test email succeeds:

1. Open your GitHub [notification settings](https://github.com/settings/notifications).
2. Under **System**, find **Actions**.
3. Select **Don't notify** and save the setting.

This stops the generic “All jobs have failed” messages. Custom PurpleAir alert and recovery emails will continue to arrive through Resend. GitHub's Actions notification choice is an account-level setting, so it also affects workflow emails from other watched repositories.

### 8. Optional: Send From Your Own Domain

The default Resend sender is convenient for the initial test. To use an address such as `alerts@yourdomain.com`:

1. In Resend, open **Domains** and select **Add Domain**.
2. Add the DNS records shown by Resend and wait for the domain status to become **Verified**.
3. In GitHub, add the Actions variable `ALERT_FROM_EMAIL` with a value such as `PurpleAir Notify <alerts@yourdomain.com>`.
4. Run another test email.

---

## Local Development

### Prerequisites
- Node.js 20+ (or Node 22/24/25)
- npm

### Installation
```bash
npm install
```

### Run Tests & Typecheck
```bash
# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Typecheck TypeScript
npm run typecheck

# Build TypeScript to dist/
npm run build
```

### Test AQI Check Locally
```bash
PURPLEAIR_API_KEY="your-read-api-key" SENSOR_IDS="19189" npm run scrape
```

---

## License
MIT

[purpleair]: https://map.purpleair.com/
[secrets]: https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
[resend]: https://resend.com/
