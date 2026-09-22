# purpleair-notify

Receive an email alert via GitHub Actions whenever your selected [PurpleAir][purpleair] sensor(s) report air quality PM2.5 as unhealthy.

![AQI PM2.5 Table](/aqi_pm25_table.png?raw=true)

---

## How It Works

1. A scheduled GitHub Actions workflow runs periodically (default: twice an hour at `:17` and `:47`) or manually via `workflow_dispatch`.
2. It queries the **PurpleAir API v1** for current PM2.5 values of your configured sensors.
3. If PM2.5 exceeds the threshold (default: `60` for outside, `30` for inside) **and** the previous run was not already failing, the workflow run fails.
4. GitHub automatically sends you an email alerting you that the workflow failed. Because it checks the previous run status, it avoids sending duplicate notification emails every 30 minutes while the air remains unhealthy.

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

### 3. Configure GitHub Secrets
In your repository, go to **Settings > Secrets and variables > Actions** and add the following repository secrets:

| Secret | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PURPLEAIR_API_KEY` | **Yes** | — | PurpleAir v1 Read API key |
| `SENSOR_IDS` | Optional | `19189,62565` | Comma-separated PurpleAir sensor IDs to monitor |
| `OUTSIDE_THRESHOLD` | Optional | `60` | PM2.5 concentration threshold for outdoor sensors |
| `INSIDE_THRESHOLD` | Optional | `30` | PM2.5 concentration threshold for indoor sensors |

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
