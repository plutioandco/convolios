import { createClient } from '@supabase/supabase-js'

const API = process.env.UNIPILE_API_URL || 'https://api4.unipile.com:13443'
const KEY = process.env.UNIPILE_API_KEY
const SB = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const USER_ID = '0ca4c58c-98b0-49a4-a7e2-876650228b85'

const hdr = { 'X-API-KEY': KEY }

async function fetchPaginated(url, maxPages = 20) {
  const all = []
  let cursor = null
  for (let i = 0; i < maxPages; i++) {
    const u = cursor ? `${url}&cursor=${cursor}` : url
    const r = await fetch(u, { headers: hdr })
    if (!r.ok) { console.error('fetch fail', r.status, await r.text()); break }
    const d = await r.json()
    const items = d.items || d
    if (Array.isArray(items)) all.push(...items)
    cursor = d.cursor
    if (!cursor) break
  }
  return all
}

function channelFrom(type) {
  const t = (type || '').toUpperCase()
  if (t === 'WHATSAPP') return 'whatsapp'
  if (t === 'LINKEDIN') return 'linkedin'
  if (t === 'INSTAGRAM') return 'instagram'
  if (t === 'TELEGRAM') return 'telegram'
  if (['MAIL','GMAIL','GOOGLE','GOOGLE_OAUTH','OUTLOOK','MICROSOFT','IMAP'].includes(t)) return 'email'
  return 'unknown'
}

function normalizeHandle(raw, channel) {
  let h = raw.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
  if (channel === 'whatsapp' && /^\d+$/.test(h)) {
    h = `+${h}`
  }
  return h
}

async function findOrCreatePerson(channel, handle, displayName, accountId) {
  const { data } = await SB.rpc('backfill_find_or_create_person', {
    p_user_id: USER_ID,
    p_channel: channel,
    p_handle: handle,
    p_display_name: displayName,
    p_unipile_account_id: accountId,
  })
  return data
}

async function fetchAvatar(attId, personId) {
  try {
    const r = await fetch(`${API}/api/v1/chat_attendees/${attId}/picture`, { headers: hdr })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return null
    const ct = r.headers.get('content-type') || 'image/jpeg'
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
    const objectPath = `${personId}.${ext}`

    const { error } = await SB.storage.from('avatars').upload(objectPath, buf, {
      contentType: ct,
      upsert: true,
    })
    if (error) { console.error('  avatar upload error:', error.message); return null }

    const { data: urlData } = SB.storage.from('avatars').getPublicUrl(objectPath)
    return urlData?.publicUrl ?? null
  } catch { return null }
}

