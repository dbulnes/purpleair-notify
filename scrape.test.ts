import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import * as core from '@actions/core';
import {
  getAqiLabel,
  parseLocationType,
  getThreshold,
  getLastBuildStatus,
  checkAqi,
  getNotificationKind,
  buildNotificationEmail,
  sendNotificationEmail,
  writeJobSummary,
  scrape,
  CheckAqiResult,
} from './scrape';

vi.mock('axios');
vi.mock('@actions/core');

describe('getAqiLabel', () => {
  it('returns "good" for negative and low values', () => {
    expect(getAqiLabel(-5)).toBe('good');
    expect(getAqiLabel(0)).toBe('good');
    expect(getAqiLabel(12.0)).toBe('good');
  });

  it('returns "moderate" for values between 12.1 and 35.4', () => {
    expect(getAqiLabel(12.1)).toBe('moderate');
    expect(getAqiLabel(35.4)).toBe('moderate');
  });

  it('returns "unhealthy for sensitive groups" for values between 35.5 and 55.4', () => {
    expect(getAqiLabel(35.5)).toBe('unhealthy for sensitive groups');
    expect(getAqiLabel(55.4)).toBe('unhealthy for sensitive groups');
  });

  it('returns "unhealthy" for values between 55.5 and 150.4', () => {
    expect(getAqiLabel(55.5)).toBe('unhealthy');
    expect(getAqiLabel(150.4)).toBe('unhealthy');
  });

  it('returns "very unhealthy" for values between 150.5 and 250.4', () => {
    expect(getAqiLabel(150.5)).toBe('very unhealthy');
    expect(getAqiLabel(250.4)).toBe('very unhealthy');
  });

  it('returns "hazardous" for values above 250.4 including beyond 350.4', () => {
    expect(getAqiLabel(250.5)).toBe('hazardous');
    expect(getAqiLabel(350.4)).toBe('hazardous');
    expect(getAqiLabel(400)).toBe('hazardous');
    expect(getAqiLabel(999)).toBe('hazardous');
  });
});

describe('parseLocationType', () => {
  it('identifies outside locations', () => {
    expect(parseLocationType(0)).toBe('outside');
    expect(parseLocationType('0')).toBe('outside');
    expect(parseLocationType('outside')).toBe('outside');
    expect(parseLocationType(undefined)).toBe('outside');
    expect(parseLocationType(null)).toBe('outside');
  });

  it('identifies inside locations', () => {
    expect(parseLocationType(1)).toBe('inside');
    expect(parseLocationType('1')).toBe('inside');
    expect(parseLocationType('inside')).toBe('inside');
  });
});

describe('getThreshold', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns defaults when env vars are not set', () => {
    delete process.env.OUTSIDE_THRESHOLD;
    delete process.env.INSIDE_THRESHOLD;
    expect(getThreshold('outside')).toBe(60);
    expect(getThreshold('inside')).toBe(30);
  });

  it('respects environment variable overrides', () => {
    process.env.OUTSIDE_THRESHOLD = '45';
    process.env.INSIDE_THRESHOLD = '25';
    expect(getThreshold('outside')).toBe(45);
    expect(getThreshold('inside')).toBe(25);
  });
});

describe('checkAqi', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws an error if no API key is provided', async () => {
    delete process.env.PURPLEAIR_API_KEY;
    delete process.env.PURPLEAIR_READ_KEY;
    await expect(checkAqi('12345')).rejects.toThrow(/Missing PurpleAir API key/);
  });

  it('fetches sensor data using PurpleAir v1 API with api key', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        sensor: {
          sensor_index: 12345,
          name: 'Front Yard',
          location_type: 0,
          'pm2.5': 15.0,
        },
      },
    });

    const result = await checkAqi('12345', 'test-api-key');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/sensors/12345'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-api-key',
        }),
      })
    );
    expect(result.sensorName).toBe('Front Yard');
    expect(result.pm25).toBe(15.0);
    expect(result.aqiLabel).toBe('moderate');
    expect(result.isOverThreshold).toBe(false);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('returns an over-threshold result without deciding notification state', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        sensor: {
          sensor_index: 12345,
          name: 'Front Yard',
          location_type: 0,
          'pm2.5': 75.0,
        },
      },
    });

    const result = await checkAqi('12345', 'test-api-key');
    expect(result.isOverThreshold).toBe(true);
    expect(result.message).toContain('Over 60 threshold!');
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

const healthyResult: CheckAqiResult = {
  sensorId: '123',
  sensorName: 'Front Porch',
  pm25: 12.5,
  threshold: 60,
  sensorType: 'outside',
  aqiLabel: 'moderate',
  isOverThreshold: false,
  message: 'Air quality moderate...',
};

const unhealthyResult: CheckAqiResult = {
  ...healthyResult,
  pm25: 75,
  aqiLabel: 'unhealthy',
  isOverThreshold: true,
  message: 'Air quality unhealthy...',
};

describe('getNotificationKind', () => {
  it('sends one alert at the start of an unhealthy period', () => {
    expect(getNotificationKind([unhealthyResult], 'success', false, false)).toBe('alert');
    expect(getNotificationKind([unhealthyResult], 'failure', false, false)).toBeNull();
  });

  it('allows a forced alert for a manual run', () => {
    expect(getNotificationKind([unhealthyResult], 'failure', true, false)).toBe('alert');
  });

  it('sends a recovery after an unhealthy period', () => {
    expect(getNotificationKind([healthyResult], 'failure', false, false)).toBe('recovery');
    expect(getNotificationKind([healthyResult], 'success', false, false)).toBeNull();
  });

  it('prioritizes an explicitly requested test email', () => {
    expect(getNotificationKind([healthyResult], 'success', false, true)).toBe('test');
  });
});

