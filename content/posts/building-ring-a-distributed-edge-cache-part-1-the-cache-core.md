---
title: "Building Ring: A Distributed Edge Cache, Part 1 — The Cache Core"
date: "2026-7-4"
readTime: "20 min read"
category: "Distributed Systems"
---

## What We're Building

Ring is a cache cluster. Multiple nodes sit in front of an origin server. They absorb repeated requests so the origin doesn't keep answering the same question. Nodes can join, leave, or die, and the cluster keeps working. No coordinator process. No etcd. No external database. Every node discovers what's happening by talking directly to other nodes.

This post covers a smaller piece: what does _one_ node do when it gets _one_ HTTP request? Before building a cluster, you need a cache that's correct on its own. A distributed system with a broken cache just spreads the same bug across more nodes, with worse debugging.

## Why This Exists At All

An origin server does real work per request — a database query, a page render, a calculation. That cost doesn't disappear just because the answer is the same as ten seconds ago. If a resource is hit a thousand times per second and the data behind it changes once per minute, about 59,999 out of 60,000 requests ask a question the system already answered. A cache answers those 59,999 without repeating the work.

There are two ways to get this wrong, and they are not equally bad.

**Cache too little.** You waste the opportunity. Origin load stays high, latency stays high. That's a performance problem — annoying, but easy to notice and fix.

**Cache too much or cache the wrong thing.** You serve stale prices, stale inventory counts, or one person's private data to someone else. That's a correctness bug. It's worse because it doesn't announce itself. A conservative cache shows up in your latency graphs immediately. A cache that leaks responses shows up weeks later as a support ticket, and by then you have no idea how long it's been happening.

That's why this post spends more time on HTTP's caching rules than on data structures. The data structures are easy. Doing the _correct_ thing — what the origin relies on — is where a cache earns trust.

## The Four Questions

Every request that hits a cache must answer four questions, in this order.

### 1. Is there a stored response for this exact request?

The obvious approach: hash the URL, look it up. This is wrong in a subtle way — it passes every test you'd write unless you specifically test for the problem.

HTTP has a response header called `Vary`. A client sends `GET /api/users`. The origin answers with `Vary: Accept-Encoding`. That header is a promise. It tells any cache: "my answer depends on the client's `Accept-Encoding` header. Don't serve this response to a client that sent a different one."

Why would the answer depend on that header? Compression. A client with `Accept-Encoding: gzip` gets compressed bytes. A client with `Accept-Encoding: identity` (or nothing) gets raw bytes.

What does "hash the URL" get you? Same URL, same method, but two different response bodies depending on who asks. A URL-only cache grabs whichever was stored first and hands it to everyone.

Two failure modes:

- A client that can't handle gzip gets gzipped bytes. Its browser tries to decompress plain text, and the response comes out corrupted.
- A client that can handle gzip gets uncompressed bytes. Nothing crashes, but bandwidth is wasted.

`Accept-Encoding` is the textbook example. `Vary: Cookie` is sharper. The response depends on session state in a cookie. If a cache ignores `Vary: Cookie` and treats a URL as one entry, it will serve one logged-in user's personal response to another user hitting the same URL. This is a real-world cache-poisoning bug, and it happens because someone built the naive "hash the URL" cache.

The hard engineering constraint: `Vary` is part of the _response_. You don't know which headers matter for a URL until you've already gotten a response. The first request for any URL is unavoidably a cache miss. There's no clever trick to skip it. What you control is everything after — remembering exactly which headers `Vary` named, and using only those to distinguish later requests.

### 2. If there's a stored response, is it still usable?

`Cache-Control: max-age=60` looks simple: cache this for 60 seconds. As a starting model, fine. But the real spec has more pieces.

`s-maxage` lets an origin give a _shared_ cache (like Ring or a CDN) a different lifetime than a browser. A browser cache serves one person. A shared cache serves everyone. An origin can say: "browsers, cache this for 10 seconds. Shared caches, hold it for 5 minutes." Ignore `s-maxage` and you either serve fresher data than planned (straining infrastructure) or serve staler data to more people than intended.

`no-store` means never write this anywhere, ever — not even for revalidation. `private` means it's fine to cache, just not in a shared cache. A browser can hold it. Ring can't. Treating `private` as cacheable in a shared cache will eventually serve one person's data to someone else.

