import assert from 'node:assert/strict';

export interface RuntimeConfigInput {
  DATABASE_PATH?: string;
  DATA_DIR?: string;
  MEDIA_DIR?: string;
  PIPELINE_MEDIA_ROOT?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_VISION_MODEL?: string;
  DEEPSEEK_INPUT_FORMAT?: string;
  DEEPSEEK_INPUT_MODE?: string;
}

export interface RuntimeConfigSummary {
  databasePath: string;
  dataDir: string;
  mediaRoot: string;
  deepseekModel: string | null;
  deepseekInputFormat: string;
}

export function resolveRuntimeConfig(input: RuntimeConfigInput): RuntimeConfigSummary {
  return {
    databasePath: input.DATABASE_PATH?.trim() || '/data/db/app.sqlite',
    dataDir: input.DATA_DIR?.trim() || '/data',
    mediaRoot: input.PIPELINE_MEDIA_ROOT?.trim() || input.MEDIA_DIR?.trim() || '/media',
    deepseekModel: input.DEEPSEEK_MODEL?.trim() || input.DEEPSEEK_VISION_MODEL?.trim() || null,
    deepseekInputFormat: input.DEEPSEEK_INPUT_FORMAT?.trim() || input.DEEPSEEK_INPUT_MODE?.trim() || 'data_url'
  };
}

const summary = resolveRuntimeConfig({
  DATABASE_PATH: '/data/db/app.sqlite',
  DATA_DIR: '/data',
  MEDIA_DIR: '/media',
  PIPELINE_MEDIA_ROOT: '/media',
  DEEPSEEK_VISION_MODEL: 'vision-model',
  DEEPSEEK_INPUT_MODE: 'data_url'
});
assert.equal(summary.databasePath, '/data/db/app.sqlite');
assert.equal(summary.mediaRoot, '/media');
assert.equal(summary.deepseekModel, 'vision-model');
assert.equal(summary.deepseekInputFormat, 'data_url');
process.stdout.write('runtime config smoke: aliases and named-volume paths resolve\n');

