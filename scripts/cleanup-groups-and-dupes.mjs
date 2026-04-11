import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const SB = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  console.log('=== Step 1: Analyze group messages by thread_id ===')

  const { data: groupMsgs, error: gmErr } = await SB
    .from('messages')
    .select('id, person_id, thread_id, sender_name, body_text, direction')
    .eq('message_type', 'group')
    .order('thread_id')

  if (gmErr) { console.error('Failed to fetch group messages:', gmErr); return }
  console.log(`Found ${groupMsgs.length} group messages total`)

  const threadMap = {}
  for (const m of groupMsgs) {
    if (!threadMap[m.thread_id]) threadMap[m.thread_id] = new Set()
    threadMap[m.thread_id].add(m.person_id)
  }

  const splitThreads = Object.entries(threadMap).filter(([, pids]) => pids.size > 1)
  console.log(`\nThreads with multiple person_ids (split groups): ${splitThreads.length}`)
  for (const [tid, pids] of splitThreads) {
    const msgCount = groupMsgs.filter(m => m.thread_id === tid).length
    console.log(`  thread=${tid} persons=${pids.size} msgs=${msgCount} pids=[${[...pids].join(', ')}]`)
  }

  console.log('\n=== Step 2: Find the correct group person for each thread ===')

  const allGroupPersonIds = new Set()
  for (const m of groupMsgs) allGroupPersonIds.add(m.person_id)
  console.log(`Total distinct person_ids used by group messages: ${allGroupPersonIds.size}`)

  const { data: persons, error: pErr } = await SB
    .from('persons')
    .select('id, display_name, avatar_url')
    .in('id', [...allGroupPersonIds])

  if (pErr) { console.error('Failed to fetch persons:', pErr); return }

  const personMap = {}
  for (const p of persons) personMap[p.id] = p
  console.log('\nGroup-associated persons:')
  for (const p of persons) {
    const msgCount = groupMsgs.filter(m => m.person_id === p.id).length
    console.log(`  ${p.id} "${p.display_name}" msgs=${msgCount} avatar=${p.avatar_url ? 'yes' : 'no'}`)
  }

  console.log('\n=== Step 3: Identify duplicate persons (same display_name, same user_id) ===')

  const { data: allPersons, error: apErr } = await SB
    .from('persons')
    .select('id, user_id, display_name, avatar_url')

  if (apErr) { console.error('Failed to fetch all persons:', apErr); return }

  const nameGroups = {}
  for (const p of allPersons) {
    const key = `${p.user_id}::${p.display_name}`
    if (!nameGroups[key]) nameGroups[key] = []
    nameGroups[key].push(p)
  }

  const dupeGroups = Object.entries(nameGroups).filter(([, arr]) => arr.length > 1)
  console.log(`Found ${dupeGroups.length} duplicate name groups:`)
  for (const [key, arr] of dupeGroups) {
    console.log(`\n  "${key.split('::')[1]}" (${arr.length} records):`)
    for (const p of arr) {
      const { count: msgCount } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', p.id)
      const { count: idCount } = await SB
        .from('identities')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', p.id)
      console.log(`    id=${p.id} msgs=${msgCount} identities=${idCount} avatar=${p.avatar_url ? 'yes' : 'no'}`)
    }
  }

  console.log('\n=== Step 4: Fix split group threads ===')

  for (const [threadId, personIds] of splitThreads) {
    const pids = [...personIds]
    const threadMsgs = groupMsgs.filter(m => m.thread_id === threadId)

    let canonical = null
    for (const pid of pids) {
      const p = personMap[pid]
      if (!p) continue
      const name = p.display_name || ''
      const looksLikeGroupName = !name.match(/^[\+]?\d/) && name.length > 2
      const msgCount = threadMsgs.filter(m => m.person_id === pid).length

      if (!canonical) { canonical = { pid, name, msgCount, hasAvatar: !!p.avatar_url, looksLikeGroupName }; continue }
      if (looksLikeGroupName && !canonical.looksLikeGroupName) {
        canonical = { pid, name, msgCount, hasAvatar: !!p.avatar_url, looksLikeGroupName }
      } else if (msgCount > canonical.msgCount) {
        canonical = { pid, name, msgCount, hasAvatar: !!p.avatar_url, looksLikeGroupName }
      }
    }

    if (!canonical) { console.log(`  thread=${threadId}: no canonical found, skipping`); continue }

    const othersToMerge = pids.filter(pid => pid !== canonical.pid)
    console.log(`  thread=${threadId}: canonical="${canonical.name}" (${canonical.pid}), merging ${othersToMerge.length} others`)

    for (const otherPid of othersToMerge) {
      const { error: mErr } = await SB
        .from('messages')
        .update({ person_id: canonical.pid })
        .eq('person_id', otherPid)
        .eq('thread_id', threadId)
      if (mErr) console.error(`    Failed to reassign messages from ${otherPid}:`, mErr)
      else {
        const count = threadMsgs.filter(m => m.person_id === otherPid).length
        console.log(`    Reassigned ${count} messages from ${otherPid} to ${canonical.pid}`)
      }
    }
  }

  console.log('\n=== Step 5: Merge duplicate persons ===')

  for (const [key, arr] of dupeGroups) {
    const name = key.split('::')[1]

    let canonical = arr[0]
    for (const p of arr.slice(1)) {
      const { count: cMsgCount } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', canonical.id)
      const { count: pMsgCount } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', p.id)

      if (p.avatar_url && !canonical.avatar_url) canonical = p
      else if (pMsgCount > cMsgCount && !canonical.avatar_url) canonical = p
    }

    const others = arr.filter(p => p.id !== canonical.id)
    if (others.length === 0) continue

    console.log(`\n  "${name}": keeping ${canonical.id}, merging ${others.length} duplicates`)

    for (const dupe of others) {
      const { count: remainingMsgs } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', dupe.id)

      if (remainingMsgs > 0) {
        const { error: mErr } = await SB
          .from('messages')
          .update({ person_id: canonical.id })
          .eq('person_id', dupe.id)
        if (mErr) { console.error(`    Failed to reassign messages from ${dupe.id}:`, mErr); continue }
        console.log(`    Reassigned ${remainingMsgs} messages from ${dupe.id}`)
      }

      const { error: iErr } = await SB
        .from('identities')
        .update({ person_id: canonical.id })
        .eq('person_id', dupe.id)
      if (iErr) console.error(`    Failed to reassign identities from ${dupe.id}:`, iErr)

      const { count: leftoverMsgs } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', dupe.id)

      if (leftoverMsgs === 0) {
        const { error: dErr } = await SB
          .from('persons')
          .delete()
          .eq('id', dupe.id)
        if (dErr) console.error(`    Failed to delete person ${dupe.id}:`, dErr)
        else console.log(`    Deleted duplicate person ${dupe.id}`)
      } else {
        console.log(`    Warning: ${leftoverMsgs} messages still reference ${dupe.id}, not deleting`)
      }
    }
  }

  console.log('\n=== Step 6: Fix misnamed group persons (named after a sender instead of the group) ===')

  const API = process.env.UNIPILE_API_URL || 'https://api4.unipile.com:13443'
  const KEY = process.env.UNIPILE_API_KEY
  const hdr = KEY ? { 'X-API-KEY': KEY } : null

  if (hdr) {
    const threadPersons = {}
    for (const m of groupMsgs) {
      if (!threadPersons[m.thread_id]) threadPersons[m.thread_id] = new Set()
      threadPersons[m.thread_id].add(m.person_id)
    }

    for (const [threadId, pidSet] of Object.entries(threadPersons)) {
      for (const pid of pidSet) {
        const p = personMap[pid]
        if (!p) continue

        const senderNames = groupMsgs
          .filter(m => m.thread_id === threadId && m.sender_name)
          .map(m => m.sender_name)

        const nameMatchesSender = senderNames.some(s =>
          s === p.display_name || s.startsWith(p.display_name) || p.display_name.startsWith(s)
        )

        if (!nameMatchesSender) continue

        try {
          const res = await fetch(`${API}/api/v1/chats/${threadId}`, { headers: hdr })
          if (!res.ok) continue
          const chatData = await res.json()
          const groupName = chatData.name
          if (!groupName || groupName === p.display_name) continue

          console.log(`  Renaming person "${p.display_name}" -> "${groupName}" (thread=${threadId})`)
          const { error: rErr } = await SB
            .from('persons')
            .update({ display_name: groupName, avatar_url: null })
            .eq('id', pid)
          if (rErr) console.error(`    Failed to rename:`, rErr)
          else p.display_name = groupName
        } catch (e) {
          console.error(`    API error for thread ${threadId}:`, e)
        }
      }
    }
  } else {
    console.log('  Skipping: no UNIPILE_API_KEY set')
  }

  console.log('\n=== Step 7: Clean up orphaned sender-based persons from group messages ===')

  const { data: orphanPersons } = await SB
    .from('persons')
    .select('id, display_name')

  if (orphanPersons) {
    let cleaned = 0
    for (const p of orphanPersons) {
      const { count: msgCount } = await SB
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('person_id', p.id)

      if (msgCount === 0) {
        const { error: dErr } = await SB
          .from('identities')
          .delete()
          .eq('person_id', p.id)
        if (!dErr) {
          const { error: pErr2 } = await SB
            .from('persons')
            .delete()
            .eq('id', p.id)
          if (!pErr2) {
            cleaned++
            console.log(`  Deleted orphaned person "${p.display_name}" (${p.id})`)
          }
        }
      }
    }
    console.log(`  Cleaned ${cleaned} orphaned persons`)
  }

  console.log('\n=== Done ===')
}

run().catch(e => console.error(e))
