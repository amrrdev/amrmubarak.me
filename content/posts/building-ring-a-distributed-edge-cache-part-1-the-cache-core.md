---
title: "Building Ring: A Distributed Edge Cache, Part 1 — The Cache Core"
date: "2026-7-4"
readTime: "20 min read"
category: "Distributed Systems"
---

## What We're Building

Ring is a cache cluster. Multiple nodes sit in front of an origin server and soak up repeated requests so the origin doesn't have to keep answering the same question over and over. Nodes can join, leave, or die, and the cluster has to keep working anyway. There's no coordinator process, no etcd, no external database — every node figures out what's going on by talking to the other nodes directly.

That's the end goal. This post is about something smaller: what does _one_ node do when it gets _one_ HTTP request? Before you build a cluster, you need a cache that's actually correct on its own. A distributed system that gets caching wrong doesn't get better by adding more nodes — it just gets the same bug in more places, with worse debugging.

## Why This Exists At All

An origin server does real work for every request — a database query, rendering a page, some calculation — and that cost doesn't go away just because the answer happens to be the same as it was ten seconds ago. Say a resource gets hit a thousand times a second and the data behind it only changes once a minute. That means about 59,999 out of every 60,000 requests are asking a question the system already answered. A cache exists to answer those 59,999 without doing the work again.

There are two ways to get this wrong, and they are not equally bad.

**Cache too little**, and you just waste the opportunity. Origin load stays high, latency stays high, and the cache basically isn't doing anything. That's a performance problem — annoying, but easy to notice and easy to fix.

**Cache too much, or cache the wrong thing**, and you serve stale prices, stale inventory counts, or one person's private data to a different person. That's a correctness bug, and it's worse than the performance problem because it doesn't announce itself. A cache that's too conservative shows up immediately in your latency graphs. A cache that occasionally leaks the wrong response to the wrong person shows up as a support ticket weeks later, and by then you have no idea how long it's been happening.

That's why the first half of this post is about HTTP's actual caching rules, not about data structures. The data structures are the easy part. Doing the _correct_ thing — the thing the origin is actually relying on — is where a cache either earns your trust or becomes something nobody wants to turn on.

## The Four Questions, In Full

Every request that hits a cache has to answer four questions, in this order.

### 1. Is there a stored response for this exact request?

The obvious answer is to hash the URL and look it up. That's wrong, and it's wrong in a sneaky way — it'll pass every test you write unless you specifically think to test for this.

Here's the problem. HTTP has a response header called `Vary`. Say a client asks for `GET /api/users` and the origin answers with `Vary: Accept-Encoding` in its response. That header is a promise: the origin is telling any cache that its answer depends on the client's `Accept-Encoding` header, so don't give this response to a client that sent a different one.

Why would the answer depend on that header? Compression. A client that says `Accept-Encoding: gzip` gets compressed bytes back, and a client that says `Accept-Encoding: identity` or nothing gets raw, uncompressed bytes. A cache that only keys on the URL grabs whichever one got stored first and hands it to everyone, compressed or not. A client that can't handle gzip gets garbled output, and a client that can gets uncompressed data that wastes bandwidth.

`Accept-Encoding` is the textbook example, but `Vary: Cookie` is sharper — the response depends on session state carried in a cookie, and if a cache ignores that, it will sooner or later serve one logged-in user's personal response to a completely different user who happened to hit the same URL. This is not a rare edge case; it's one of the more common real-world cache-poisoning bugs, and it happens exactly because someone built the naive "just hash the URL" cache.

The part that makes this a real engineering problem is that `Vary` is part of the _response_. You don't know which headers matter for a URL until you've already gotten a response for that URL, so the very first request for any URL has to be a cache miss, no matter what. There's no clever trick that skips that. What you _can_ control is everything after that first response — remembering exactly which headers `Vary` named and using only those headers to tell later requests apart.

### 2. If there's a stored response, is it still usable?

`Cache-Control: max-age=60` looks simple — cache this for 60 seconds — and as a starting mental model that's fine. But the real spec has more pieces than that, and they matter.

