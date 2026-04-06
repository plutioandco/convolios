import { SignedIn, SignedOut, SignIn, UserButton } from '@clerk/clerk-react'
import { Sidebar } from './components/sidebar/Sidebar'
import { InboxList } from './components/inbox/InboxList'

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
        <Sidebar />
        <InboxList />

        {/* Main content area — message thread */}
        <main className="flex-1 flex flex-col">
          <header className="flex items-center justify-end px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <UserButton />
          </header>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                Convolios
              </h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Select a conversation to start
              </p>
            </div>
          </div>
        </main>
      </SignedIn>
    </div>
  )
}

export default App
