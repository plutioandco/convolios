import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { SignedIn, SignedOut, SignIn, UserButton, useUser } from '@clerk/clerk-react'
import { Sidebar } from './components/sidebar/Sidebar'
import { InboxList } from './components/inbox/InboxList'
import { ThreadView } from './components/thread/ThreadView'
import { Settings } from './components/settings/Settings'
import { useInboxStore } from './stores/inboxStore'
import { useRealtimeMessages } from './hooks/useRealtimeMessages'

function App() {
  return (
    <div className="flex h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <SignedOut>
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Convolios
            </h1>
            <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>
              The single source of truth for every conversation
            </p>
          </div>
          <SignIn routing="hash" />
        </div>
      </SignedOut>

      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
    </div>
  )
}

function AuthenticatedApp() {
  const { user } = useUser()
  const fetchConversations = useInboxStore((s) => s.fetchConversations)

  useRealtimeMessages(user?.id)

  useEffect(() => {
    if (user?.id) {
      fetchConversations(user.id)
    }
  }, [user?.id, fetchConversations])

  return (
    <>
      <Sidebar />
      <Routes>
        <Route
          path="/"
          element={
            <>
              <InboxList />
              <main className="flex-1 flex flex-col">
                <header className="flex items-center justify-end px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                  <UserButton />
                </header>
                <ThreadView />
              </main>
            </>
          }
        />
        <Route
          path="/settings"
          element={
            <main className="flex-1 flex flex-col">
              <header className="flex items-center justify-end px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <UserButton />
              </header>
              <Settings />
            </main>
          }
        />
      </Routes>
    </>
  )
}

export default App