`s-maxage` lets an origin give a _shared_ cache like Ring or a CDN a different lifetime than it gives a browser. A browser cache only ever serves one person, but a shared cache serves everyone, so an origin might say "browsers, cache this for 10 seconds; shared caches, you can hold onto it for 5 minutes." Ignore `s-maxage` and you'll either serve fresher data than planned or serve staler data to more people than intended.

`no-store` means never write this anywhere, ever. `private` is softer — it's fine to cache, just not in a shared cache. A browser can hold onto it, but Ring can't, and treating `private` as cacheable in a shared cache will eventually serve one person's private data to someone else.

`must-revalidate` controls what happens when freshness runs out. Normally the cache can serve stale data briefly while checking with the origin in the background, but `must-revalidate` turns that off: once expired, ask the origin _first_ before serving anything, no benefit of the doubt. This is what an origin sets on things where "close enough" costs real money — account balances, inventory counts, that kind of thing.

### 3. Can it be served stale while a fresh copy is fetched?

Without stale-while-revalidate, every request that lands right as something expires has to wait for a full round trip to the origin before getting anything back, which defeats most of the point of having a cache. If something has `max-age=60` and is being hit continuously, the person whose request lands at second 61 shouldn't eat a full origin round trip just because of bad timing — the response from second 59 is still fine. Serve it immediately, then quietly go fetch a fresh copy in the background so the next person gets something current.

The word that matters most here is "bounded." Without a hard limit on how long something can be served stale, this stops being a smart latency trick and becomes a way to accidentally turn off freshness checking entirely. If the origin goes down for six hours, an unbounded cache just keeps confidently handing out six-hour-old data with no indication anything is wrong. Sometimes stale beats a 500 error, but that should be a deliberate decision, not something that happens by accident because nobody put a ceiling on it. Ring uses a fixed, cache-side stale window, and the origin doesn't get to extend it.

### 4. If two hundred requests for the same expired resource arrive in the same ten milliseconds, does the origin get hit two hundred times, or once?

This is the question that decides whether your cache helps under normal load and actively hurts under the load pattern that matters most.

Walk through the mechanics slowly. A resource is popular — lots of concurrent requests want it. Its freshness window closes. Every one of those requests checks the cache at almost the same instant, and every one sees "expired" because from each request's own point of view, nothing new has been fetched yet. With no coordination, every single one independently decides to go fetch from origin, all at once. The exact moment your cache should be working hardest to protect the origin — a sudden spike in demand — is the moment an uncoordinated cache turns that spike into two hundred simultaneous hits on the origin.

This is called a thundering herd, or a cache stampede. The fix is conceptually simple: the first request that notices the miss goes and fetches, and everyone else just waits for that same fetch to finish. The real, sharp correctness issues are in building it, and we'll walk through two ways to get it wrong later.

## Walking Through an Actual Request

Before any code, here's one request followed all the way through with real timestamps. It's easier to hold this as a sequence of events than as four abstract rules.

Say `GET /api/products/42`. Origin answers with `Cache-Control: max-age=60`. Ring's fixed stale window is 30 seconds.

| Time                                       | Event                                           | What happens                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t=0s                                       | First request comes in                          | Cache checks, finds nothing for this URL yet. Miss. Goes to fetch from origin — nobody else is fetching this, so it just does it. Response comes back. Freshness gets calculated: fresh until t=60s, stale-but-usable until t=90s. Entry gets stored. Client gets the response, with `Age: 0`.                                                                                   |
| t=5s                                       | Second request, different client, same URL      | Cache checks, finds it, and it's still fresh (5 < 60). Served right away. No origin contact. `Age: 5`.                                                                                                                                                                                                                                                                           |
| t=59.999s, t=60.000s, t=60.001s            | Three requests land right at the boundary       | All three check at nearly the same instant. Some might see fresh, some might see expired — that's fine, nothing requires this to be perfectly atomic across three separate observers. Say all three land just past t=60: all three see "stale." Each one gets served the still-cached body immediately — no waiting — and each one triggers a background refresh.                 |
| t=60.001s                                  | Three background refreshes kick off             | All three go through the same coalescing mechanism, keyed on the same URL. Exactly one of them actually talks to the origin. The other two just wait for that one to finish and use its result. Origin sees one request, not three.                                                                                                                                              |
| t=60.050s                                  | Refresh finishes                                | Origin replies "304, nothing changed," with an updated `max-age=60`. The cache reuses the old body — no need to re-send it — and calculates a new freshness window from now.                                                                                                                                                                                                     |
| t=61s                                      | A fourth request comes in                       | Hits the new entry from the refresh at t=60.050s. Fresh again. Served directly.                                                                                                                                                                                                                                                                                                  |
| t=200s (origin has been down since t=150s) | A request comes in for a now hard-expired entry | The cache checks — this entry is well past even the stale window. Not eligible to be served at all. Falls through to fetching from origin. Origin fails, because it's down. Client gets a `502 Bad Gateway`. The cache does _not_ quietly keep serving day-old data past its own limit.                                                                                           |

