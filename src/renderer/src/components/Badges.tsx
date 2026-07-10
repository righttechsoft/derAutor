import type React from 'react'
import type { ProjectStatus, Stage } from '@shared/domain'
import { STAGE_LABEL, STATUS_LABEL } from '../format'

export function StageBadge({ stage }: { stage: Stage }): React.JSX.Element {
  return <span className={`badge badge-stage stage-${stage}`}>{STAGE_LABEL[stage]}</span>
}

export function StatusBadge({ status }: { status: ProjectStatus }): React.JSX.Element {
  return (
    <span className={`badge badge-status status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  )
}
