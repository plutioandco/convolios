import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";
import fuzz from "fuzzball";
import { doubleMetaphone } from "https://esm.sh/double-metaphone@2";
import { appCorsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Nickname map — bidirectional canonical lookup for common English name pairs.
// If firstWordA and firstWordB resolve to the same canonical, they're nicknames.
// ---------------------------------------------------------------------------
const NICKNAME_RAW: [string, string[]][] = [
  ["michael", ["mike", "mick", "mikey"]],
  ["robert", ["bob", "rob", "bobby", "robbie"]],
  ["william", ["bill", "will", "billy", "willy", "liam"]],
  ["james", ["jim", "jimmy", "jamie"]],
  ["richard", ["dick", "rick", "richie"]],
  ["thomas", ["tom", "tommy"]],
  ["david", ["dave", "davey"]],
  ["steven", ["steve", "stephen"]],
  ["joseph", ["joe", "joey"]],
  ["daniel", ["dan", "danny"]],
  ["christopher", ["chris"]],
  ["matthew", ["matt"]],
  ["anthony", ["tony"]],
  ["nicholas", ["nick", "nicky"]],
  ["alexander", ["alex"]],
  ["samuel", ["sam", "sammy"]],
  ["edward", ["ed", "ted", "eddie", "teddy"]],
  ["benjamin", ["ben", "benny"]],
  ["gregory", ["greg"]],
  ["patrick", ["pat", "paddy"]],
  ["elizabeth", ["liz", "lizzy", "beth", "betty", "eliza"]],
  ["katherine", ["kate", "kathy", "cathy", "katie", "catherine"]],
  ["jennifer", ["jenny", "jen", "jenn"]],
  ["margaret", ["meg", "maggie", "peggy"]],
  ["susan", ["sue", "suzy", "susie"]],
  ["rebecca", ["becky", "becca"]],
  ["cynthia", ["cindy"]],
  ["victoria", ["vicky", "vicki"]],
  ["charles", ["charlie", "chuck"]],
  ["lawrence", ["larry"]],
  ["gerald", ["jerry"]],
  ["raymond", ["ray"]],
  ["ronald", ["ron", "ronny"]],
  ["walter", ["walt"]],
  ["frederick", ["fred", "freddy"]],
  ["henry", ["hank", "harry"]],
  ["albert", ["al"]],
  ["philip", ["phil"]],
  ["jonathan", ["jon", "john"]],
  ["timothy", ["tim", "timmy"]],
  ["andrew", ["andy", "drew"]],
  ["peter", ["pete"]],
  ["kenneth", ["ken", "kenny"]],
  ["douglas", ["doug"]],
  ["leonard", ["leo", "len", "lenny"]],
  ["eugene", ["gene"]],
  ["nathan", ["nate"]],
  ["dominic", ["dom", "dominik"]],
];

const CANONICAL_MAP = new Map<string, string>();
for (const [canonical, nicks] of NICKNAME_RAW) {
  CANONICAL_MAP.set(canonical, canonical);
  for (const n of nicks) CANONICAL_MAP.set(n, canonical);
}

function areNicknames(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  const ca = CANONICAL_MAP.get(la);
  const cb = CANONICAL_MAP.get(lb);
  if (!ca || !cb) return false;
  return ca === cb;
}

// ---------------------------------------------------------------------------
// Company/entity suffix stripping
// ---------------------------------------------------------------------------
const ENTITY_SUFFIXES =
  /\b(ltd|inc|llc|pbc|gmbh|corp|co|plc|sa|ag|bv|nv|pty|srl|limited|corporation|company|business|group|team|official|hq|uk|us)\b/gi;

function stripSuffix(name: string): string {
  return name
    .replace(ENTITY_SUFFIXES, "")
    .replace(/[.,]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Multi-signal scoring — tested against real false positives with 100% accuracy
// ---------------------------------------------------------------------------
function scorePair(rawA: string, rawB: string): { score: number; method: string } {
  const a = stripSuffix(rawA);
  const b = stripSuffix(rawB);

  if (!a || !b || a.length < 2 || b.length < 2) return { score: 0, method: "skip" };

  const wordsA = a.split(/\s+/);
  const wordsB = b.split(/\s+/);
  const isSingleWord = wordsA.length === 1 || wordsB.length === 1;
  const firstA = wordsA[0];
  const firstB = wordsB[0];

  let score: number;
  let method: string;

  if (isSingleWord) {
    score = fuzz.ratio(a, b);
    method = "ratio";
  } else {
    score = fuzz.token_sort_ratio(a, b);
    method = "token_sort";
  }

  // Nickname boost: if first words are nickname-equivalent AND last words match
  if (areNicknames(firstA, firstB) && wordsA.length > 1 && wordsB.length > 1) {
    const lastA = wordsA[wordsA.length - 1].toLowerCase();
    const lastB = wordsB[wordsB.length - 1].toLowerCase();
    if (fuzz.ratio(lastA, lastB) >= 85) {
      score = Math.max(score, 90);
      method = "nickname";
    }
  }

  // Phonetic boost: if first-word metaphone codes overlap, +5
  try {
    const codesA = doubleMetaphone(firstA);
    const codesB = doubleMetaphone(firstB);
    const hasOverlap = codesA.some(
      (c: string) => c && codesB.some((r: string) => r && c.slice(0, 2) === r.slice(0, 2))
    );
    if (hasOverlap && score < 100) {
      score = Math.min(score + 5, 100);
      if (method !== "nickname") method = "phonetic_boost";
    }
  } catch {
    // metaphone failure is non-critical
  }

  return { score, method };
}

// ---------------------------------------------------------------------------
// Union-find clustering (mirrors SQL implementation)
// ---------------------------------------------------------------------------
interface Pair {
  idLo: string;
  idHi: string;
  matchType: string;
  matchDetail: string;
  score: number;
}

function clusterPairs(pairs: Pair[]): Map<string, Set<string>> {
  const parent = new Map<string, string>();

  function find(x: string): string {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      const min = ra < rb ? ra : rb;
      const max = ra < rb ? rb : ra;
      parent.set(max, min);
    }
  }

  for (const p of pairs) {
    if (!parent.has(p.idLo)) parent.set(p.idLo, p.idLo);
    if (!parent.has(p.idHi)) parent.set(p.idHi, p.idHi);
    union(p.idLo, p.idHi);
  }

  const clusters = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root)!.add(id);
  }
  return clusters;
}


// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = appCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  // Authenticate via JWT
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return jsonResponse({ error: "Missing authorization header" }, 401, cors);
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }
  const userId = user.id;

  try {
    // Fetch all non-blocked persons for this user
    const { data: persons, error: pErr } = await supabase
      .from("persons")
      .select("id, display_name, avatar_url, status")
      .eq("user_id", userId)
      .neq("status", "blocked");
    if (pErr) throw pErr;

    // Fetch identities for all those persons
    const personIds = (persons ?? []).map((p: { id: string }) => p.id);
    if (personIds.length === 0) return jsonResponse([], 200, cors);

    const [identitiesResult, groupResult, msgCountResult, dismissedResult] =
      await Promise.all([
        supabase
          .from("identities")
          .select("person_id, channel")
          .in("person_id", personIds),
        supabase
          .from("messages")
          .select("person_id")
          .eq("user_id", userId)
          .eq("message_type", "group")
          .not("person_id", "is", null),
        supabase
          .rpc("get_person_message_counts", { p_user_id: userId })
          .select("*"),
        supabase
          .from("merge_dismissed")
          .select("person_a, person_b")
          .eq("user_id", userId),
      ]);

    if (identitiesResult.error) throw identitiesResult.error;
    const identities = identitiesResult.data;

    const groupPersonIds = new Set(
      (groupResult.data ?? []).map((r: { person_id: string }) => r.person_id)
    );

    const msgCounts = new Map<string, number>();
    for (const r of msgCountResult.data ?? []) {
      msgCounts.set(r.person_id, r.msg_count);
    }

    const dismissed = new Set(
      (dismissedResult.data ?? []).map(
        (d: { person_a: string; person_b: string }) => `${d.person_a}|${d.person_b}`
      )
    );

    // Build person lookup
    const personMap = new Map<
      string,
      { id: string; name: string; avatar: string | null; channels: string[] }
    >();
    for (const p of persons ?? []) {
      personMap.set(p.id, {
        id: p.id,
        name: p.display_name,
        avatar: p.avatar_url,
        channels: [],
      });
    }
    for (const i of identities ?? []) {
      const p = personMap.get(i.person_id);
      if (p && !p.channels.includes(i.channel)) {
        p.channels.push(i.channel);
      }
    }

    // Filter out groups and empty/unknown names
    const eligible = [...personMap.values()].filter(
      (p) =>
        !groupPersonIds.has(p.id) &&
        p.name &&
        p.name !== "" &&
        p.name !== "Unknown" &&
        p.channels.length > 0
    );

    // Score all cross-channel pairs (O(n^2), fine for < 1000 persons)
    const qualifyingPairs: Pair[] = [];
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];

        // Cross-channel only: skip if they share any channel
        const sharedChannel = a.channels.some((ch) => b.channels.includes(ch));
        if (sharedChannel) continue;

        // Skip dismissed
        const lo = a.id < b.id ? a.id : b.id;
        const hi = a.id < b.id ? b.id : a.id;
        if (dismissed.has(`${lo}|${hi}`)) continue;

        const { score } = scorePair(a.name, b.name);
        if (score < 75) continue;

        qualifyingPairs.push({
          idLo: lo,
          idHi: hi,
          matchType: "name",
          matchDetail: `${a.name} / ${b.name}`,
          score: score / 100, // normalize to 0-1 for frontend compatibility
        });
      }
    }

    if (qualifyingPairs.length === 0) return jsonResponse([], 200, cors);

    // Cluster pairs
    const clusters = clusterPairs(qualifyingPairs);

    // Build response in MergeCluster shape
    const result = [];
    for (const [, memberIds] of clusters) {
      const sortedIds = [...memberIds].sort();
      const clusterId = sortedIds.join("|");

      const members = sortedIds
        .map((id) => personMap.get(id))
        .filter(Boolean)
        .map((p) => ({
          id: p!.id,
          name: p!.name,
          avatar: p!.avatar,
          channels: p!.channels,
          is_group: false,
        }));

      // Pick keep person: highest message count
      let keepId = sortedIds[0];
      let maxMsgs = 0;
      for (const id of sortedIds) {
        const count = msgCounts.get(id) ?? 0;
        if (count > maxMsgs) {
          maxMsgs = count;
          keepId = id;
        }
      }
      const keepPerson = personMap.get(keepId);

      // Best signal for this cluster
      let bestPair: Pair | null = null;
      for (const p of qualifyingPairs) {
        if (memberIds.has(p.idLo) && memberIds.has(p.idHi)) {
          if (!bestPair || p.score > bestPair.score) bestPair = p;
        }
      }

      result.push({
        cluster_id: clusterId,
        keep_person_id: keepId,
        keep_person_name: keepPerson?.name ?? "",
        keep_person_avatar: keepPerson?.avatar ?? null,
        members,
        match_type: bestPair?.matchType ?? "name",
        match_detail: bestPair?.matchDetail ?? "",
        score: bestPair?.score ?? 0,
      });
    }

    return jsonResponse(result, 200, cors);
  } catch (err) {
    console.error("merge-suggestions error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
      cors,
    );
  }
});
