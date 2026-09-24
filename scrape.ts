import axios from 'axios';
import * as core from '@actions/core';

export type Threshold = {
  outside: number;
  inside: number;
};

export type AQIRange = {
  cutoff: number;
  label: string;
};

export type NotificationKind = 'alert' | 'recovery' | 'test';

export interface NotificationEmail {
  subject: string;
  text: string;
  html: string;
}

export const AQI_TABLE: AQIRange[] = [
  { cutoff: 12, label: 'good' }, // AQI 0-50
  { cutoff: 35.4, label: 'moderate' }, // AQI 51-100
  { cutoff: 55.4, label: 'unhealthy for sensitive groups' }, // AQI 101-150
  { cutoff: 150.4, label: 'unhealthy' }, // AQI 151-200
  { cutoff: 250.4, label: 'very unhealthy' }, // AQI 201-300
  { cutoff: 350.4, label: 'hazardous' }, // AQI 301-400
  { cutoff: 500.4, label: 'hazardous' }, // AQI 401-500
];

export function getAqiLabel(pm25: number): string {
  if (pm25 < 0) return 'good';
  for (const row of AQI_TABLE) {
    if (pm25 <= row.cutoff) return row.label;
  }
  return 'hazardous';
}

export function parseLocationType(locationType: unknown): 'outside' | 'inside' {
  if (locationType === 1 || locationType === '1' || locationType === 'inside') {
    return 'inside';
  }
  return 'outside';
}

export function getThreshold(sensorType: 'outside' | 'inside'): number {
  if (sensorType === 'inside') {
    const envVal = process.env.INSIDE_THRESHOLD;
    if (envVal && !isNaN(parseFloat(envVal))) return parseFloat(envVal);
    return 30;
  }
  const envVal = process.env.OUTSIDE_THRESHOLD;
  if (envVal && !isNaN(parseFloat(envVal))) return parseFloat(envVal);
  return 60;
}

