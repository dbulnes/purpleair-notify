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

  if (kind === 'alert') {
    if (overThreshold.length === 1) {
      const sensor = overThreshold[0];
      subject = `⚠️ Unhealthy air — ${sensor.sensorName}: ${sensor.pm25} µg/m³`;
    } else {
      subject = `⚠️ Air quality alert — ${overThreshold.length} sensors over threshold`;
    }
    heading = 'Air quality alert';
    intro = `${overThreshold.length} sensor${overThreshold.length === 1 ? ' is' : 's are'} over the configured PM2.5 threshold.`;
    accentColor = '#b42318';
  } else if (kind === 'recovery') {
    subject = '✅ Air quality recovered — all sensors below threshold';
    heading = 'Air quality has recovered';
    intro = 'All monitored sensors are now below their configured PM2.5 thresholds.';
    accentColor = '#067647';
  } else {
    subject = highestReading
      ? `🧪 PurpleAir email test — ${results.length} sensor${results.length === 1 ? '' : 's'} checked`
      : '🧪 PurpleAir email test';
    heading = 'PurpleAir email test';
    intro = 'Email delivery is configured correctly. The latest sensor readings are shown below.';
    accentColor = '#175cd3';
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

  const tableRows = results.map((result) => {
    const statusColor = result.isOverThreshold ? '#b42318' : '#067647';
    const statusText = result.isOverThreshold ? '⚠️ Over threshold' : '✅ Below threshold';
    return `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #eaecf0"><strong>${escapeHtml(result.sensorName)}</strong><br><span style="color:#667085">${escapeHtml(result.sensorId)} · ${escapeHtml(result.sensorType)}</span></td>
        <td style="padding:12px;border-bottom:1px solid #eaecf0">${result.pm25} µg/m³</td>
        <td style="padding:12px;border-bottom:1px solid #eaecf0">${result.threshold} µg/m³</td>
        <td style="padding:12px;border-bottom:1px solid #eaecf0;text-transform:capitalize">${escapeHtml(result.aqiLabel)}</td>
        <td style="padding:12px;border-bottom:1px solid #eaecf0;color:${statusColor};font-weight:600">${statusText}</td>
      </tr>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101828">
    <div style="max-width:720px;margin:0 auto;padding:32px 16px">
      <div style="background:#ffffff;border:1px solid #eaecf0;border-top:6px solid ${accentColor};border-radius:12px;overflow:hidden">
        <div style="padding:28px 28px 20px">
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2">${escapeHtml(heading)}</h1>
          <p style="margin:0;color:#475467;font-size:16px;line-height:1.5">${escapeHtml(intro)}</p>
        </div>
        <div style="overflow-x:auto">
          <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
            <thead style="background:#f9fafb;text-align:left">
              <tr>
                <th style="padding:10px 12px">Sensor</th>
                <th style="padding:10px 12px">PM2.5</th>
                <th style="padding:10px 12px">Threshold</th>
                <th style="padding:10px 12px">Air quality</th>
                <th style="padding:10px 12px">Status</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div style="padding:20px 28px 28px;color:#667085;font-size:13px;line-height:1.5">
          <div>Checked: ${escapeHtml(checkedAtText)}</div>
        </div>
      </div>
    </div>
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
