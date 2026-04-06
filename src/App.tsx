import { Sidebar } from './components/sidebar/Sidebar'
import { InboxList } from './components/inbox/InboxList'

function App() {
  return (
    <div className="flex h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Sidebar />
      <InboxList />

      {/* Main content area — message thread */}
      <main className="flex-1 flex flex-col items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            Convolios
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Select a conversation to start
          </p>
        </div>
      </main>
    </div>
  )
}

export default App