async function run() {
  const resp = await fetch(`${API}/api/v1/accounts`, { headers: hdr })
  const accounts = await resp.json()
  const accs = (accounts.items || accounts).filter(a => {
    const srcStatus = a.sources?.[0]?.status
    return !srcStatus || srcStatus === 'OK'
  })
  console.log(`Found ${accs.length} accounts`)

  let totalChats = 0, totalMsgs = 0, totalPersons = 0

  for (const acc of accs) {
    const channel = channelFrom(acc.type)
    console.log(`\n=== Account: ${acc.name} (${acc.id}) channel=${channel} ===`)

    const chats = await fetchPaginated(`${API}/api/v1/chats?account_id=${acc.id}&limit=100`)
    console.log(`  ${chats.length} chats`)

    for (const chat of chats) {
      const chatId = chat.id
      if (!chatId) continue
      const isGroup = (chat.type ?? 0) >= 1
      const chatName = chat.name || ''

      let displayName, handle, otherAttendeeId = null

      if (isGroup) {
        displayName = chatName || 'Group Chat'
        handle = chat.provider_id || chatId
      } else {
        const attResp = await fetch(`${API}/api/v1/chat_attendees?chat_id=${chatId}`, { headers: hdr })
        const attData = await attResp.json()
        const attendees = attData.items || attData || []
        const other = attendees.find(a => a.is_self === 0)

        if (!other) { continue }

        const attName = other.name || ''
        const phone = other.specifics?.phone_number || ''
        const pubId = chat.attendee_public_identifier || ''

        displayName = (attName && attName !== 'Unknown') ? attName
          : chatName ? chatName
          : phone ? phone
          : pubId ? pubId
          : 'Unknown'

        handle = normalizeHandle(
          chat.attendee_public_identifier
            || chat.attendee_provider_id
            || chat.provider_id
            || chatId,
          channel
        )

        otherAttendeeId = other.id
      }

      const person = await findOrCreatePerson(channel, handle, displayName, acc.id)
      if (!person?.person_id) { console.log(`  skip ${chatId}: no person`); continue }
      const { person_id, identity_id } = person
      totalPersons++

      if (!isGroup) {
        const avatar = await fetchAvatar(otherAttendeeId, person_id)
        if (avatar) {
          await SB.from('persons').update({
            avatar_url: avatar,
            avatar_stale: false,
            avatar_refreshed_at: new Date().toISOString(),
          }).eq('id', person_id)
        }
      }

      const messages = await fetchPaginated(`${API}/api/v1/chats/${chatId}/messages?limit=50`, 10)

      let attendeeMap = {}
      if (isGroup && messages.length > 0) {
        const gAttResp = await fetch(`${API}/api/v1/chat_attendees?chat_id=${chatId}`, { headers: hdr })
        const gAttData = await gAttResp.json()
        for (const a of (gAttData.items || [])) {
          const name = a.name || a.public_identifier || a.provider_id
          if (a.id && name) attendeeMap[a.id] = name
        }
      }

      const batch = []
      for (const msg of messages) {
        const externalId = msg.id
        if (!externalId) continue
        const timestamp = msg.timestamp
        if (!timestamp) continue

        const isSender = msg.is_sender === 1
        const direction = isSender ? 'outbound' : 'inbound'
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : []

        let senderName = null
        if (msg.sender_attendee_id && attendeeMap[msg.sender_attendee_id]) {
          senderName = attendeeMap[msg.sender_attendee_id]
        } else if (msg.sender_public_identifier) {
          let s = msg.sender_public_identifier.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
          senderName = /^\d+$/.test(s) ? `+${s}` : s
        }

        batch.push({
          user_id: USER_ID,
          person_id,
          identity_id: identity_id || null,
          external_id: externalId,
          channel,
          direction,
          message_type: isGroup ? 'group' : 'dm',
          body_text: msg.text || null,
          attachments,
          thread_id: chatId,
          sent_at: timestamp,
          sender_name: senderName,
          reactions: msg.reactions || [],
          triage: 'unclassified',
          unipile_account_id: acc.id,
        })
      }

      for (let i = 0; i < batch.length; i += 200) {
        const chunk = batch.slice(i, i + 200)
        const { error } = await SB.from('messages').upsert(chunk, { onConflict: 'external_id', ignoreDuplicates: false })
        if (error) console.log(`  batch err: ${error.message?.substring(0, 80)}`)
        else totalMsgs += chunk.length
      }

      totalChats++
      process.stdout.write(`  chats: ${totalChats} msgs: ${totalMsgs}\r`)
    }
  }

  console.log(`\n\nDone chats: ${totalChats} chats, ${totalMsgs} messages, ${totalPersons} persons`)

  // ===== Email backfill =====
  const emailAccs = accs.filter(a => channelFrom(a.type) === 'email')
  let totalEmails = 0

  for (const acc of emailAccs) {
    console.log(`\n=== Email Account: ${acc.name} (${acc.id}) ===`)

    const emails = await fetchPaginated(`${API}/api/v1/emails?account_id=${acc.id}&limit=100`, 20)
    console.log(`  ${emails.length} emails fetched`)

    const userEmail = acc.name?.toLowerCase() || ''

    const batch = []
    for (const em of emails) {
      const externalId = em.id
      if (!externalId) continue

      const fromAddr = em.from_attendee?.identifier?.toLowerCase() || ''
      const fromName = em.from_attendee?.display_name || fromAddr
      const direction = fromAddr === userEmail ? 'outbound' : 'inbound'

      const otherAddr = direction === 'inbound' ? fromAddr : (em.to_attendees?.[0]?.identifier?.toLowerCase() || '')
      const otherName = direction === 'inbound' ? fromName : (em.to_attendees?.[0]?.display_name || otherAddr)

      if (!otherAddr || otherAddr === userEmail) continue

      const person = await findOrCreatePerson('email', otherAddr, otherName, acc.id)
      if (!person?.person_id) continue

      batch.push({
        user_id: USER_ID,
        person_id: person.person_id,
        identity_id: person.identity_id || null,
        external_id: externalId,
        channel: 'email',
        direction,
        message_type: 'dm',
        subject: em.subject || null,
        body_text: em.body_plain || null,
        body_html: em.body || null,
        attachments: Array.isArray(em.attachments) ? em.attachments : [],
        thread_id: em.thread_id || externalId,
        sent_at: em.date,
        sender_name: fromName,
        triage: 'unclassified',
        unipile_account_id: acc.id,
      })
    }

    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200)
      const { error } = await SB.from('messages').upsert(chunk, { onConflict: 'external_id', ignoreDuplicates: false })
      if (error) console.log(`  email batch err: ${error.message?.substring(0, 80)}`)
      else totalEmails += chunk.length
    }
  }

  console.log(`\nEmail backfill done: ${totalEmails} emails stored`)
  console.log(`\nTotal: ${totalChats} chats, ${totalMsgs + totalEmails} messages, ${totalPersons} persons`)
}

run().catch(e => console.error(e))
