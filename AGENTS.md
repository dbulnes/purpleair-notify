# AGENTS.md

## Project Overview
`purpleair-notify` is a lightweight, serverless air-quality alert system. It runs on a scheduled GitHub Actions cron job, querying the PurpleAir API v1 for real-time PM2.5 sensor readings. If particulate levels exceed configured thresholds (e.g., AQI enters "unhealthy" levels), it fails the GitHub Action run to trigger a native notification email to the repository watcher/owner, with built-in deduplication so emails are not spammed during extended high-pollution events.

### Tech Stack
- **Runtime:** Node.js `>= 20`
- **Language:** TypeScript 5.x (target: ES2022, module: CommonJS)
- **HTTP Client:** Axios
- **GitHub Actions Toolkit:** `@actions/core`
- **Test Framework:** Vitest
- **Execution:** `ts-node` for script execution, `tsc` for compilation

---

## Directory & File Structure
```
purpleair-notify/
├── .github/
│   └── workflows/
│       ├── scrape.yml       # Scheduled cron + manual workflow for AQI monitoring
│       └── ci.yml           # Continuous integration (typecheck, test, build)
├── dist/                    # Compiled JavaScript (git-ignored)
├── scrape.ts                # Main logic: PurpleAir API querying, AQI & threshold checks
├── scrape.test.ts           # Vitest unit test suite
├── package.json             # NPM package manifest & scripts
├── tsconfig.json            # TypeScript configuration
├── AGENTS.md                # AI agent operations guide (this file)
└── README.md                # Human documentation & user setup guide
```

---

## Setup & Environment
- **Node.js:** Ensure Node.js `>= 20.x` is active (`node -v`).
- **Install dependencies:**
  ```bash
  npm install
  ```
  *(In CI environments, always prefer `npm ci`)*

---

## Commands & Verification

| Command | Purpose |
| :--- | :--- |
| `npm test` | Run full unit test suite with Vitest |
| `npm run test:watch` | Run Vitest in watch mode for development |
| `npm run typecheck` | Run `tsc --noEmit` to verify type safety |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run scrape` | Execute scrape script directly via `ts-node` |

### Testing AQI Check Locally
To test the scraper without triggering GitHub Actions failure:
```bash
PURPLEAIR_API_KEY="your-read-api-key" SENSOR_IDS="19189" npm run scrape
```

---

## Domain Logic & API Specifications

### 1. PurpleAir API v1
- **Endpoint:** `GET https://api.purpleair.com/v1/sensors/{sensor_index}`
- **Authentication:** Header `X-API-Key: <PURPLEAIR_API_KEY>`
- **Location Types:** `0` = Outside, `1` = Inside
- **PM2.5 Parsing:** Inspect `pm2.5`, `pm2.5_cf_1`, `pm2.5_atm`

### 2. Threshold Defaults & Overrides
- **Outside Sensors:** Default threshold is `60` µg/m³ (customizable via `OUTSIDE_THRESHOLD` env var).
- **Inside Sensors:** Default threshold is `30` µg/m³ (customizable via `INSIDE_THRESHOLD` env var).

### 3. EPA AQI PM2.5 Breakpoints
- `0.0 - 12.0`: Good (AQI 0–50)
- `12.1 - 35.4`: Moderate (AQI 51–100)
- `35.5 - 55.4`: Unhealthy for Sensitive Groups (AQI 101–150)
- `55.5 - 150.4`: Unhealthy (AQI 151–200)
- `150.5 - 250.4`: Very Unhealthy (AQI 201–300)
- `250.5+`: Hazardous (AQI 301+)

### 4. Alert Deduplication Mechanism
- The script queries the GitHub Actions REST API (`/repos/${repo}/actions/runs`) to find the latest completed run's conclusion.
- If the current PM2.5 reading exceeds the threshold:
  - If `prevStatus !== 'failure'`, `core.setFailed(...)` is invoked and the process terminates with an error. This prompts GitHub to send an alert email.
  - If `prevStatus === 'failure'`, the status is logged, but `core.setFailed(...)` is **skipped**. This avoids repetitive alert emails while air quality stays elevated.

---

## Coding Conventions & Guardrails

1. **Module Isolation:**
   - `scrape.ts` exports all core helper functions (`getAqiLabel`, `parseLocationType`, `getThreshold`, `getLastBuildStatus`, `checkAqi`, `scrape`).
   - Execution is guarded by `if (require.main === module)` to prevent side-effects during test imports.

2. **Error Handling:**
   - Missing `PURPLEAIR_API_KEY` must fail with an explicit, helpful instruction directing the user to `https://develop.purpleair.com`.
   - External network failures on build status lookup must fail gracefully with warnings rather than aborting the AQI check.

3. **Boundaries & Guardrails:**
   - **Never commit secrets:** Never write `.env` files with actual API keys or personal access tokens to git.
   - **Do not edit `dist/` manually:** Always modify TypeScript sources and run `npm run build`.
   - **Dependency hygiene:** Keep dependencies minimal. Validate with `npm audit` when adding or bumping packages.

---

## Commit & PR Guidelines
- Use clear conventional commit messages:
  - `feat: ...` for functional enhancements
  - `fix: ...` for bug fixes
  - `docs: ...` for documentation updates
  - `chore: ...` for dependency updates and build configurations
- Always verify `npm run typecheck && npm test && npm run build` pass with zero errors and zero warnings before committing.