`must-revalidate` controls what happens when freshness runs out. Normally, the cache can serve stale data briefly while checking with the origin in the background. `must-revalidate` turns that off: once expired, ask the origin _first_ before serving anything. No benefit of the doubt, even if the origin is briefly unreachable. Origins set this on things where "close enough" costs real money: account balances, inventory counts.

### 3. Can it be served stale while a fresh copy is fetched?

Without stale-while-revalidate, every request that lands right as something expires must wait for a full origin round trip. That defeats the point of having a cache. If something has `max-age=60` and is hit continuously, the person landing at second 61 shouldn't wait for a full origin fetch. The response from second 59 is still fine. Serve it immediately. Fetch a fresh copy in the background for the next person.

The critical word is "bounded." Without a hard limit on how long something can be served stale, this becomes a way to accidentally disable freshness checking. If the origin goes down for six hours and there's no bound, the cache hands out six-hour-old data with no indication anything is wrong. Sometimes stale beats a 500 error — but that should be a deliberate decision, not an accident. Ring uses a fixed, cache-side stale window. The origin doesn't extend it.

### 4. If two hundred requests for the same expired resource arrive in the same ten milliseconds, does the origin get hit two hundred times or once?

This decides whether your cache helps under normal load and hurts under the load pattern that matters most.

A resource is popular. Many concurrent requests want it. The freshness window closes. Every request checks the cache at nearly the same instant, and every one sees "expired." With no coordination, every request independently decides to fetch from origin. All at once.

The moment your cache should work hardest to protect the origin — a sudden demand spike — is the moment an uncoordinated cache turns that spike into two hundred simultaneous origin hits.

This is a thundering herd or cache stampede. The fix is conceptually simple: the first request that notices the miss fetches. Everyone else waits for that same fetch to finish. Simple to describe. There are real correctness issues in building it — two ways to get it wrong are covered later.

## Walking Through an Actual Request

Here's one request followed end-to-end. It's easier to hold as a sequence of events than as four abstract rules.

Say `GET /api/products/42`. Origin answers with `Cache-Control: max-age=60`. Ring's fixed stale window is 30 seconds.

| Time                                       | Event                                           | What happens                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t=0s                                       | First request comes in                          | Cache checks, finds nothing. Miss. Fetches from origin. Response comes back. Freshness: fresh until t=60s, stale-but-usable until t=90s. Entry stored. Client gets `Age: 0`.                                                                                                                                                                                                     |
| t=5s                                       | Second request, different client, same URL      | Cache check: still fresh (5 < 60). Served directly. No origin contact. `Age: 5`.                                                                                                                                                                                                                                                                                                 |
| t=59.999s, t=60.000s, t=60.001s            | Three requests land at the boundary             | All check at nearly the same instant. Some see fresh, some expired. Say all land just past t=60: all see "stale." Each gets the cached body immediately (no waiting) and triggers a background refresh.                                                                                                                                                                           |
| t=60.001s                                  | Three background refreshes kick off             | All hit the coalescing mechanism on the same key. Exactly one talks to the origin. The other two wait for it to finish and use its result. Origin sees one request.                                                                                                                                                                                                               |
| t=60.050s                                  | Refresh finishes                                | Origin replies "304, nothing changed" with updated `max-age=60`. Cache reuses the old body and calculates a new freshness window from now.                                                                                                                                                                                                                                       |
| t=61s                                      | Fourth request                                  | Hits the refreshed entry. Fresh again. Served directly.                                                                                                                                                                                                                                                                                                                          |
| t=200s (origin down since t=150s)          | Request for a hard-expired entry                | Entry is past the stale window. Not eligible to serve. Falls through to origin fetch. Origin fails. Client gets `502 Bad Gateway`. The cache does not quietly serve old data past its limit.                                                                                                                                                                                      |

That table is the whole system. Everything that follows is the code that makes each row work, or the reasoning for why it's built this way.

## Design

Four pieces, one job each:

- **`Entry`** — a snapshot of one cached response. Knows its own freshness and staleness boundaries.
- **`Store`** — a size-limited LRU cache, keyed with a two-level Vary-aware scheme and normalized query parameters.
- **`Flight`** — coalesces concurrent fetches into one.
- **`Proxy`** — the `http.Handler` that wires the three above into the request path from the table.

