# Supervisor Console

Supervisor screen for an AI support agent. Conversation list on the left, thread on the right with the AI reply streaming in word by word. When the AI calls `transfer_to_human` you see the reason, take over and reply.

React 19, TypeScript strict, Vite, TanStack Query, Zustand, react-virtuoso, Vitest.

All 7 must-haves are in. Limits are at the bottom.

## Running it

Node 20.19+ (Vite 8 needs it). I was on Node 24.

```bash
npm install
npm run mock   # mock API + SSE on :4000
npm run dev    # app on :5173
```

Mock on another port? Copy `.env.example` to `.env` and set `VITE_API_URL`.

`npm test` for the tests, `npm run typecheck`, `npm run build`.

If you restart the mock, event ids go back to 0. The app picks that up and reloads by itself.

## Live demo

Demo: _add your Vercel URL here_

Mock runs as-is on Render, app is on Vercel. Only [render.yaml](render.yaml) and [vercel.json](vercel.json) were added for that, no code changes.

Free Render instance sleeps after ~15 min, so the first load can take 30-60s. Hit Retry if the list errors out.

To deploy: Render → New → Blueprint → this repo. Copy the service URL. Then import the repo in Vercel and set `VITE_API_URL` to that URL (no trailing slash) before deploying. It's read at build time, so if the URL changes, redeploy.

## Layout

```
src/
  types.ts, api/client.ts
  live/reducer.ts        all the live state logic, pure
  live/store.ts          zustand store around the reducer + UI state
  live/eventStream.ts    SSE connection, resume, reconnects
  live/useLiveSync.ts    startup + thread loading
  live/mutations.ts      take over, send
  live/*.test.ts
  components/
```

## Query vs Zustand

Query does the REST calls: list, thread, take over, send. Loading/error states, retries, no double fetching. `staleTime: Infinity` and no refetch on focus, because once the stream is running a refetch just races it.

Zustand holds everything live: the list and open threads after events are applied, the cursor, pending sends, plus UI stuff (selected conversation, connection status, direction, send errors). Every event goes through one pure reducer in `live/reducer.ts`, which is also what the tests hit.

Why not just `setQueryData` the events into the cache? Two reasons:

- Merging a thread snapshot needs the snapshot, the stream position and the events that came in while it was loading, all together. Easier in one reducer than spread over cache entries.
- Re-renders. A token comes in every ~100ms. In the store a token swaps one message object and nothing else, and each row subscribes to its own message. So a token re-renders one row, not 5,000. There's a test for it.

The thread snapshot gets merged inside the `queryFn` when it arrives, so switching conversations mid-load doesn't lose it. The cache only keeps `lastEventId` and a count, so c-1 isn't stored twice.

## Resuming after a drop

This was the main thing. The mock drops every 20-40s.

Event ids go up by one across the whole stream, so I keep a cursor (last event applied):

- `id <= cursor` → seen it already, skip
- `id == cursor + 1` → apply, move cursor
- `id > cursor + 1` → missed something. Don't apply, reconnect from the cursor now. If that happens 3 times in a row, give up and reload everything.

That's what guarantees no duplicate and no missing tokens.

On drop I close the EventSource myself and open a new one with `since=<cursor>`, with backoff (250ms doubling up to 5s, plus jitter). The header shows Connected / Reconnecting. Late frames from the old connection are ignored. 40s with no events at all = dead, reconnect.

I don't use EventSource's own retry on purpose. It retries the original URL, and the mock prefers `?since` over `Last-Event-ID`, so every retry would replay from the first position and keep growing.

Threads are trickier. A thread is fetched later than the list, so its snapshot already contains events the stream will still send. E.g. list at event 100, open c-1 at 140, snapshot has everything up to 140. Applying 101-140 again would duplicate tokens. So:

1. Before the request goes out, that thread starts buffering its events (list preview/unread still update live).
2. Snapshot arrives, merged at its `lastEventId`. Buffered events above that get replayed on top. A half-streamed reply just continues.
3. After that, events for the thread at or below the snapshot id are skipped.
4. Snapshot older than the cursor = stale (only after a server restart), fetch again.
5. Request fails = stop buffering, drop the thread or restore the old one.

