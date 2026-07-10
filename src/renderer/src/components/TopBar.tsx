import type React from 'react'
import { BackIcon } from './Icons'

interface TopBarProps {
  title: string
  subtitle?: string
  onBack?: () => void
  right?: React.ReactNode
}

export function TopBar({ title, subtitle, onBack, right }: TopBarProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar-left">
        {onBack && (
          <button className="btn btn-ghost btn-icon" onClick={onBack} aria-label="Back">
            <BackIcon />
          </button>
        )}
        <div>
          <h1 className="topbar-title">{title}</h1>
          {subtitle && <p className="topbar-subtitle">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="topbar-right">{right}</div>}
    </header>
  )
}
