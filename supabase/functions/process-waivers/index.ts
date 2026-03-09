// supabase/functions/process-waivers/index.ts
//
// Runs once daily at midnight IST (18:30 UTC) via Supabase cron.
//
// Algorithm:
//   - Build a queue of all pending claims across the league, sorted by
//     current waiver priority order (then by each claim's own priority)
//   - Take the top claim from the queue
//   - Skip if: player already claimed this run | drop makes squad illegal |
//              squad full (add-only) | drop player not on this roster
//   - On success: apply roster change, bump that manager to the BOTTOM of
//     the priority order, RE-SORT the remaining queue, continue
//   - Managers can get multiple claims per run — loop until queue is empty
//
// Legality check (full squad = starters + bench):
//   - Min 1 WK  across entire squad
//   - Min 5 BOW/AR across entire squad
//
// Deploy:
//   supabase functions deploy process-waivers
//
// Schedule via Supabase Dashboard → Database → Cron Jobs:
//   Name:     process-waivers-daily
//   Schedule: 30 18 * * *   (18:30 UTC = 00:00 IST)
//   Command:
//     select net.http_post(
//       url     := 'https://<project-ref>.supabase.co/functions/v1/process-waivers',
//       headers := '{"Authorization":"Bearer <service-role-key>","Content-Type":"application/json"}'::jsonb,
//       body    := '{}'::jsonb
//     );

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type PlayerRole = 'WK' | 'BAT' | 'BOW' | 'AR';
type RoleMap    = Record<string, PlayerRole>;
type Roster     = { starters: string[]; bench: string[] };