No external dependencies. Standard library only. This piece must be correct before anything else is built on top. Every dependency is another potential bug you haven't fully checked.

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

`Entry` never changes once created. Here's why.

Imagine the alternative: mutable fields with a `sync.RWMutex`. A revalidation takes the write lock and updates `Body`, `FreshUntil`, and everything in place.

The problem: `writeEntry` — writing the response body to a client — is not instant. `w.Write(e.Body)` takes real time for large bodies or slow client connections. If `Entry` were mutable, that write would need a read lock for its entire duration. The alternative — reading `Body` with no lock while a revalidation mutates it — is a data race. A read lock held by one slow client blocks the write lock a revalidation needs. One slow client stalls a refresh for everyone hitting that key.

With immutable entries, this problem disappears. A revalidation never touches the `Entry` a slow client is reading. It builds a new `Entry`, and the `Store` swaps in a pointer. The slow client keeps reading the old one for as long as it needs. Serve and refresh are two different values, one after the other, never the same memory at the same time.

The cost: one extra allocation per revalidation. For a cache refreshing popular keys periodically, that's a handful of allocations per minute per key. Cheap compared to readers waiting on writers.

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

Unknown directives are silently skipped. This is deliberate. `Cache-Control` was designed to grow over time — origins send things like `immutable` or `stale-if-error` that this parser doesn't handle. If unknown directives caused an error, the cache would break when an origin ships a new header. This header was built to be safely ignorable.

`parseCacheControl` works for both request and response headers. Request and response share vocabulary (`no-cache`, `no-store`, `max-age`). Where the meaning changes by direction — a request's `no-cache` means "check with origin," a response's `no-cache` means "store but never serve without checking" — the caller handles the difference. `ServeHTTP` reads a request's `noCache` one way. `freshnessWindow` reads a response's `noCache` another way.

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

The check order is the function's logic. `sMaxAge` beats `maxAge` when set — the shared-cache-specific number takes priority. Then `noCache` overrides and forces zero: the response is stored (useful for ETag-based revalidation) but never served without an origin check. If nothing is specified, the default is zero — no guessed "reasonable" TTL.

A response without freshness info is treated as immediately stale. Heuristic freshness — guessing a TTL from `Last-Modified` when nothing explicit is given — is spec'd but deliberately not implemented. Guessing wrong in the "too long" direction is the silent-staleness problem this whole post keeps returning to. Origins must be explicit. If they didn't say, we don't cache.

`mustRevalidate` collapses `staleUntil` to equal `freshUntil`. One line. That's the entire implementation of "no stale-serving for this response." The origin opts something specific — account balances, inventory — out of the grace period.

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

This function exists because of a bug in the first version of this post. The bug type is worth understanding: it doesn't panic, throw an error, or show up when you manually test by typing the same URL twice (you naturally type params in the same order). It shows up weeks later as an unexplained low hit rate on endpoints where a client library builds query strings from an unordered structure like a map. The fix is nine lines of sorting. Noticing you needed it was the real work.

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

Two load-bearing choices:

**Hashing.** Header values come from the client — uncontrolled input. A client can set `Accept-Encoding` or `Cookie` to anything, any length. Using raw values as part of a key lets a client control how much memory the key space consumes. Hashing to a fixed 16 bytes eliminates that regardless of which headers an origin varies on.

**The `\x00` separator.** Without a clear separator, two different header combinations could produce the same string before hashing. A NUL byte cannot legally appear in an HTTP header value, making the encoding unambiguous. Same principle as not building SQL queries by string concatenation: pick a separator the untrusted input cannot contain.

### Store: The LRU

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

Three maps, one list. `items` is the LRU — a map from key to list element, ordered by recency. `varyIndex` makes the two-level key scheme work: URL to the vary header names learned for it. `variants` makes purging correct: URL to the set of every secondary key that URL has produced.

**Why a linked list, not a slice.** An LRU needs two fast operations: "move this to the front" (on hit) and "remove whatever's at the back" (on eviction). Both must be instant regardless of cache size. A slice can't move an element to the front without shifting everything before it — slower as the slice grows. A doubly linked list does both instantly when you have a pointer to the target node. The `items` map provides that pointer: from key to the list node. The map finds things. The list orders them. Neither alone solves the problem.