That table is the whole system, mechanically. Everything from here on is either the code that makes each row true, or the reasoning for why it's built this way.

## Design

Four pieces, one job each:

- **`Entry`** — a snapshot of one cached response. Knows its own freshness and staleness boundaries.
- **`Store`** — a size-limited LRU cache, keyed with the two-level Vary-aware scheme and normalized query parameters.
- **`Flight`** — the piece that coalesces concurrent fetches into one.
- **`Proxy`** — the actual `http.Handler` that wires the three above into the request path from the table.

No external dependencies — standard library only. This matters because this piece has to be correct before anything else gets built on top of it, and every dependency is one more thing that could have its own bug or change behavior under you.

### Entry

```go
// Entry is a single cached HTTP response.
//
// An Entry is immutable once stored. A revalidation or a fresh fetch
// produces a new Entry and replaces the old one in the store; nothing
// ever mutates an Entry's fields in place. This matters because a
// pointer to an Entry can be handed to multiple concurrent readers
// (see store.Get) without a lock held during the response write.
type Entry struct {
	StatusCode int
	Header     http.Header
	Body       []byte

	StoredAt time.Time

	// FreshUntil is the point past which the entry is stale but still
	// usable for stale-while-revalidate.
	FreshUntil time.Time

	// StaleUntil is the hard boundary. Past this point the entry is not
	// served under any circumstance, fresh or stale.
	StaleUntil time.Time

	ETag string

	// VaryHeaders holds the actual request header values that were
	// present when this entry was stored, restricted to the header
	// names listed in the response's Vary header.
	VaryHeaders map[string]string
}
```

**Entry is immutable.** Once created, its fields never change, and that decision shapes everything around it.

Picture the alternative: mutable fields protected by a `sync.RWMutex`. When a revalidation finishes, it takes the write lock and updates `Body`, `FreshUntil`, and everything else in place. The problem is that writing a response body to a client takes real time — `w.Write(e.Body)` can be slow if the body is large or the client's connection is slow. If `Entry` were mutable, that write would need to hold a read lock the whole time, or you'd risk a data race with the revalidation mutating things underneath you. And a read lock held by one slow client blocks the write lock a revalidation needs, which means one slow client can stall a refresh for everyone else hitting that same key.

Immutable entries make that entire class of problem disappear. A revalidation never touches the `Entry` a slow client is currently reading — it builds a brand new one, and the `Store` swaps in a pointer to it. The slow client keeps reading from the old one for as long as it needs, and serve and refresh are two different values that never share the same memory at the same time.

There's a cost: one extra allocation every time something gets revalidated. For a cache that's refreshing popular keys periodically, that's a handful of allocations per minute per key — cheap compared to readers never having to wait on writers.

### Freshness

