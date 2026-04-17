import { useState } from 'react'
import { HelpCircle, Clock, Handshake, X, ChevronDown } from 'lucide-react'
import { useThreadContext, useResolveQuestion, useResolveCommitment } from '../../hooks/useThreadContext'
import type { OpenCommitment, OpenQuestion } from '../../types'

export function ThreadBanner({ personId }: { personId: string }) {
  const { data } = useThreadContext(personId)
  const [expanded, setExpanded] = useState(false)
  const resolveQuestion = useResolveQuestion(personId)
  const resolveCommitment = useResolveCommitment(personId)

  const questions = data?.questions ?? []
  const myCommitments = (data?.commitments ?? []).filter((c) => c.direction === 'mine')
  const theirCommitments = (data?.commitments ?? []).filter((c) => c.direction === 'theirs')

  const total = questions.length + myCommitments.length + theirCommitments.length
  if (total === 0) return null

  const summary: string[] = []
  if (questions.length > 0) summary.push(`${questions.length} open question${questions.length === 1 ? '' : 's'}`)
  if (myCommitments.length > 0) summary.push(`${myCommitments.length} you owe`)
  if (theirCommitments.length > 0) summary.push(`${theirCommitments.length} they owe`)

  return (
    <div className="thread-banner" data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="thread-banner-summary"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="thread-banner-leading">
          <HelpCircle size={14} />
          <span>{summary.join(' · ')}</span>
        </span>
        <ChevronDown size={14} className="thread-banner-chevron" data-expanded={expanded ? 'true' : 'false'} />
      </button>

      {expanded && (
        <div className="thread-banner-body">
          {questions.length > 0 && (
            <section className="thread-banner-section">
              <p className="thread-banner-section-label">Open questions</p>
              {questions.map((q) => (
                <QuestionRow key={q.id} q={q} onResolve={() => resolveQuestion.mutate(q.id)} />
              ))}
            </section>
          )}

          {myCommitments.length > 0 && (
            <section className="thread-banner-section">
              <p className="thread-banner-section-label">You owe them</p>
              {myCommitments.map((c) => (
                <CommitmentRow
                  key={c.id}
                  c={c}
                  tone="warning"
                  onResolve={() => resolveCommitment.mutate(c.id)}
                />
              ))}
            </section>
          )}

          {theirCommitments.length > 0 && (
            <section className="thread-banner-section">
              <p className="thread-banner-section-label">They owe you</p>
              {theirCommitments.map((c) => (
                <CommitmentRow
                  key={c.id}
                  c={c}
                  tone="accent"
                  onResolve={() => resolveCommitment.mutate(c.id)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function QuestionRow({ q, onResolve }: { q: OpenQuestion; onResolve: () => void }) {
  return (
    <div className="thread-banner-item" data-tone="question">
      <HelpCircle size={12} className="thread-banner-item-icon" />
      <span className="thread-banner-item-text">{q.question_text}</span>
      <button
        type="button"
        className="thread-banner-item-close"
        onClick={onResolve}
        title="Mark answered"
      >
        <X size={12} />
      </button>
    </div>
  )
}

function CommitmentRow({
  c, tone, onResolve,
}: { c: OpenCommitment; tone: 'warning' | 'accent'; onResolve: () => void }) {
  return (
    <div className="thread-banner-item" data-tone={tone === 'warning' ? 'owe' : 'owed'}>
      {tone === 'warning'
        ? <Clock size={12} className="thread-banner-item-icon" />
        : <Handshake size={12} className="thread-banner-item-icon" />}
      <div className="thread-banner-item-body">
        <span className="thread-banner-item-text">{c.commitment_text}</span>
        {c.due_hint && <span className="thread-banner-item-due">{c.due_hint}</span>}
      </div>
      <button
        type="button"
        className="thread-banner-item-close"
        onClick={onResolve}
        title="Mark done"
      >
        <X size={12} />
      </button>
    </div>
  )
}