describe('getLastBuildStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the conclusion of the latest completed build', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        workflow_runs: [
          { status: 'in_progress', conclusion: null },
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ],
      },
    });

    const status = await getLastBuildStatus('test/repo', 'dummy-token');
    expect(status).toBe('success');
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/test/repo/actions/workflows/scrape.yml/runs?per_page=10',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dummy-token',
        }),
      })
    );
  });

  it('returns "unknown" if no runs completed or API throws', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
    const status = await getLastBuildStatus('test/repo');
    expect(status).toBe('unknown');
  });
});

describe('email notifications', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ALERT_TIME_ZONE: 'UTC' };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds a complete alert email with no GitHub visit required', () => {
    const email = buildNotificationEmail(
      'alert',
      [{ ...unhealthyResult, sensorName: 'Front <Porch>' }],
      new Date('2026-09-22T23:17:00Z')
    );

    expect(email.subject).toContain('Front <Porch>: 75 µg/m³');
    expect(email.text).toContain('PM2.5: 75 µg/m³');
    expect(email.text).toContain('Threshold: 60 µg/m³');
    expect(email.text).not.toContain('GitHub');
    expect(email.html).toContain('Front &lt;Porch&gt;');
    expect(email.html).not.toContain('GitHub sign-in');
    expect(email.html).not.toContain('Front <Porch>');
    expect(email.html).toContain('purpleair notify');
    expect(email.html).toContain('background:#060914');
    expect(email.html).toContain('color:#f08ca5');
    expect(email.html).toContain('color:#f27d88');
  });

  it('builds a recovery email', () => {
    const email = buildNotificationEmail('recovery', [healthyResult]);
    expect(email.subject).toContain('Air quality recovered');
    expect(email.text).toContain('All monitored sensors are now below');
    expect(email.html).toContain('color:#72e1c2');
    expect(email.html).toContain('Air quality recovered');
  });

  it('sends through the Resend API with idempotency and multiple recipients', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.ALERT_EMAIL = 'one@example.com, two@example.com';
    process.env.GITHUB_RUN_ID = '98765';
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: 'email-id' } });

    await sendNotificationEmail('test', [healthyResult], new Date('2026-09-22T23:17:00Z'));

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        from: 'PurpleAir Notify <onboarding@resend.dev>',
        to: ['one@example.com', 'two@example.com'],
        subject: expect.stringContaining('PurpleAir email test'),
        text: expect.stringContaining('PM2.5: 12.5 µg/m³'),
        html: expect.stringContaining('Front Porch'),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer re_test',
          'Idempotency-Key': 'purpleair-notify/test/98765',
        }),
      })
    );
  });

  it('fails clearly when email secrets are missing', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL;

    await expect(sendNotificationEmail('alert', [unhealthyResult])).rejects.toThrow(
      /RESEND_API_KEY or ALERT_EMAIL is missing/
    );
  });
});

describe('scrape state transitions', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      SENSOR_IDS: '123',
      PURPLEAIR_API_KEY: 'purpleair-key',
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_TOKEN: 'github-token',
      GITHUB_EVENT_NAME: 'schedule',
      RESEND_API_KEY: 're_test',
      ALERT_EMAIL: 'owner@example.com',
    };
    delete process.env.FORCE_ALERT;
    delete process.env.SEND_TEST_EMAIL;
    delete process.env.GITHUB_STEP_SUMMARY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('keeps an unhealthy run failed without resending during the same event', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: { workflow_runs: [{ status: 'completed', conclusion: 'failure' }] },
      })
      .mockResolvedValueOnce({
        data: {
          sensor: {
            sensor_index: 123,
            name: 'Front Porch',
            location_type: 0,
            'pm2.5': 75,
          },
        },
      });

    await expect(scrape()).rejects.toThrow(/Unhealthy air quality detected/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('sends one recovery email and succeeds when readings return below threshold', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: { workflow_runs: [{ status: 'completed', conclusion: 'failure' }] },
      })
      .mockResolvedValueOnce({
        data: {
          sensor: {
            sensor_index: 123,
            name: 'Front Porch',
            location_type: 0,
            'pm2.5': 10,
          },
        },
      });
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: 'recovery-email-id' } });

    await expect(scrape()).resolves.toBeUndefined();
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        subject: expect.stringContaining('Air quality recovered'),
      }),
      expect.any(Object)
    );
  });
});

describe('writeJobSummary', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('skips writing summary if GITHUB_STEP_SUMMARY is not set', async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    await writeJobSummary([]);
    expect(core.summary.addHeading).not.toHaveBeenCalled();
  });

  it('writes summary table when GITHUB_STEP_SUMMARY is set', async () => {
    process.env.GITHUB_STEP_SUMMARY = '/tmp/step_summary';
    const mockSummary = {
      addHeading: vi.fn().mockReturnThis(),
      addTable: vi.fn().mockReturnThis(),
      write: vi.fn().mockResolvedValue(undefined),
    };
    (core as any).summary = mockSummary;

    const sampleResults: CheckAqiResult[] = [healthyResult];

    await writeJobSummary(sampleResults);
    expect(mockSummary.addHeading).toHaveBeenCalledWith('PurpleAir AQI Report', 2);
    expect(mockSummary.addTable).toHaveBeenCalled();
    expect(mockSummary.write).toHaveBeenCalled();
  });
});
