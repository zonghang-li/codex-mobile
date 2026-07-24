import type { ReasoningEffort } from '../types/codex'

export const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]

const GPT_5_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']
const GPT_5_6_LUNA_REASONING_EFFORTS: ReasoningEffort[] = [...GPT_5_REASONING_EFFORTS, 'max']
const GPT_5_6_FRONTIER_REASONING_EFFORTS: ReasoningEffort[] = [...GPT_5_6_LUNA_REASONING_EFFORTS, 'ultra']

export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] {
  const normalizedModelId = modelId.trim().toLowerCase()
  if (/^gpt-5\.6-(?:sol|terra)(?:$|-)/.test(normalizedModelId)) {
    return GPT_5_6_FRONTIER_REASONING_EFFORTS
  }
  if (/^gpt-5\.6-luna(?:$|-)/.test(normalizedModelId)) {
    return GPT_5_6_LUNA_REASONING_EFFORTS
  }
  if (/^gpt-5\.(?:4|5)(?:$|-)/.test(normalizedModelId)) {
    return GPT_5_REASONING_EFFORTS
  }
  return ALL_REASONING_EFFORTS
}

export function isReasoningEffortSupportedByModel(modelId: string, effort: ReasoningEffort): boolean {
  return getSupportedReasoningEfforts(modelId).includes(effort)
}

export function coerceReasoningEffortForModel(
  modelId: string,
  effort: ReasoningEffort | '',
): ReasoningEffort | '' {
  if (!effort) return ''
  const supported = getSupportedReasoningEfforts(modelId)
  if (supported.includes(effort)) return effort
  return supported.at(-1) ?? ''
}
