import { describe, expect, it } from 'vitest'
import { coerceReasoningEffortForModel, getSupportedReasoningEfforts } from './modelReasoningEfforts'

describe('model reasoning effort support', () => {
  it('limits GPT 5.5 to low through extra high', () => {
    expect(getSupportedReasoningEfforts('gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(coerceReasoningEffortForModel('gpt-5.5', 'max')).toBe('xhigh')
  })

  it('allows max for GPT 5.6 Luna and ultra for GPT 5.6 Sol/Terra', () => {
    expect(getSupportedReasoningEfforts('gpt-5.6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(getSupportedReasoningEfforts('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(getSupportedReasoningEfforts('gpt-5.6-terra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })
})
