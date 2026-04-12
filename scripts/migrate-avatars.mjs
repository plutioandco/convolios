#!/usr/bin/env node
/**
 * One-time migration: convert existing base64 data:URI avatars in persons.avatar_url
 * to Supabase Storage uploads, then update the URL to the public Storage URL.
 *
 * Usage: node scripts/migrate-avatars.mjs
 * Requires: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const SB = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  const { data: persons, error } = await SB
    .from('persons')
    .select('id, avatar_url')
    .like('avatar_url', 'data:%')

  if (error) { console.error('Query failed:', error.message); process.exit(1) }
  console.log(`Found ${persons.length} persons with base64 avatars`)

  let migrated = 0
  let failed = 0

  for (const p of persons) {
    const match = p.avatar_url.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) { console.warn(`  skip ${p.id}: invalid data URI`); failed++; continue }

    const [, contentType, b64] = match
    const buf = Buffer.from(b64, 'base64')
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
    const objectPath = `${p.id}.${ext}`

    const { error: uploadErr } = await SB.storage.from('avatars').upload(objectPath, buf, {
      contentType,
      upsert: true,
    })

    if (uploadErr) {
      console.error(`  upload failed for ${p.id}:`, uploadErr.message)
      failed++
      continue
    }

    const { data: urlData } = SB.storage.from('avatars').getPublicUrl(objectPath)
    const publicUrl = urlData?.publicUrl

    if (!publicUrl) {
      console.error(`  no public URL for ${p.id}`)
      failed++
      continue
    }

    const { error: updateErr } = await SB
      .from('persons')
      .update({
        avatar_url: publicUrl,
        avatar_stale: false,
        avatar_refreshed_at: new Date().toISOString(),
      })
      .eq('id', p.id)

    if (updateErr) {
      console.error(`  update failed for ${p.id}:`, updateErr.message)
      failed++
      continue
    }

    migrated++
    if (migrated % 10 === 0) console.log(`  migrated ${migrated}/${persons.length}`)
  }

  console.log(`\nDone: ${migrated} migrated, ${failed} failed out of ${persons.length}`)
}

run().catch(console.error)
