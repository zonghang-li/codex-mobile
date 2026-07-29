export type SnapshotTextStreamInput = {
  id: string
  text: string
  commandOutput?: string
  streamable: boolean
  renderable?: boolean
}

type SnapshotTextStreamEntry = {
  displayText: string
  targetText: string
  displayCommandOutput: string
  targetCommandOutput: string
  streamable: boolean
}

type SnapshotTextStreamCarry = Pick<
  SnapshotTextStreamEntry,
  'displayText' | 'displayCommandOutput'
>

export type SnapshotTextStreamerOptions = {
  textChunkSize?: number
  outputChunkSize?: number
}

export type SnapshotTextStreamerUpdate = {
  changed: boolean
  pending: boolean
}

export type SnapshotTextStreamer = {
  update(inputs: readonly SnapshotTextStreamInput[]): SnapshotTextStreamerUpdate
  advance(): boolean
  hasPending(): boolean
  readText(id: string): string | undefined
  readCommandOutput(id: string): string | undefined
  reset(): void
}

function revealChunk(current: string, target: string, chunkSize: number): string {
  if (current === target) return current
  if (!target.startsWith(current) || target.length < current.length) return target
  return target.slice(0, Math.min(target.length, current.length + chunkSize))
}

export function createSnapshotTextStreamer(options: SnapshotTextStreamerOptions = {}): SnapshotTextStreamer {
  const textChunkSize = Math.max(1, Math.floor(options.textChunkSize ?? 48))
  const outputChunkSize = Math.max(1, Math.floor(options.outputChunkSize ?? 96))
  const entries = new Map<string, SnapshotTextStreamEntry>()

  const findCarryFor = (targetText: string, targetCommandOutput: string): SnapshotTextStreamCarry | null => {
    let best: SnapshotTextStreamCarry | null = null
    let bestScore = -1

    for (const entry of entries.values()) {
      if (!entry.streamable) continue
      if (!targetText.startsWith(entry.displayText)) continue
      if (!targetCommandOutput.startsWith(entry.displayCommandOutput)) continue

      const score = entry.displayText.length + entry.displayCommandOutput.length
      if (score <= bestScore) continue

      best = {
        displayText: entry.displayText,
        displayCommandOutput: entry.displayCommandOutput,
      }
      bestScore = score
    }

    return best
  }

  const hasPending = (): boolean => {
    for (const entry of entries.values()) {
      if (!entry.streamable) continue
      if (entry.displayText !== entry.targetText) return true
      if (entry.displayCommandOutput !== entry.targetCommandOutput) return true
    }
    return false
  }

  return {
    update(inputs) {
      let changed = false
      const keepIds = new Set<string>()
      let latestStreamableInputId = ''

      for (const input of inputs) {
        if (input.streamable && input.renderable !== false) {
          latestStreamableInputId = input.id
        }
      }

      for (const input of inputs) {
        keepIds.add(input.id)
        const streamable = input.streamable && input.renderable !== false && input.id === latestStreamableInputId
        const targetCommandOutput = input.commandOutput ?? ''
        const previous = entries.get(input.id)

        if (!previous) {
          const carry = streamable ? findCarryFor(input.text, targetCommandOutput) : null
          const displayText = carry
            ? carry.displayText
            : streamable && targetCommandOutput.length === 0
              ? ''
              : input.text
          const displayCommandOutput = carry
            ? carry.displayCommandOutput
            : streamable
              ? ''
              : targetCommandOutput
          entries.set(input.id, {
            displayText,
            targetText: input.text,
            displayCommandOutput,
            targetCommandOutput,
            streamable,
          })
          changed = true
          continue
        }

        if (!streamable) {
          entries.set(input.id, {
            displayText: input.text,
            targetText: input.text,
            displayCommandOutput: targetCommandOutput,
            targetCommandOutput,
            streamable,
          })
          changed = changed || previous.displayText !== input.text || previous.displayCommandOutput !== targetCommandOutput
          continue
        }

        const isTextPrefixGrowth =
          input.text.startsWith(previous.targetText) &&
          input.text.startsWith(previous.displayText) &&
          input.text.length >= previous.displayText.length
        const isCommandOutputPrefixGrowth =
          targetCommandOutput.startsWith(previous.targetCommandOutput) &&
          targetCommandOutput.startsWith(previous.displayCommandOutput) &&
          targetCommandOutput.length >= previous.displayCommandOutput.length

        if (!isTextPrefixGrowth || !isCommandOutputPrefixGrowth) {
          entries.set(input.id, {
            displayText: input.text,
            targetText: input.text,
            displayCommandOutput: targetCommandOutput,
            targetCommandOutput,
            streamable,
          })
          changed = true
          continue
        }

        if (
          previous.targetText !== input.text ||
          previous.targetCommandOutput !== targetCommandOutput ||
          previous.streamable !== streamable
        ) {
          entries.set(input.id, {
            ...previous,
            targetText: input.text,
            targetCommandOutput,
            streamable,
          })
        }
      }

      for (const id of entries.keys()) {
        if (keepIds.has(id)) continue
        entries.delete(id)
        changed = true
      }

      return { changed, pending: hasPending() }
    },

    advance() {
      let changed = false
      for (const [id, entry] of entries.entries()) {
        if (!entry.streamable) continue
        const displayText = revealChunk(entry.displayText, entry.targetText, textChunkSize)
        const displayCommandOutput = revealChunk(
          entry.displayCommandOutput,
          entry.targetCommandOutput,
          outputChunkSize,
        )
        if (displayText !== entry.displayText || displayCommandOutput !== entry.displayCommandOutput) {
          entries.set(id, { ...entry, displayText, displayCommandOutput })
          changed = true
        }
      }
      return changed
    },

    hasPending,

    readText(id) {
      return entries.get(id)?.displayText
    },

    readCommandOutput(id) {
      return entries.get(id)?.displayCommandOutput
    },

    reset() {
      entries.clear()
    },
  }
}
