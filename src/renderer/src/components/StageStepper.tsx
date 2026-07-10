import type React from 'react'
import { STAGES, TRANSLATION_STAGES, type Stage } from '@shared/domain'
import { STAGE_LABEL } from '../format'
import { CheckIcon } from './Icons'

interface StageStepperProps {
  current: Stage
  illustrations: boolean
  isTranslation?: boolean
}

// The "intake" stage is an internal warm-up; the visible journey starts at clarify.
// The translation stages are their own track and never mix with the original one.
// "align" only ever runs on edit variants (via the Edit screen's proofread action), never
// as a step in the normal book pipeline, so it's excluded from the stepper the same way.
const TRANSLATION_SET = new Set<Stage>(TRANSLATION_STAGES)
const ORIGINAL_VISIBLE: Stage[] = STAGES.filter(
  (s) => s !== 'intake' && s !== 'align' && !TRANSLATION_SET.has(s)
)

export function StageStepper({
  current,
  illustrations,
  isTranslation
}: StageStepperProps): React.JSX.Element {
  const track: Stage[] = isTranslation ? [...TRANSLATION_STAGES] : ORIGINAL_VISIBLE
  const steps = track.filter((s) => illustrations || s !== 'illustrate')
  const orderIndex = STAGES.indexOf(current)

  return (
    <ol className="stepper">
      {steps.map((stage) => {
        const idx = STAGES.indexOf(stage)
        const state = idx < orderIndex ? 'complete' : idx === orderIndex ? 'active' : 'upcoming'
        return (
          <li key={stage} className={`step step-${state}`}>
            <span className="step-marker">
              {state === 'complete' ? <CheckIcon size={14} /> : <span className="step-dot" />}
            </span>
            <span className="step-label">{STAGE_LABEL[stage]}</span>
          </li>
        )
      })}
    </ol>
  )
}