**Why LRU and not LFU.** LFU requires tracking a count per entry and finding the smallest count during eviction — either by scanning everything (slow) or maintaining a second structure (complexity on every access). LFU also has a known problem: something extremely popular yesterday but dead today sticks around because its count is still high. LRU's assumption is simpler: something used recently will likely be used again soon. That holds up well for HTTP cache traffic and is much cheaper to implement correctly.

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

**Why not `RWMutex`?** This is a read-heavy structure. Most calls are `Get`, not `Set`. `RWMutex` exists for exactly that pattern. But `Get` isn't "just reading" — on a hit, it calls `MoveToFront`, which mutates the linked list. If `Get` took a read lock, two goroutines could both call `Get` simultaneously and both rearrange the list at the same time. That's a data race on the list's internal pointers — not wrong answers, but actual list corruption. Loops, lost entries.

The fix isn't "give the map an `RWMutex` and the list its own lock." Two locks create a new problem: lock ordering. Two goroutines grabbing them in opposite order is a deadlock risk. One plain `Mutex` covering everything is simple and correct: nothing can observe the map, list, and vary index in an inconsistent state, because only one goroutine touches any of them at a time. If this lock becomes a bottleneck, the standard fix is hash-based sharding into independent stores, each with its own lock — not switching lock types.

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

Eviction runs inline in `Set`, not on a timer or background goroutine. The upside: memory never exceeds the limit by more than one entry's worth. No window where the cache is over budget because cleanup hasn't run yet. In a container with a hard memory limit, this guarantee matters — "cleanup is behind" is the kind of thing that becomes an OOM kill at the worst time. The cost: a `Set` that needs to evict many entries pays for it inline. That's acceptable because `Get` is the hot path, and `Get` never evicts.

**Why `variants` exists.** `secondaryKey` is a one-way hash. Given a stored key, you cannot compute which URL it came from. When you need to purge every version of a URL (gzip, plain, whatever `Vary` produced), you can't derive that from hashed keys — the information is gone. `variants` remembers the URL-to-keys relationship on the side, so you never need to reconstruct what the hash already discarded.

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

A `PURGE /some/path` request names one URL. The caller doesn't know how many Vary-based versions exist underneath. `DeleteAllVariants` walks only `variants[primary]` — the exact set of keys for that URL. A purge is equally fast whether the cache has 500 or 5 million entries. Without `variants`, you'd need to scan every entry in the store.

### Singleflight

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

Two obvious approaches fail, and understanding why clarifies the real design.

**Attempt one: a per-key lock held for the entire fetch.**

```go
// DOES NOT actually coalesce — shown to explain why, not as usable code.
func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	lock := f.lockFor(key)
	lock.Lock()
	defer lock.Unlock()
	return fn()
}
```

This serializes concurrent requests but doesn't deduplicate them. Each goroutine still calls `fn` — they just take turns. 200 requests still means 200 origin calls, now sequential instead of parallel. The 200th request waits behind 199 fetches, and origin load is unchanged. This solves the wrong problem.

**Attempt two: check, then fetch, with nothing tying the steps together.**

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

This is a classic check-then-act bug. Between `f.mu.Unlock()` after the check and whatever "wait somehow" does, a second goroutine can run the same check, find nothing registered, and call `fn()`. Checking "is something in flight" and registering "something is now in flight" must be atomic.

The real `Do` holds the lock across both the check and the registration together, then releases it before calling `fn`. There's no reason for a slow fetch on one key to block unrelated keys from making progress.

**The deletion order is critical.**

```go
c.val, c.err = fn()
c.wg.Done()          // unblocks every waiter

f.mu.Lock()
delete(f.calls, key)  // only now does the map forget this call happened
f.mu.Unlock()
```

`wg.Done()` runs before the map deletion, never after. If the order were reversed, there'd be a window where the call isn't marked "in flight" but hasn't finished either. A new request arriving in that window would see an empty map, conclude nothing is in flight, and start a redundant fetch. `Done()` first closes that window entirely. By the time the key disappears from the map, every waiter already has its answer.

## Proxy: The Full Request Path

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

The request's own `Cache-Control` matters too. A request with `Cache-Control: no-cache` — what a browser sends on hard refresh (Ctrl+Shift+R) — means "don't trust your cache, check with the origin." Miss this, and a hard refresh behaves identically to a regular refresh, which is a real bug.

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