export async function getLastBuildStatus(
  repo: string = process.env.GITHUB_REPOSITORY || 'dbulnes/purpleair-notify',
  token: string | undefined = process.env.GITHUB_TOKEN || process.env.GH_PAT,
  workflowFile: string = 'scrape.yml'
): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'purpleair-notify',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await axios.get(url, { headers, timeout: 10000 });
    const runs = response.data?.workflow_runs;
    if (Array.isArray(runs)) {
      for (const build of runs) {
        if (build.status === 'completed') {
          return build.conclusion || 'unknown';
        }
      }
    }
    return 'unknown';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not retrieve previous build status from GitHub API (${msg}). Continuing.`);
    return 'unknown';
  }
}

export interface CheckAqiResult {
  sensorId: string;
  sensorName: string;
  pm25: number;
  threshold: number;
  sensorType: 'outside' | 'inside';
  aqiLabel: string;
  isOverThreshold: boolean;
  message: string;
}

export async function checkAqi(
  sensorId: string,
  apiKey?: string
): Promise<CheckAqiResult> {
  const key = apiKey || process.env.PURPLEAIR_API_KEY || process.env.PURPLEAIR_READ_KEY;
  if (!key) {
    throw new Error(
      'Missing PurpleAir API key. PurpleAir API v1 requires a read API key. ' +
      'Please set PURPLEAIR_API_KEY (obtainable from https://develop.purpleair.com).'
    );
  }

  const url = `https://api.purpleair.com/v1/sensors/${encodeURIComponent(sensorId)}?fields=name,location_type,pm2.5,pm2.5_cf_1,pm2.5_atm`;
  const response = await axios.get(url, {
    headers: {
      'X-API-Key': key,
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  const sensorData = response.data?.sensor || (Array.isArray(response.data?.results) ? response.data.results[0] : null);
  if (!sensorData) {
    throw new Error(`Unexpected response structure from PurpleAir for sensor ID: ${sensorId}`);
  }

  const rawPm25 = sensorData['pm2.5'] ?? sensorData['pm2.5_cf_1'] ?? sensorData['pm2.5_atm'] ?? sensorData['pm2_5_cf_1'];
  const pm25 = typeof rawPm25 === 'number' ? rawPm25 : parseFloat(rawPm25);
  if (isNaN(pm25)) {
    throw new Error(`Invalid PM2.5 value received for sensor ID ${sensorId}: ${rawPm25}`);
  }

  const sensorName: string = sensorData.name || sensorData.Label || `Sensor ${sensorId}`;
  const sensorType = parseLocationType(sensorData.location_type ?? sensorData.DEVICE_LOCATIONTYPE);
  const threshold = getThreshold(sensorType);
  const aqiLabel = getAqiLabel(pm25);
  const isOverThreshold = pm25 >= threshold;

  const comparison = isOverThreshold ? `Over ${threshold} threshold!` : `Lower than ${threshold} threshold.`;
  const message = `Air quality ${aqiLabel}. PM2.5 ${pm25}. ${comparison} From ${sensorName} (${sensorId})`;

  console.log(message);

  return {
    sensorId,
    sensorName,
    pm25,
    threshold,
    sensorType,
    aqiLabel,
    isOverThreshold,
    message,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatCheckedAt(checkedAt: Date): string {
  const configuredTimeZone = process.env.ALERT_TIME_ZONE || 'UTC';

  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: configuredTimeZone,
      timeZoneName: 'short',
    }).format(checkedAt);
  } catch {
    console.warn(`Invalid ALERT_TIME_ZONE "${configuredTimeZone}"; using UTC.`);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(checkedAt);
  }
}

export function getNotificationKind(
  results: CheckAqiResult[],
  prevStatus: string,
  forceAlert: boolean,
  sendTestEmail: boolean
): NotificationKind | null {
  if (sendTestEmail) return 'test';

  const anyOverThreshold = results.some((result) => result.isOverThreshold);
  if (anyOverThreshold && (prevStatus !== 'failure' || forceAlert)) return 'alert';
  if (!anyOverThreshold && prevStatus === 'failure') return 'recovery';
  return null;
}

export function buildNotificationEmail(
  kind: NotificationKind,
  results: CheckAqiResult[],
  checkedAt: Date = new Date()
): NotificationEmail {
  const overThreshold = results.filter((result) => result.isOverThreshold);
  const highestReading = [...results].sort((a, b) => b.pm25 - a.pm25)[0];

  let subject: string;
  let heading: string;
  let intro: string;
  let accentColor: string;
  let accentBackground: string;
  let accentBorder: string;
  let statusLabel: string;

  if (kind === 'alert') {
    if (overThreshold.length === 1) {
      const sensor = overThreshold[0];
      subject = `⚠️ Unhealthy air — ${sensor.sensorName}: ${sensor.pm25} µg/m³`;
    } else {
      subject = `⚠️ Air quality alert — ${overThreshold.length} sensors over threshold`;
    }
    heading = 'Air quality alert';
    intro = `${overThreshold.length} sensor${overThreshold.length === 1 ? ' is' : 's are'} over the configured PM2.5 threshold.`;
    accentColor = '#f08ca5';
    accentBackground = '#321c28';
    accentBorder = '#623246';
    statusLabel = 'Threshold exceeded';
  } else if (kind === 'recovery') {
    subject = '✅ Air quality recovered — all sensors below threshold';
    heading = 'Air quality has recovered';
    intro = 'All monitored sensors are now below their configured PM2.5 thresholds.';
    accentColor = '#72e1c2';
    accentBackground = '#17382c';
    accentBorder = '#265d49';
    statusLabel = 'Air quality recovered';
  } else {
    subject = highestReading
      ? `🧪 PurpleAir email test — ${results.length} sensor${results.length === 1 ? '' : 's'} checked`
      : '🧪 PurpleAir email test';
    heading = 'PurpleAir email test';
    intro = 'Email delivery is configured correctly. The latest sensor readings are shown below.';
    accentColor = '#70cfff';
    accentBackground = '#152e3c';
    accentBorder = '#28536a';
    statusLabel = 'Delivery test';
  }

  const checkedAtText = formatCheckedAt(checkedAt);
  const textRows = results.map((result) => [
    `${result.sensorName} (${result.sensorId})`,
    `  Location: ${result.sensorType}`,
    `  PM2.5: ${result.pm25} µg/m³`,
    `  Threshold: ${result.threshold} µg/m³`,
    `  Air quality: ${result.aqiLabel}`,
    `  Status: ${result.isOverThreshold ? 'OVER THRESHOLD' : 'Below threshold'}`,
  ].join('\n'));

  const text = [
    heading,
    '',
    intro,
    '',
    ...textRows.flatMap((row) => [row, '']),
    `Checked: ${checkedAtText}`,
  ].join('\n');

  const sensorCards = results.map((result) => {
    const statusColor = result.isOverThreshold ? '#f08ca5' : '#72e1c2';
    const statusText = result.isOverThreshold ? 'Over threshold' : 'Below threshold';
    const aqiPalette = result.aqiLabel === 'good'
      ? { color: '#72e1c2', background: '#17382c', border: '#265d49' }
      : result.aqiLabel === 'moderate'
      ? { color: '#e8d174', background: '#38351a', border: '#5d5726' }
      : result.aqiLabel === 'unhealthy for sensitive groups'
      ? { color: '#f0a85d', background: '#3d2c17', border: '#6b4c24' }
      : result.aqiLabel === 'unhealthy'
      ? { color: '#f27d88', background: '#3f1f24', border: '#6e2f39' }
      : result.aqiLabel === 'very unhealthy'
      ? { color: '#c88df2', background: '#321c38', border: '#572d63' }
      : { color: '#e26388', background: '#32111c', border: '#5d1b31' };

    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 12px;border:1px solid #263448;border-radius:14px;border-collapse:separate;background:#0a1220">
        <tr>
          <td class="sensor-card" style="padding:21px 22px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:0 12px 0 0;vertical-align:top">
                  <div style="color:#edf1f8;font-size:16px;font-weight:600;line-height:1.35">${escapeHtml(result.sensorName)}</div>
                  <div style="margin-top:5px;color:#71829d;font-size:11px;line-height:1.5;text-transform:uppercase;letter-spacing:1px">${escapeHtml(result.sensorId)} &nbsp;·&nbsp; ${escapeHtml(result.sensorType)}</div>
                </td>
                <td align="right" style="padding:0;vertical-align:top">
                  <span style="display:inline-block;padding:5px 9px;border:1px solid ${aqiPalette.border};border-radius:999px;background:${aqiPalette.background};color:${aqiPalette.color};font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap">${escapeHtml(result.aqiLabel)}</span>
                </td>
              </tr>
            </table>
            <div class="reading" style="margin:19px 0 18px;color:${aqiPalette.color};font-size:42px;font-weight:450;line-height:1;letter-spacing:-1.8px;font-variant-numeric:tabular-nums">
              ${result.pm25}<span style="margin-left:7px;color:#92a2b7;font-size:14px;font-weight:400;letter-spacing:0;white-space:nowrap">µg/m³</span>
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #263448">
              <tr>
                <td style="padding:14px 10px 0 0;color:#8fa0b7;font-size:11px;line-height:1.5">Threshold&nbsp; <strong style="color:#d7dfec;font-weight:600">${result.threshold} µg/m³</strong></td>
                <td align="right" style="padding:14px 0 0 10px;color:${statusColor};font-size:11px;font-weight:700;line-height:1.5;white-space:nowrap"><span style="font-size:13px">●</span>&nbsp; ${statusText}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <style>
      @media only screen and (max-width:600px) {
        .email-shell { padding:20px 10px !important; }
        .main-card { border-radius:16px !important; }
        .header { padding:26px 20px 22px !important; }
        .sensors { padding:0 12px 10px !important; }
        .sensor-card { padding:18px 16px !important; }
        .reading { font-size:36px !important; }
        .footer { padding:18px 20px 24px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#060914;color:#f2f5fb;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(intro)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#060914">
      <tr>
        <td class="email-shell" align="center" style="padding:36px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border-collapse:collapse">
            <tr>
              <td style="padding:0 4px 24px">
                <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                  <tr>
                    <td style="width:38px;height:38px;border:1px solid #9f8ff1;border-radius:12px;background:#765fd4;color:#ffffff;font-size:24px;font-weight:600;line-height:38px;text-align:center;vertical-align:middle">≈</td>
                    <td style="padding-left:11px;color:#f7f7ff;font-size:22px;font-weight:650;line-height:1;letter-spacing:-.7px">purpleair notify<span style="color:#c1b7ff">.</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="main-card" style="overflow:hidden;border:1px solid #2b3646;border-radius:20px;background:#0d1423;box-shadow:0 22px 55px rgba(0,0,0,.24)">
                <div style="height:3px;background:${accentColor};font-size:0;line-height:0">&nbsp;</div>
                <div class="header" style="padding:32px 30px 27px">
                  <span style="display:inline-block;padding:6px 10px;border:1px solid ${accentBorder};border-radius:999px;background:${accentBackground};color:${accentColor};font-size:10px;font-weight:700;line-height:1;letter-spacing:1.2px;text-transform:uppercase">${escapeHtml(statusLabel)}</span>
                  <h1 style="margin:19px 0 10px;color:#f5f6fb;font-size:34px;font-weight:560;line-height:1.15;letter-spacing:-1.3px">${escapeHtml(heading)}</h1>
                  <p style="max-width:540px;margin:0;color:#a5b2c8;font-size:15px;line-height:1.65">${escapeHtml(intro)}</p>
                </div>
                <div class="sensors" style="padding:0 20px 14px">${sensorCards}</div>
                <div class="footer" style="padding:20px 30px 28px;border-top:1px solid #263448;color:#71829d;font-size:11px;line-height:1.6">
                  <span style="color:#8f9db5;font-size:9px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase">Observatory reading</span>
                  <div style="margin-top:7px;color:#a5b2c8">Checked ${escapeHtml(checkedAtText)}</div>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendNotificationEmail(
  kind: NotificationKind,
  results: CheckAqiResult[],
  checkedAt: Date = new Date()
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.ALERT_EMAIL || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);

  if (!apiKey || recipients.length === 0) {
    throw new Error(
      'Email notification requested, but RESEND_API_KEY or ALERT_EMAIL is missing. ' +
      'Add both as GitHub Actions repository secrets.'
    );
  }

  const from = process.env.ALERT_FROM_EMAIL || 'PurpleAir Notify <onboarding@resend.dev>';
  const email = buildNotificationEmail(kind, results, checkedAt);
  const runId = process.env.GITHUB_RUN_ID || checkedAt.getTime().toString();

  await axios.post(
    'https://api.resend.com/emails',
    {
      from,
      to: recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `purpleair-notify/${kind}/${runId}`,
        'User-Agent': 'purpleair-notify',
      },
      timeout: 15000,
    }
  );

  console.log(`${kind[0].toUpperCase()}${kind.slice(1)} email sent to ${recipients.join(', ')}.`);
}

export async function writeJobSummary(results: CheckAqiResult[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  try {
    const tableRows = [
      [
        { data: 'Sensor', header: true },
        { data: 'Type', header: true },
        { data: 'PM2.5', header: true },
        { data: 'Threshold', header: true },
        { data: 'AQI Status', header: true },
        { data: 'Result', header: true },
      ],
      ...results.map((r) => [
        `${r.sensorName} (${r.sensorId})`,
        r.sensorType,
        `${r.pm25} µg/m³`,
        `${r.threshold} µg/m³`,
        r.aqiLabel,
        r.isOverThreshold ? '⚠️ Over Threshold' : '✅ Below Threshold',
      ]),
    ];

    await core.summary
      .addHeading('PurpleAir AQI Report', 2)
      .addTable(tableRows)
      .write();
  } catch (err) {
    console.warn(`Could not write GitHub step summary: ${err instanceof Error ? err.message : err}`);
  }
}

export async function scrape(): Promise<void> {
  const sensorIdsStr = process.env.SENSOR_IDS || '19189,62565';
  const forceAlert = process.env.FORCE_ALERT === 'true' || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const sendTestEmail = process.env.SEND_TEST_EMAIL === 'true';

  const sensorIds = sensorIdsStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sensorIds.length === 0) {
    console.warn('No sensor IDs configured. Set SENSOR_IDS environment variable.');
    return;
  }

  const prevStatus = await getLastBuildStatus();
  console.log(`Previous GitHub Actions build conclusion: ${prevStatus}`);
  if (forceAlert && prevStatus === 'failure') {
    console.log('Force alert enabled (manual workflow run or FORCE_ALERT=true): alerting regardless of previous failure.');
  }

  const results: CheckAqiResult[] = [];

  for (const sensorId of sensorIds) {
    try {
      const result = await checkAqi(sensorId);
      results.push(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error checking sensor ${sensorId}: ${msg}`);
      core.setFailed(`Failed to check sensor ${sensorId}: ${msg}`);
      throw error;
    }
  }

  await writeJobSummary(results);

  const notificationKind = getNotificationKind(results, prevStatus, forceAlert, sendTestEmail);
  if (notificationKind) {
    await sendNotificationEmail(notificationKind, results);
  }

  const failedResults = results.filter((result) => result.isOverThreshold);
  if (failedResults.length > 0) {
    // Every unhealthy run must remain failed. The previous run's conclusion is the
    // durable alert-state marker that suppresses repeat emails until recovery.
    const failureMessages = failedResults.map((result) => result.message);
    throw new Error(`Unhealthy air quality detected:\n${failureMessages.join('\n')}`);
  }
}

if (require.main === module) {
  scrape().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
