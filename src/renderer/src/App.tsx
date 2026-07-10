import React, { useEffect } from 'react'
import { subscribeEvents, useStore } from './store'
import { Home } from './screens/Home'
import { NewProjectWizard } from './screens/NewProjectWizard'
import { ClarifyChat } from './screens/ClarifyChat'
import { ProgressDashboard } from './screens/ProgressDashboard'
import { GuidedScreen } from './screens/GuidedScreen'
import { ExportScreen } from './screens/ExportScreen'
import { AuthorsRoom } from './screens/AuthorsRoom'
import { Settings } from './screens/Settings'
import { EditBook } from './screens/EditBook'

export default function App(): React.JSX.Element {
  const screen = useStore((s) => s.screen)
  const bootstrap = useStore((s) => s.bootstrap)

  useEffect(() => {
    const unsub = subscribeEvents()
    void bootstrap()
    return unsub
  }, [bootstrap])

  return (
    <div className="app">
      {screen === 'home' && <Home />}
      {screen === 'wizard' && <NewProjectWizard />}
      {screen === 'clarify' && <ClarifyChat />}
      {screen === 'progress' && <ProgressDashboard />}
      {screen === 'guided' && <GuidedScreen />}
      {screen === 'export' && <ExportScreen />}
      {screen === 'authorsRoom' && <AuthorsRoom />}
      {screen === 'settings' && <Settings />}
      {screen === 'editBook' && <EditBook />}
    </div>
  )
}
