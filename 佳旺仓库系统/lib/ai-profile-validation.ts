import type { AIProfileConfig, AIProfileInput } from './ai-profiles';
import { parseDeepSeekConfigInput, ValidationError } from './validation';

export function parseAIProfileInput(value: unknown): AIProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('请求体必须是对象');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw new ValidationError('name 无效', { name: 'invalid' });
  if (!['deepseek', 'openai', 'openai_compatible'].includes(String(body.provider))) {
    throw new ValidationError('provider 无效', { provider: 'invalid' });
  }
  return {
    name,
    provider: body.provider as AIProfileInput['provider'],
    config: parseDeepSeekConfigInput(body.config) as AIProfileConfig,
    clearApiKey: body.clearApiKey === true,
  };
}