One exception: `tool_call`. Snapshots never contain hand-off notes, so it's never skipped by the snapshot rule, it's deduped by event id instead.

Server restart: the first event on a new connection should be at least `since - 2`. If it's lower, ids were reset, so clear everything and start over.

I ran it against the real mock through a bunch of drops with c-1 and other threads open, then diffed each thread against a fresh `GET /messages`. Same messages, same order, no dupes. List matched `GET /conversations` too.

## Other bits

**Hand-off.** `tool_call` adds a note with the reason in the thread, marks the conversation Needs human, enables Take over. Banner at the top repeats the reason. After take over it's Human handling and the reply box unlocks.

**Sending.** Reply shows up straight away as pending. It's only placed for real when the stream echoes its `clientMessageId`, because the HTTP response can come back before earlier stream events during a reconnect and it'd land in the wrong spot. A 201 just marks it Sent. On error it's pulled back and you get Retry (same id) / Edit / Dismiss.

**Big threads.** react-virtuoso, ~20 rows in the DOM out of 5,000. Memoized rows, one subscription each. Auto-scroll sticks to the bottom until you scroll up yourself. I started with virtuoso's at-bottom flag but threads sometimes opened a bit above the bottom.

**RTL.** Toggle sets `dir`/`lang` on `<html>`, saved in localStorage. CSS is all logical properties so it mirrors without extra rules. Messages use `dir="auto"` + `unicode-bidi: plaintext` so Arabic and English each sit the right way, mixed text included. Names and times are in `<bdi>`.

**Unread.** Server has no mark-read, so I keep its count and track what the supervisor has seen separately, and show the difference. A resync can't bring back a cleared count that way.

## Tests

`npm test`, 32 tests on the reducer and the connection manager. They cover:

- ordering: tokens land in order on the right message, two streams at once don't mix, a gap isn't applied, a token only changes its own row
- duplicates after resume: early replay ignored, replaying again changes nothing, unread not double counted
- snapshot merge: events inside the snapshot skipped, buffered events replayed, stale snapshot rejected, failed load cleaned up
- hand-off: Needs human + reason, works when the thread isn't open, no double note on replay, note still there if the thread is opened later, not lost inside a snapshot window
- sends: confirmed by the stream echo whether HTTP comes first or second, a send that errored but reached the server isn't shown as failed
- connection: resumes with `since=<cursor>`, ignores old frames, reconnects on gap, full reload when a gap won't fill, detects restart, stops clean

## Skipped / known limits

- Hand-off reason from before page load: REST doesn't return it, so c-7 (starts as needs human) shows no reason.
- If a reply was already streaming at page load and you never open that thread, the list preview only has the part it saw (`…rest`). Opening the thread fixes it.
- After a re-fetch, hand-off notes go after the snapshot messages (they have no timestamp).
- Unread resets on reload, no mark-read endpoint.
- List reorders on activity, so a row can move just as you click.
- No component/e2e tests. UI stuff was checked by hand. Tests cover the stream logic, as asked.
- Can't close a conversation, no endpoint.

## With more time

- `createdAt` on streamed replies (`message_start` doesn't have it, so no time until reload)
- paginated history instead of pulling all 5,000 messages
- batch tokens per animation frame
- keep the selected row from jumping around
- Playwright tests against the real mock, drops included
- keyboard nav in the list, live region for hand-offs
- translate the UI labels, the toggle only flips direction

## Mock server bugs

Didn't touch it, but:

1. `?since` beats `Last-Event-ID`, so EventSource's built-in retry always replays from the first position.
2. AI keeps streaming after a take-over. `streamAiReply` only checks `status === 'ai'` before it starts.
3. `since=abc` → `NaN` → replay silently skipped, no error.
4. The event log is never trimmed. `since=0` sends everything.
5. `unread` only goes up, take over doesn't reset it.
6. Hand-off reasons aren't stored, only sent once in the event.
7. Keep-alive is an SSE comment (`: ping`), which JS never sees, so it's useless for detecting a dead connection.