// Would dropping dropId leave the squad with illegal composition?
function isDropLegal(roster: Roster, dropId: string, roleMap: RoleMap): boolean {
  const after      = [...roster.starters, ...roster.bench].filter(id => id !== dropId);
  const wkCount    = after.filter(id => roleMap[id] === 'WK').length;
  const bowArCount = after.filter(id => roleMap[id] === 'BOW' || roleMap[id] === 'AR').length;
  return wkCount >= 1 && bowArCount >= 5;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.includes(SUPABASE_SERVICE_KEY)) return new Response('Unauthorized', { status: 401 });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const runAt    = new Date().toISOString();
  const results: Record<string, unknown>[] = [];

  // Load all active leagues
  const { data: leagues, error: leagueErr } = await supabase
    .from('leagues').select('id, settings').eq('status', 'active');
  if (leagueErr) return new Response(JSON.stringify({ error: leagueErr.message }), { status: 500 });

  // Load player roles once (shared across all leagues)
  const { data: playerRows } = await supabase.from('players').select('id, role');
  const roleMap: RoleMap = {};
  (playerRows ?? []).forEach((p: { id: number | string; role: PlayerRole }) => {
    roleMap[String(p.id)] = p.role;
  });

  for (const league of (leagues ?? [])) {
    const leagueId  = league.id as string;
    const settings  = (league.settings  ?? {}) as Record<string, unknown>;
    const waiver    = (settings.waiver   ?? {}) as Record<string, unknown>;
    const leagueSet = (settings.league   ?? {}) as Record<string, unknown>;
    const maxSquad  = ((leagueSet.startersCount as number) ?? 11) + ((leagueSet.benchCount as number) ?? 4);
    let   waiverOrder = [...((waiver.order as number[]) ?? [])];

    // Load pending claims
    const { data: allClaims, error: claimErr } = await supabase
      .from('waiver_claims').select('*').eq('league_id', leagueId)
      .order('priority', { ascending: true });
    if (claimErr) { results.push({ leagueId, error: claimErr.message }); continue; }
    if (!allClaims?.length) { results.push({ leagueId, processed: 0, skipped: 0, note: 'no claims' }); continue; }

    // Load league members: member uuid → { userId, slot (1-based int) }
    const { data: members, error: memberErr } = await supabase
      .from('league_members').select('id, user_id').eq('league_id', leagueId);
    if (memberErr) { results.push({ leagueId, error: memberErr.message }); continue; }

    const memberToUser: Record<string, string> = {};
    const memberToSlot: Record<string, number> = {};
    (members ?? []).forEach((m: { id: string; user_id: string }, i: number) => {
      memberToUser[m.id] = m.user_id;
      memberToSlot[m.id] = i + 1;
    });

    // Load current rosters
    const { data: rosterRows, error: rosterErr } = await supabase
      .from('roster_slots').select('user_id, player_ids, bench_ids').eq('league_id', leagueId);
    if (rosterErr) { results.push({ leagueId, error: rosterErr.message }); continue; }

    const rosterMap: Record<string, Roster> = {};
    (rosterRows ?? []).forEach((r: { user_id: string; player_ids: string[]; bench_ids: string[] }) => {
      rosterMap[r.user_id] = {
        starters: (r.player_ids ?? []).map(String),
        bench:    (r.bench_ids  ?? []).map(String),
      };
    });

    // Priority helper: position in waiverOrder array (lower = better)
    const priorityOf = (claim: { member_id: string; priority: number }) => {
      const slot = memberToSlot[claim.member_id];
      if (slot == null) return 999;
      const pos = waiverOrder.indexOf(slot);
      return pos === -1 ? 999 : pos;
    };
    const sortQueue = (q: typeof allClaims) =>
      q.sort((a, b) => {
        const pd = priorityOf(a) - priorityOf(b);
        return pd !== 0 ? pd : a.priority - b.priority;
      });

    let queue = sortQueue([...allClaims]);

    const claimedThisRun = new Set<string>();
    const rosterUpdates: Record<string, Roster> = {};
    const processedIds: string[] = [];
    let processed = 0, skipped = 0;

    while (queue.length > 0) {
      const claim  = queue.shift()!;
      const userId = memberToUser[claim.member_id];
      const slot   = memberToSlot[claim.member_id];
      if (!userId || !slot) { skipped++; continue; }

      const addId  = String(claim.add_player_id);
      const dropId = claim.drop_player_id ? String(claim.drop_player_id) : null;
      const mode   = claim.mode ?? 'add-only';

      if (claimedThisRun.has(addId)) { skipped++; continue; }

      if (!rosterMap[userId]) rosterMap[userId] = { starters: [], bench: [] };
      const roster   = rosterMap[userId];
      const squadIds = [...roster.starters, ...roster.bench];

      if (mode === 'add-only') {
        if (squadIds.length >= maxSquad) { skipped++; continue; }
        roster.bench.push(addId);
      } else {
        if (!dropId || !squadIds.includes(dropId))      { skipped++; continue; }
        if (!isDropLegal(roster, dropId, roleMap))       { skipped++; continue; }
        roster.starters = roster.starters.filter(id => id !== dropId);
        roster.bench    = roster.bench.filter(id => id !== dropId);
        roster.bench.push(addId);
      }

      claimedThisRun.add(addId);
      processedIds.push(claim.id);
      rosterUpdates[userId] = { starters: [...roster.starters], bench: [...roster.bench] };

      // Bump to bottom, re-sort remaining queue
      const idx = waiverOrder.indexOf(slot);
      if (idx !== -1) { waiverOrder.splice(idx, 1); waiverOrder.push(slot); }
      sortQueue(queue);
      processed++;
    }

    if (processed === 0) {
      results.push({ leagueId, processed: 0, skipped, note: 'no executable claims' });
      continue;
    }

    // Write updated rosters
    const upsertRows = Object.entries(rosterUpdates).map(([uid, r]) => ({
      user_id: uid, league_id: leagueId,
      player_ids: r.starters, bench_ids: r.bench, updated_at: runAt,
    }));
    const { error: saveErr } = await supabase
      .from('roster_slots').upsert(upsertRows, { onConflict: 'user_id,league_id' });
    if (saveErr) { results.push({ leagueId, error: `roster save: ${saveErr.message}` }); continue; }

    // Delete processed claims
    if (processedIds.length) {
      await supabase.from('waiver_claims').delete().in('id', processedIds);
    }

    // Persist updated waiver order
    await supabase.from('leagues')
      .update({ settings: { ...settings, waiver: { ...waiver, order: waiverOrder } } })
      .eq('id', leagueId);

    // Log the run
    await supabase.from('waiver_runs').insert({
      league_id: leagueId, run_at: runAt,
      processed, skipped, triggered_by: 'cron',
    });

    console.log(`[process-waivers] ${leagueId}: ${processed} executed, ${skipped} skipped`);
    results.push({ leagueId, processed, skipped });
  }

  return new Response(JSON.stringify({ runAt, results }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
