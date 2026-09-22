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
  token: string | undefined = process.env.GITHUB_TOKEN || process.env.GH_PAT
): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${repo}/actions/runs`;
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
  prevStatus: string,
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

  if (isOverThreshold && prevStatus !== 'failure') {
    core.setFailed(message);
  }

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

  let anyFailed = false;
  const failureMessages: string[] = [];
  const results: CheckAqiResult[] = [];

  for (const sensorId of sensorIds) {
    try {
      const result = await checkAqi(sensorId, prevStatus);
      results.push(result);
      if (result.isOverThreshold && prevStatus !== 'failure') {
        anyFailed = true;
        failureMessages.push(result.message);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error checking sensor ${sensorId}: ${msg}`);
      core.setFailed(`Failed to check sensor ${sensorId}: ${msg}`);
      throw error;
    }
  }

  await writeJobSummary(results);

  if (anyFailed) {
    throw new Error(`Unhealthy air quality detected:\n${failureMessages.join('\n')}`);
  }
}

if (require.main === module) {
  scrape().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