`Age` is a required header for shared caches under the HTTP spec. It keeps downstream caches correct about what Ring has done. If a browser sits behind Ring and Ring sends a response with `max-age=60` but no `Age`, the browser doesn't know the response might already be 45 seconds old. It assumes it's fresh and caches for another 60 seconds — the origin's intended 60-second window becomes 105 seconds. `Age` fixes this: the browser sees it and shortens its own freshness window.

Passing `now` explicitly instead of calling `time.Now()` in each function means the freshness decision and the `Age` value come from the same instant. Two separate time calls microseconds apart would create a small inconsistency between what the cache decided and what it told the client.

## Concurrency Correctness

**The claim:** no matter how many `Get`, `Set`, `Delete`, and `DeleteAllVariants` calls run concurrently, the result is always equivalent to executing them one at a time in some order. No caller ever observes a half-finished state.

**Why it's true:** every method touching the list, items map, vary index, or variants map acquires `s.mu` first and holds it for the entire operation. Go's `Mutex` guarantees mutual exclusion: when one goroutine unlocks, that unlock happens-before the next goroutine's lock succeeds. Two operations can never overlap in time. Every call sees exactly what the previous call left behind.

The one thing requiring care: every line touching those four structures must be inside a locked section. No exceptions. The helper functions ending in "Locked" signal "the caller must already hold the lock." Go can't enforce this at compile time — it's a naming convention that every call site must respect. That's why all this logic lives in one file (`store.go`) instead of being spread across files where someone might not know the convention.

## Benchmarks

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

Run it:

```
go test ./cache/ -bench OriginCallCount -run ^$ -benchtime 1x
```

This measures the concrete claim: 100 concurrent requests, same key, one origin call. Not "should be fast" — an actual number.

There's also a wall-clock benchmark pair (`WithoutCoalescing` vs `WithCoalescing`), but they need careful interpretation. Since all 100 fake origin calls in the uncoalesced version are just goroutines sleeping simultaneously, the wall-clock time is roughly the same either way (~10ms). The real cost of missing coalescing doesn't appear as slower wall-clock time in a benchmark — it appears as 100 real network calls to a real origin instead of 1. That's why `OriginCallCount` exists separately: wall-clock speed and origin load are different questions.

## What Production Adds Beyond This

This is a complete, correct, single-node cache. But there's distance between this and production.

**Trusting the Host header.** The proxy trusts whatever the request's routing already decided. It doesn't independently validate that a request for one origin is actually meant for it. If the load balancer doesn't strictly validate `Host` before routing, someone could trick the cache into storing a response under the wrong key. This is a documented attack category. Closing it is an infrastructure-level guarantee, not something `cache/` alone can fix.

**Caching error responses.** Currently, only 2xx responses are cached. A URL that correctly 404s is fetched from origin every time, forever. Someone could exploit this by hammering known-missing URLs to generate load. A production version would want a short, capped negative cache for 404s with its own separate TTL.

**Visibility.** There's no way to see which keys are hot, which are cold, or what the hit rate is per endpoint. Not a correctness problem, but the kind of gap that turns a small production issue into a long, confusing one. "The cache seems slow" is a worse starting point than "the hit rate on `/api/search` dropped at 14:02."

## What's Next

This node has no idea any other node exists. `HandlePurge` clears only the node it hits. Two Ring nodes in front of the same origin would each build their own separate cache with no way to coordinate.

This is deliberate. Everything in this post — the Vary-aware keys, the LRU with its correctness argument, the singleflight coalescer — needed to be solid and testable alone before a second node enters the picture. Debugging a gossip protocol and a caching bug simultaneously, with no way to tell which is misbehaving, is a genuinely bad time.

Part 2 introduces SWIM — the failure-detection protocol behind Consul and Cassandra. It answers "who's alive right now" with no central coordinator and without every node pinging every other node every round.

## Repository

Full source, including every test and benchmark, is in the `ring/` module: `cache/entry.go`, `cache/freshness.go`, `cache/key.go`, `cache/store.go`, `cache/singleflight.go`, `cache/proxy.go`, tests alongside each one, and a runnable reverse proxy in `cmd/ring/main.go`. Run the suite with `go test ./... -race` — since much of the correctness argument rests on concurrent access working correctly.