```go
type directives struct {
	noStore        bool
	private        bool
	noCache        bool
	maxAge         int // seconds; -1 if absent
	sMaxAge        int // seconds; -1 if absent
	mustRevalidate bool
}

func parseCacheControl(h http.Header) directives {
	d := directives{maxAge: -1, sMaxAge: -1}

	raw := h.Get("Cache-Control")
	if raw == "" {
		return d
	}

	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, val, hasVal := strings.Cut(part, "=")
		name = strings.ToLower(strings.TrimSpace(name))
		val = strings.Trim(strings.TrimSpace(val), `"`)

		switch name {
		case "no-store":
			d.noStore = true
		case "private":
			d.private = true
		case "no-cache":
			d.noCache = true
		case "must-revalidate":
			d.mustRevalidate = true
		case "max-age":
			if hasVal {
				if n, err := strconv.Atoi(val); err == nil {
					d.maxAge = n
				}
			}
		case "s-maxage":
			if hasVal {
				if n, err := strconv.Atoi(val); err == nil {
					d.sMaxAge = n
				}
			}
		}
	}
	return d
}
```

Notice what happens to a directive this parser doesn't recognize: nothing, it's just skipped. That's deliberate. `Cache-Control` was designed to grow over time, and real origins send things like `immutable` or `stale-if-error` that this parser has no case for. If unknown directives caused an error, the cache would break the first time an origin shipped a header this code hadn't been updated for, and ignoring what you don't understand is the right move for this specific header.

`parseCacheControl` doesn't care if the header came from a request or a response — same function, either direction. Request and response share vocabulary like `no-cache`, `no-store`, and `max-age`, and where the meaning changes depending on direction, the caller handles it. `ServeHTTP` reads a request's `noCache` one way, and `freshnessWindow` reads a response's `noCache` a different way.

```go
const staleWindow = 30 * time.Second

func freshnessWindow(now time.Time, d directives) (freshUntil, staleUntil time.Time) {
	maxAge := d.maxAge
	if d.sMaxAge >= 0 {
		maxAge = d.sMaxAge
	}
	if d.noCache {
		maxAge = 0
	}
	if maxAge < 0 {
		maxAge = 0
	}

	freshUntil = now.Add(time.Duration(maxAge) * time.Second)

	if d.mustRevalidate {
		staleUntil = freshUntil
	} else {
		staleUntil = freshUntil.Add(staleWindow)
	}
	return freshUntil, staleUntil
}
```

The order of these checks is basically the whole function. `sMaxAge` wins over `maxAge` when it's set — the shared-cache-specific number takes priority. Then `noCache` overrides whatever we landed on and forces it to zero, meaning the response still gets stored but is never handed out without checking with the origin first. If nothing was specified at all, we default to zero rather than guessing some "reasonable" TTL.

That last part is a real choice. A response with no freshness info gets treated as immediately stale, not as "cache it for a while and hope for the best." There's a spec'd technique called heuristic freshness that guesses a TTL from a `Last-Modified` date, but this project doesn't do it because guessing wrong in the "cached too long" direction is exactly the silent-staleness problem this whole post keeps coming back to. If origins didn't say, we don't cache — that way we never guess wrong.

`mustRevalidate` collapsing `staleUntil` down to equal `freshUntil` is the entire implementation of "no stale-serving for this thing, ever." One line, and that's the origin opting something out of the grace period completely.

### Cache Keys

```go
// primaryKey identifies a URL, independent of Vary.
//
// Query parameters are parsed and re-sorted rather than using
// r.URL.RawQuery directly. Two requests for "?a=1&b=2" and "?b=2&a=1"
// name the same resource, but RawQuery preserves whatever order the
// client sent, so using it verbatim fragments what should be one cache
// entry into two — each with its own independent TTL, each an
// independent miss against origin. A client library that builds query
// strings from a map (many do, and Go's own url.Values is one of them
// if you're not careful about how you serialize it) can silently emit
// params in a different order on every single call, which means a
// cache keyed on RawQuery can end up with an effective hit rate near
// zero on any endpoint hit that way, without anything in the logs
// pointing at why.
func primaryKey(r *http.Request) string {
	q := r.URL.Query()
	names := make([]string, 0, len(q))
	for name := range q {
		names = append(names, name)
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteString(r.Method)
	b.WriteByte(' ')
	b.WriteString(r.URL.Path)
	b.WriteByte('?')
	for i, name := range names {
		if i > 0 {
			b.WriteByte('&')
		}
		vals := q[name]
		sort.Strings(vals)
		for j, v := range vals {
			if j > 0 {
				b.WriteByte('&')
			}
			b.WriteString(name)
			b.WriteByte('=')
			b.WriteString(v)
		}
	}
	return b.String()
}
```

This one's a good story. I got this wrong in the first version of this post and only noticed it going back over things for this rewrite. The interesting part is that this kind of bug doesn't announce itself — it doesn't panic, throw an error, or show up when you manually test by typing the same URL twice in the same order. It shows up weeks later as an unexplained low hit rate on endpoints where some client library happens to build its query string from something unordered, like a map. The fix is nine lines of sorting. Noticing you needed it is the actual work.

```go
func secondaryKey(primary string, varyNames []string, r *http.Request) string {
	names := make([]string, len(varyNames))
	copy(names, varyNames)
	sort.Strings(names)

	var b strings.Builder
	b.WriteString(primary)
	for _, name := range names {
		b.WriteByte('\x00')
		b.WriteString(strings.ToLower(name))
		b.WriteByte('=')
		b.WriteString(r.Header.Get(name))
	}

	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:16])
}
```

Two choices in this small function, and both matter.

First, hashing instead of just gluing raw header values together. Header values come from the client and are uncontrolled — a client can set `Accept-Encoding` or `Cookie` to anything, any length. Using those values directly as part of a key would let a client control how much memory the key space consumes. Hashing to a fixed 16 bytes closes that off regardless of which headers an origin decides to vary on.

Second, the `\x00` byte between each header name and value exists to stop a specific kind of collision. Without a clear separator, two different header combinations could glue together into the same string before hashing. A NUL byte can't legally appear in an HTTP header value, so using it as the separator makes the encoding unambiguous — there's exactly one way to have produced any given string.

### Store: The LRU, In Detail

```go
type node struct {
	key     string // secondaryKey
	primary string // primaryKey this secondaryKey belongs to
	entry   *Entry
}

