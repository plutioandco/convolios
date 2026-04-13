import type { CSSProperties } from 'react'

export const card: CSSProperties = {
  padding: 'var(--card-padding)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--color-surface)',
  maxWidth: 'var(--card-max-width)',
  marginTop: 4,
}

export const cardBordered: CSSProperties = {
  ...card,
  border: '1px solid var(--color-border)',
  transition: 'border-color .15s',
}

export const label: CSSProperties = {
  fontSize: 'var(--font-base)',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
}

export const meta: CSSProperties = {
  fontSize: 'var(--font-sm)',
  color: 'var(--color-text-muted)',
}

export const bodyText: CSSProperties = {
  fontSize: 'var(--font-md)',
  color: 'var(--color-text-body)',
  lineHeight: 1.4,
}

export const linkText: CSSProperties = {
  fontSize: 'var(--font-sm)',
  color: 'var(--color-link)',
  textDecoration: 'none',
}

export const inlineLink: CSSProperties = {
  color: 'var(--color-link)',
  textDecoration: 'none',
  wordBreak: 'break-all',
}

export const media: CSSProperties = {
  maxWidth: '100%',
  borderRadius: 'var(--radius-card)',
  marginTop: 4,
  display: 'block',
}

export const pillBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--card-padding)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--color-surface)',
  marginTop: 4,
}

export const loadingPlaceholder: CSSProperties = {
  width: 200,
  height: 100,
  borderRadius: 'var(--radius-card)',
  background: 'var(--color-surface-deep)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--color-text-muted)',
  fontSize: 'var(--font-sm)',
  marginTop: 4,
}

export const quotedBlock: CSSProperties = {
  borderLeft: '3px solid var(--color-accent)',
  padding: '4px 12px',
  margin: '2px 0 6px',
  background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
  borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
}

export const msgBody: CSSProperties = {
  fontSize: 'var(--font-body)',
  lineHeight: '22px',
  color: 'var(--color-text-body)',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
}

export const accentButton: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--color-accent)',
  color: 'var(--color-white)',
  cursor: 'pointer',
  fontSize: 'var(--font-base)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

export const progressTrack: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: 'var(--color-border)',
  overflow: 'hidden',
}

export const progressFill: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  background: 'var(--color-accent)',
}

export const textButton: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-link)',
  fontSize: 'var(--font-md)',
  padding: '4px 0 0',
  display: 'block',
}

export const mutedItalic: CSSProperties = {
  color: 'var(--color-text-muted)',
  fontStyle: 'italic',
}
