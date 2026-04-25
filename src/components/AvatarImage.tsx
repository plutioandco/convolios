import { useState, type ReactNode } from 'react'
import _ from 'lodash'

interface AvatarImageProps {
  src?: string | null
  alt?: string
  className?: string
  fallback: ReactNode
}

export function AvatarImage({ src, alt = '', className, fallback }: AvatarImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (!_.isString(src) || src.trim() === '' || failedSrc === src) {
    return fallback
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
    />
  )
}