type Store struct {
	mu sync.Mutex

	maxBytes int64
	curBytes int64

	ll    *list.List
	items map[string]*list.Element

	varyIndex map[string][]string
	variants  map[string]map[string]struct{}
}
```

Three maps, one list. `items` is the actual LRU — a map from key to list element, where the list is ordered by recency. `varyIndex` makes the two-level key scheme work: URL to the vary header names we learned about it. `variants` makes purging correct: URL to the set of every secondary key that URL has ever produced.

**Why a linked list instead of a slice.** An LRU needs two operations to be fast: "move this to the front" on every hit, and "remove whatever's at the back" on eviction. Both need to be instant regardless of cache size, otherwise the cache gets slower the more you use it. A slice can't move something to the front without shifting everything before it, and a doubly linked list can do both instantly as long as you already have a pointer to the thing you're moving — which is exactly what the `items` map provides. The map finds things, the list keeps them ordered, and neither alone solves the problem.

**Why LRU instead of LFU.** LFU means tracking a count per entry and finding the smallest count on eviction, either by scanning everything or keeping a second structure that gets updated on every single access. LFU also has a known problem where something that was popular yesterday and dead today sticks around because its count is still high. LRU's bet is simpler: something used recently will probably be used again soon, which holds up well for HTTP cache traffic and is much cheaper to implement correctly.

```go
func (s *Store) Get(r *http.Request) (*Entry, bool) {
	pk := primaryKey(r)

	s.mu.Lock()
	defer s.mu.Unlock()

	varyNames, known := s.varyIndex[pk]
	if !known {
		return nil, false
	}

	sk := secondaryKey(pk, varyNames, r)
	el, ok := s.items[sk]
	if !ok {
		return nil, false
	}

	s.ll.MoveToFront(el)
	return el.Value.(*node).entry, true
}
```

You might expect `RWMutex` here — this is a read-heavy structure — but `Get` isn't really "just reading." Every time it finds something, it calls `MoveToFront`, which mutates the linked list's internal structure. If `Get` took a read lock, two goroutines could both rearrange the list at the same time, which is a genuine data race on the list's internal pointers that could silently lose entries.

The fix isn't to give the map an `RWMutex` and the list its own separate lock — that creates a lock ordering problem with no real benefit on a code path this simple. One plain `Mutex` covering everything keeps the whole thing obviously correct: nothing can ever observe the map, list, and vary index in an inconsistent state because only one goroutine touches any of them at a time. If this lock ever becomes a bottleneck, the standard fix is splitting into several independent stores with their own locks and routing keys by hash, not switching lock types.

```go
func (s *Store) Set(r *http.Request, e *Entry, varyNames []string) {
	pk := primaryKey(r)
	sk := secondaryKey(pk, varyNames, r)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.varyIndex[pk] = varyNames

	if el, ok := s.items[sk]; ok {
		old := el.Value.(*node).entry
		s.curBytes -= old.Size()
		el.Value.(*node).entry = e
		s.ll.MoveToFront(el)
	} else {
		el := s.ll.PushFront(&node{key: sk, primary: pk, entry: e})
		s.items[sk] = el

		if s.variants[pk] == nil {
			s.variants[pk] = make(map[string]struct{})
		}
		s.variants[pk][sk] = struct{}{}
	}
	s.curBytes += e.Size()

	s.evictLocked()
}

