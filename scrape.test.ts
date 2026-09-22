import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import * as core from '@actions/core';
import {
  getAqiLabel,
  parseLocationType,
  getThreshold,
  getLastBuildStatus,
  checkAqi,
  writeJobSummary,
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
    await expect(checkAqi('12345', 'success')).rejects.toThrow(/Missing PurpleAir API key/);
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

    const result = await checkAqi('12345', 'success', 'test-api-key');
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

  it('triggers core.setFailed when over threshold and prevStatus is not failure', async () => {
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

    const result = await checkAqi('12345', 'success', 'test-api-key');
    expect(result.isOverThreshold).toBe(true);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Over 60 threshold!')
    );
  });

  it('does NOT trigger core.setFailed when over threshold if prevStatus was already failure (prevents email spam)', async () => {
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

    const result = await checkAqi('12345', 'failure', 'test-api-key');
    expect(result.isOverThreshold).toBe(true);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('triggers core.setFailed when over threshold and prevStatus is failure if forceAlert is true', async () => {
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

    const result = await checkAqi('12345', 'failure', 'test-api-key', true);
    expect(result.isOverThreshold).toBe(true);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Over 60 threshold!')
    );
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
      'https://api.github.com/repos/test/repo/actions/runs',
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

    const sampleResults: CheckAqiResult[] = [
      {
        sensorId: '123',
        sensorName: 'Front Porch',
        pm25: 12.5,
        threshold: 60,
        sensorType: 'outside',
        aqiLabel: 'moderate',
        isOverThreshold: false,
        message: 'Air quality moderate...',
      },
    ];

    await writeJobSummary(sampleResults);
    expect(mockSummary.addHeading).toHaveBeenCalledWith('PurpleAir AQI Report', 2);
    expect(mockSummary.addTable).toHaveBeenCalled();
    expect(mockSummary.write).toHaveBeenCalled();
  });
});