func (s *Store) evictLocked() {
	for s.curBytes > s.maxBytes {
		back := s.ll.Back()
		if back == nil {
			return
		}
		n := back.Value.(*node)
		s.curBytes -= n.entry.Size()
		s.ll.Remove(back)
		delete(s.items, n.key)
		delete(s.variants[n.primary], n.key)
		if len(s.variants[n.primary]) == 0 {
			delete(s.variants, n.primary)
			delete(s.varyIndex, n.primary)
		}
	}
}
```

Eviction happens inline every time `Set` pushes the store over its size limit, not on a timer or background goroutine. The upside is that at any moment, memory usage never exceeds the limit by more than one entry's worth — there's no window where things have gone over budget because a cleanup job hasn't run yet. If this is running in a container with a hard memory limit, that guarantee actually matters. The cost is that a `Set` that needs to evict many entries pays for all of that inline, but that's acceptable because `Set` was never the hot path — `Get` is, and `Get` never evicts anything.

The reason `variants` exists is that `secondaryKey` is a one-way hash, so given a stored key there's no way to compute which URL it came from. When you need to purge every version of a URL — the gzipped copy, the plain copy, whatever else `Vary` produced — you can't figure that out from hashed keys because the information is gone. `variants` remembers the mapping on the side so you never need to reconstruct what the hash already threw away.

```go
func (s *Store) DeleteAllVariants(primary string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.varyIndex, primary)

	for sk := range s.variants[primary] {
		s.deleteKeyLocked(primary, sk)
	}
	delete(s.variants, primary)
}
```

A `PURGE /some/path` request names one URL, and the caller shouldn't have to know how many Vary-based versions exist underneath it. `DeleteAllVariants` only walks `variants[primary]` — the exact set of keys for that URL — so a purge is equally fast whether your cache has 500 entries or 5 million.

### Singleflight, and Why the Obvious Alternatives Don't Work

```go
type call struct {
	wg  sync.WaitGroup
	val *Entry
	err error
}

type Flight struct {
	mu    sync.Mutex
	calls map[string]*call
}

func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	f.mu.Lock()
	if c, ok := f.calls[key]; ok {
		f.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}

	c := new(call)
	c.wg.Add(1)
	f.calls[key] = c
	f.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	f.mu.Lock()
	delete(f.calls, key)
	f.mu.Unlock()

	return c.val, c.err
}
```

The best way to understand why this looks the way it does is to look at two more obvious designs and see exactly where each one breaks.

**Attempt one: a lock per key, held the whole time you're fetching.**

```go
// DOES NOT actually coalesce — shown to explain why, not as usable code.
func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	lock := f.lockFor(key)
	lock.Lock()
	defer lock.Unlock()
	return fn()
}
```

This looks reasonable at first — only one goroutine can hold the lock at a time, so `fn` only ever runs one at a time per key. But "one at a time" and "runs once with everyone sharing that result" are two completely different things. Every goroutine still calls `fn` for itself — they just take turns doing it one after another instead of all simultaneously. Two hundred requests still means two hundred origin fetches, now sequential instead of concurrent, which is actually worse for the two-hundredth request.

**Attempt two: check if something's in flight, then fetch, with nothing tying those steps together.**

```go
// Has a race — shown to explain why, not as usable code.
func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	f.mu.Lock()
	_, inFlight := f.calls[key]
	f.mu.Unlock()

	if inFlight {
		// wait somehow...
	}
	return fn()
}
```

This is a classic check-then-act bug. Look at the gap between `f.mu.Unlock()` after the check and whatever "wait somehow" ends up being. In that gap, a second goroutine can run the same check, also find nothing registered, and also go ahead and call `fn()`. Checking "is something in flight" and registering "something is now in flight" need to happen as one atomic step, and if they're split, two goroutines can both believe they're the first one there.

The real `Do` avoids this by holding the lock across both the check and the registration together, then releasing it before calling `fn` — because the actual fetch might be slow, and there's no reason for a slow fetch on one key to block every unrelated key from making progress.

**One more important detail: the entry gets removed from the map _after_ `wg.Done()`, never before.**

```go
c.val, c.err = fn()
c.wg.Done()          // unblocks every waiter

f.mu.Lock()
delete(f.calls, key)  // only now does the map forget this call happened
f.mu.Unlock()
```

If you flipped that order — deleted from the map first, then called `Done()` — there'd be a small window where the call isn't marked as "in flight" anymore but also hasn't actually finished. A new request arriving in that window would correctly see nothing in the map, correctly conclude nothing is in flight, and go start a completely redundant second fetch. Doing `Done()` first closes that window entirely — by the time a key disappears from the map, everyone who was ever waiting on it has already gotten their answer.

## Proxy: The Full Request Path, Now With Client-Side Directives

```go
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		p.passThrough(w, r)
		return
	}

	reqDirectives := parseCacheControl(r.Header)
	forceRevalidate := reqDirectives.noCache

	now := time.Now()
	entry, ok := p.Store.Get(r)

	switch {
	case ok && entry.Fresh(now) && !forceRevalidate:
		writeEntry(w, entry, now)

	case ok && entry.Stale(now) && !forceRevalidate:
		writeEntry(w, entry, now)
		p.revalidateAsync(r, entry)

	default:
		fetched, err := p.fetchCoalesced(r, entry)
		if err != nil {
			p.serveError(w, err)
			return
		}
		writeEntry(w, fetched, now)
	}
}
```

The first version of this post only looked at the response's `Cache-Control` header, but that's only half the picture. A request can carry `Cache-Control: no-cache` — this is what happens when you hard-refresh a browser with Ctrl+Shift+R — and it means "even if you think you have something fresh, don't trust it, go check with the origin first." Miss this, and a user's hard-refresh does nothing different from a regular refresh, which is a real bug someone will notice.

```go
func writeEntry(w http.ResponseWriter, e *Entry, now time.Time) {
	for k, vs := range e.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	age := int(now.Sub(e.StoredAt).Seconds())
	if age < 0 {
		age = 0
	}
	w.Header().Set("Age", strconv.Itoa(age))
	w.WriteHeader(e.StatusCode)
	w.Write(e.Body)
}
```

`Age` is a required header for a shared cache under the HTTP spec, and it's not just a formality — it's how everything downstream of this cache stays correct about what Ring is doing. If a browser sits behind Ring and Ring sends back a response with `max-age=60` but no `Age` header, the browser has no way of knowing that response might already be 45 seconds old. It'll assume it's brand new and cache it for another full 60 seconds, so what the origin meant as a 60-second window quietly turns into 105 seconds. `Age` fixes that: the browser sees it and shortens its own freshness window accordingly.

Passing `now` in explicitly instead of each function grabbing the time on its own means the freshness decision and the number written into `Age` both come from the exact same instant, avoiding any inconsistency between what we decided and what we told the client.

## Concurrency Correctness, Argued Directly

**The claim:** no matter how many `Get`, `Set`, `Delete`, and `DeleteAllVariants` calls happen at the same time from as many goroutines as you want, the end result is always the same as if they'd happened one at a time in some order. Nobody ever sees a half-finished state.

**Why that's true:** every single method that touches the list, the items map, the vary index, or the variants map acquires `s.mu` first and holds it for the entire operation. Go's `Mutex` guarantees mutual exclusion: when one goroutine unlocks it, that unlock happens-before the next goroutine's lock succeeds, so two operations can never actually overlap in time. Every call runs as if it's the only thing happening, seeing exactly whatever the previous call left behind.

The one thing that needs actual care: every line touching those four structures has to be inside a locked section, no exceptions. The helper functions ending in "Locked" signal that the caller must already be holding the lock, and Go doesn't enforce this at compile time — it's a naming convention that every call site must respect. That's exactly why all this logic lives in one file instead of being spread across files where someone might not know the convention exists.

## Benchmarks: Making the Coalescing Claim Measurable

```go
const simulatedOriginLatency = 10 * time.Millisecond

func BenchmarkThunderingHerd_OriginCallCount(b *testing.B) {
	f := NewFlight()
	var originCalls int

	fetch := func() (*Entry, error) {
		originCalls++
		time.Sleep(simulatedOriginLatency)
		return &Entry{Body: []byte("result")}, nil
	}

	var wg sync.WaitGroup
	for c := 0; c < 100; c++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f.Do("hot-key", fetch)
		}()
	}
	wg.Wait()

	b.ReportMetric(float64(originCalls), "origin_calls/100_requests")
}
```

Run it like this:

```
go test ./cache/ -bench OriginCallCount -run ^$ -benchtime 1x
```

This measures the real claim: 100 concurrent requests, same key, one origin call. Not "should be fast" — an actual number you could put in front of someone and defend.

There's also a pair of wall-clock benchmarks in the same file (`WithoutCoalescing` vs `WithCoalescing`), and they're worth running with a caveat: since all 100 fake origin calls in the uncoalesced version are just goroutines sleeping at the same time, the wall-clock time is roughly the same either way. The actual damage from missing coalescing doesn't show up as slower wall-clock time in this benchmark — it shows up as 100 real network calls hitting a real origin instead of 1. That's exactly why `OriginCallCount` exists as its own separate benchmark.

## What Production Adds Beyond This

This is a complete, correct, single-node cache, but there's real distance between this and something you'd point a huge amount of production traffic at.

**Trusting the Host header.** This proxy trusts whatever the request's routing already decided and doesn't independently verify that a request claiming to be for one origin is actually meant for it. If the load balancer in front of this cache doesn't strictly validate the `Host` header before routing, someone could trick this cache into storing a response under the wrong key. That's an infrastructure-level guarantee, not something `cache/` alone can fix.

**Caching error responses.** Right now, only 2xx responses are cached, which is the safer default. But it means a URL that legitimately 404s gets hit with the full uncached origin round trip every single time forever, and someone could hammer known-missing URLs just to generate load. A production version would want a short, capped negative cache for 404s with its own separate TTL.

**Visibility.** There's no way to see which keys are hot, which are cold, or what the real hit rate looks like broken down by endpoint. That's not a correctness problem, but it's the kind of gap that turns a small production issue into a long, confusing one — "the cache seems slow" is much harder to debug than "the hit rate on `/api/search` dropped at 14:02."

None of these change what Part 1 is: a correct, tested, single-node cache. This is just the honest list of what "correct on one node" doesn't cover yet.

## What's Next

This node has no idea any other node exists. `HandlePurge` clears exactly the node it hits and only that node — two Ring nodes in front of the same origin would each build their own separate cache with no way to coordinate. That gap is deliberate: everything in this post needed to be solid and testable on its own before a second node enters the picture. Trying to debug a gossip protocol and a caching bug at the same time, on the same system, with no way to tell which is misbehaving, is a genuinely bad time.

Part 2 introduces SWIM, the failure-detection protocol behind Consul and Cassandra. It answers "who's alive right now" with no central coordinator and without every node pinging every other node every round.

## Repository

Full source, including every test and benchmark mentioned in this post, is in the `ring/` module: `cache/entry.go`, `cache/freshness.go`, `cache/key.go`, `cache/store.go`, `cache/singleflight.go`, `cache/proxy.go`, tests alongside each one, and a runnable reverse proxy in `cmd/ring/main.go`. Run the whole suite with `go test ./... -race` — `-race` specifically, since much of the correctness argument rests on concurrent access working correctly.
