---
title: "Building Ring: A Distributed Edge Cache, Part 1 — The Cache Core"
date: "2026-7-4"
readTime: "20 min read"
category: "Distributed Systems"
---

## What We're Building

Ring is a cache cluster. Multiple nodes sit in front of an origin server, absorb repeated requests for the same resources, and stay correct as nodes join, leave, or die. There's no coordinator process, no external database, no etcd. Every node figures out cluster state on its own, through direct communication with the other nodes.

That's the eventual system. This post builds the piece every other piece depends on: what a single node does when it receives one HTTP request. Before there's a cluster, there has to be a cache that behaves correctly, because a distributed system that gets caching wrong on one node just gets it wrong on N nodes with better marketing and worse debugging.

I'm going to build this the way we built klog: define the problem precisely enough that the code is the only reasonable answer, not one of several plausible answers you'd have to guess between.

## Why This Exists At All

Skip this section if you've internalized it already, but it's worth being precise about, because every design decision later in this post traces back to it.

An origin server doing real work — a database query, a template render, an aggregation — has a cost per request that doesn't disappear just because the response happens to be identical to the one it served ten seconds ago. If a resource is requested a thousand times a second and its underlying data changes once a minute, roughly 59,999 out of every 60,000 requests are asking a question whose answer the system already computed. A cache is a mechanism for answering those 59,999 without repeating the computation.

Two failure directions exist, and they're not symmetric in cost:

**Caching too little** wastes the opportunity — origin load stays high, latency stays high, and the cache might as well not exist. This is a performance bug. Annoying, measurable, fixable by tuning.

**Caching too much, or caching incorrectly**, means serving stale prices, stale inventory counts, or — in the worst case — one client's private response to a different client. This is a correctness bug, and it's the more dangerous failure mode because it doesn't announce itself. A cache that's too conservative shows up in your latency graphs immediately. A cache that occasionally serves the wrong thing to the wrong person shows up in a support ticket, or an incident review, weeks after the bug shipped.

This is why the entire first half of this post is about HTTP's actual caching rules, not about data structures. The data structures are the easy part. Getting them to do the _correct_ thing, per the actual semantics an origin is relying on, is where a cache either earns trust or becomes a liability nobody wants to turn on in production.

## The Four Questions, In Full

A cache sitting between a client and an origin answers four questions on every request, in order. I sketched these briefly before jumping to code last time — here's the actual depth each one deserves.

### 1. Is there a stored response for this exact request?

The naive answer — hash the URL — is wrong, and it's wrong in a way that will pass every test you write if you don't specifically test for it.

HTTP has a response header called `Vary`. When an origin serves `GET /api/users`, it can include `Vary: Accept-Encoding` in the response, which is a promise from the origin to any cache reading it: _the body of this response depends on the client's Accept-Encoding request header. Do not serve this specific response to a client that sent a different Accept-Encoding._ A client that sent `Accept-Encoding: gzip` gets compressed bytes. A client that sent `Accept-Encoding: identity` — or nothing — gets raw bytes. Same URL, same method, genuinely different response bodies, and serving the wrong one to the wrong client either corrupts their response (a browser trying to decompress bytes that were never compressed) or wastes bandwidth (serving uncompressed bytes to a client that explicitly said it can handle compression).

`Accept-Encoding` is the textbook example, but it's not the only one, and this is where it gets sharp: `Vary: Cookie` exists, and it means exactly what it looks like — the response differs based on session state carried in a cookie. A cache that ignores `Vary: Cookie` and treats a URL as a single cache key will, with total mechanical inevitability, eventually serve one logged-in user's personalized response to a different logged-in user who happened to request the same URL a few seconds later. That's not a hypothetical edge case; it's one of the more common real-world cache-poisoning incidents, and it happens because someone built exactly the naive "hash the URL" cache I described at the top of this section.

The complication that makes this a genuine engineering problem, not just a lookup table with extra steps: `Vary` is part of the _response_. A cache cannot know, before it has ever seen a response for a given URL, which request headers matter for that URL. This creates an unavoidable two-phase structure: the first request for any URL is always, necessarily, a cache miss that goes to origin — there's no way around that, and no cache scheme legitimately avoids it. What the scheme controls is everything _after_ that first response: it has to remember which headers `Vary` named, and use exactly those headers' values, and no others, to distinguish subsequent requests.

### 2. If there's a stored response, is it still usable?

`Cache-Control: max-age=60` reads like "cache this for 60 seconds," and as a mental starting point that's fine. As an actual specification it's incomplete in ways that matter.

`s-maxage` exists specifically to give shared caches — proxies, CDNs, this project — a different freshness window than a browser gets. This isn't a redundant alternate syntax; it's the origin distinguishing between two different trust relationships. A browser cache serves exactly one user; a shared cache like Ring serves everyone. An origin might reasonably say "browsers can cache this for 10 seconds, but Ring can cache it for 5 minutes," because the origin's operators have decided the risk profile of serving slightly-stale data to _many_ users behind a shared cache is different from the risk of one browser doing it. Ignore `s-maxage` and either serve staler content than the origin intended for many users, or serve fresher content than the origin's infrastructure was actually sized to handle if that's genuinely more aggressive than intended.

`no-store` is unconditional: never write this to persistent or shared storage at all, full stop, no exceptions for revalidation purposes either. `private` is narrower: this response is fine to cache, but only by something serving exactly one user — a browser, not a shared cache. A shared cache that treats `private` as cacheable will, again with total mechanical inevitability, eventually leak one user's private data to another.

`must-revalidate` changes what happens _after_ expiry, not before: once this response's freshness window closes, the origin insists on being asked again before anything is served — no stale-while-revalidate grace period, no benefit of the doubt if the origin is briefly unreachable. This is the directive an origin puts on a response where staleness has a real cost: an account balance, an inventory count, anything where "close enough" isn't actually close enough.

None of this is exotic. It's the specification working exactly as designed — different directives exist because different responses genuinely need different treatment, and a cache that flattens them all into "check a timestamp" is a cache that will eventually violate an origin's explicit, stated intent.

### 3. Can it be served stale while a fresh copy is fetched?

Stale-while-revalidate exists because the alternative — making a client wait on a full origin round trip every single time a resource crosses its freshness boundary — throws away most of the latency benefit a cache exists to provide. If a resource has `max-age=60` and gets requested continuously, the client whose request happens to land at second 61 shouldn't pay the full origin latency just because they were unlucky about timing; the response from second 59 is still, for almost any practical purpose, a perfectly good answer, and the client can have it immediately while a background fetch quietly brings the entry current for whoever asks next.

The word doing the real work in that paragraph is _bounded_. Left unbounded, stale-while-revalidate stops being a latency optimization and starts being a way to silently disable freshness checking. If an origin goes down for six hours, an unbounded stale window means the cache keeps confidently serving six-hour-old data with no indication anything is wrong — which might occasionally be the desired failure mode (better stale than a 500 page, for some kinds of content) but is absolutely not something a cache should default into without an operator deciding that's what they want. This is why the stale window in this project is a fixed cache-side constant, not something an origin can extend arbitrarily through its own headers — more on that decision in the design-decisions section below.

### 4. If two hundred requests for the same expired resource arrive in the same ten milliseconds, does the origin get hit two hundred times, or once?

This is the question that separates a cache that helps under normal load from a cache that becomes actively dangerous under the specific load pattern where it matters most.

Here's the mechanism, precisely: a resource is popular, meaning many concurrent requests want it. Its freshness window closes. Every one of those concurrent requests, checking the cache at roughly the same instant, sees "expired" — because from each individual request's point of view, nothing has been fetched yet. Without coordination between them, every single one independently decides "I need to fetch this from origin," and they all do, at once. The exact moment a cache should be doing the most work to protect the origin — a spike in demand for one resource — is the exact moment an uncoordinated cache amplifies that spike into an origin-side stampede, because "cache miss" fired two hundred times for what was, from the system's perspective, one event: one resource going stale.

This is sometimes called cache stampede, or thundering herd. The fix, singleflight-style request coalescing, is conceptually simple — the first request to notice the miss does the fetch, everyone else waits on that same fetch — but the implementation has real correctness constraints, covered in depth further down, because getting the handoff between "in flight" and "not in flight" wrong reintroduces the exact race it's supposed to close.

## Walking Through an Actual Request

Before the code, here's the complete lifecycle of one URL through this system, with concrete timestamps, because the four questions above are easier to hold in your head as a sequence of state transitions than as an abstract list.

Assume `GET /api/products/42`, origin responds with `Cache-Control: max-age=60`, and this project's fixed stale window is 30 seconds.

| Time                                                        | Event                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t=0s                                                        | First request arrives                          | `Store.Get` — nothing indexed for this URL yet. Miss. Goes through `Flight.Do`, which finds no in-flight call, executes the real origin fetch. Response comes back, `freshnessWindow` computes `FreshUntil = t+60s`, `StaleUntil = t+90s`. Entry stored. Client gets the response with `Age: 0`.                                                                                                                                                              |
| t=5s                                                        | Second request, same URL, different client     | `Store.Get` hits. `now (t=5) < FreshUntil (t=60)` — fresh. Served directly, no origin contact, `Age: 5`.                                                                                                                                                                                                                                                                                                                                                      |
| t=59.999s, t=60.000s, t=60.001s (three concurrent requests) | Burst right at the freshness boundary          | All three call `Store.Get` at nearly the same instant. Depending on exact timing, some see fresh, some see expired — this is fine and expected, freshness boundaries aren't required to be atomic across concurrent observers, only consistent for a single observer's own decision. Say all three land just past 60s: all three see `Stale`. Each calls `writeEntry` with the still-cached body immediately (no waiting), then each calls `revalidateAsync`. |
| t=60.001s (continued)                                       | Three background revalidations kick off        | All three hit `fetchCoalesced`, which routes through `Flight.Do` keyed on the same primary key. Exactly one of them actually calls `fetch()` against origin. The other two block on that call's `WaitGroup` and receive its result when it completes — origin sees one request, not three, for this refresh.                                                                                                                                                  |
| t=60.050s                                                   | Revalidation completes                         | Origin replied `304 Not Modified` (nothing changed) with an updated `Cache-Control: max-age=60`. `buildRevalidatedEntry` reuses the old body, computes a new `FreshUntil = t+60.05+60`, stores it.                                                                                                                                                                                                                                                            |
| t=61s                                                       | A fourth request arrives                       | `Store.Get` hits the _new_ entry from the revalidation at t=60.050s. Fresh again. Served directly.                                                                                                                                                                                                                                                                                                                                                            |
| t=200s (origin has been unreachable since t=150s)           | A request arrives for a now hard-expired entry | `Store.Get` returns an entry with `StaleUntil` long past. `entry.Expired(now)` is true — not eligible for stale serving at all. Falls through to `fetchCoalesced`, which calls origin, which fails (unreachable). `p.serveError` returns `502 Bad Gateway` to the client. The cache does not silently serve day-old data past its own configured stale ceiling — this is the fixed-stale-window decision from Question 3, made concrete.                      |

That table is the entire system, mechanically. Everything else in this post is either the data structures that make each row correct, or the reasoning for why each row is correct instead of one of the several plausible-looking alternatives.

## Design

Four pieces:

- **`Entry`** — an immutable snapshot of a cached response, carrying its own freshness and staleness boundaries.
- **`Store`** — a byte-bounded LRU keyed by the two-level Vary-aware scheme, with query-parameter normalization.
- **`Flight`** — the singleflight coalescer.
- **`Proxy`** — the `http.Handler` tying the above three into the request path from the table above.

No external dependencies. Standard library only. This matters for a piece of infrastructure that has to be correct before anything else gets layered on top of it — every dependency is something that could itself have a bug, a breaking change, or behavior you didn't fully audit.

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

Immutability is the decision this whole type hangs off of, so it's worth defending directly rather than asserting. Consider the alternative: `Entry` fields are mutable, protected by a `sync.RWMutex` embedded in the struct. A revalidation takes the write lock and updates `Body`, `FreshUntil`, and the rest in place.

That design has a specific, real failure mode: `writeEntry` writing a response body to a client isn't instantaneous. It's `w.Write(e.Body)`, which for a large body or a slow client connection can take a meaningful amount of wall-clock time — the write blocks on TCP backpressure from that specific client's connection. If `Entry` were mutable-with-a-lock, that write would need to hold a read lock for its entire duration, because the alternative — reading `Body` without a lock while a revalidation might be writing to it — is a data race, full stop, not a theoretical one; Go's race detector would flag it immediately and correctly. And a read lock held by a slow client blocks the write lock a revalidation needs, meaning one slow client can stall a cache entry's refresh for everyone else hitting that same key.

With immutable entries, this problem doesn't exist by construction. A revalidation doesn't touch the `Entry` a slow client is currently reading from — it builds an entirely new `Entry` and the `Store` swaps a pointer. The slow client keeps reading from the old, still-perfectly-valid `Entry` for as long as its write takes. No lock is shared between "serve this to a client" and "refresh this in the background," because there's nothing to share a lock over — they're operating on two different values that happen to occupy the same conceptual "current entry for this key" slot, one after the other, not concurrently on the same memory.

The cost is real and worth naming: one extra heap allocation per revalidation, versus updating fields in place. For a cache that's revalidating popular keys periodically rather than on every request, that's a cost measured in a handful of allocations per minute for a given key, not a hot-path cost — a trade very much worth making for readers that never block on writers.

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

One deliberate property: unrecognized directives are silently skipped. `Cache-Control` is explicitly designed as an extensible header — real origins send `immutable`, `stale-if-error`, `stale-while-revalidate=N` (a version of this exact mechanism specified as an origin-controlled directive, which this project intentionally does not honor — see the design-decisions section), and others this parser has no case for. A parser that treats an unrecognized token as an error would break in production the first time an origin's team ships a header this cache wasn't updated for. Ignoring what you don't understand is correct here specifically because the header format was designed to be safely ignorable — this isn't true of most parsing problems, and it's worth being clear that this is a property of _this specific header_, not a general parsing philosophy.

`parseCacheControl` takes an `http.Header` and doesn't care whether it came from a request or a response — the same function reads a client's `Cache-Control: no-cache` and an origin's `Cache-Control: max-age=60`. This is deliberate reuse, not laziness: the token vocabulary genuinely overlaps (both sides use `no-cache`, `no-store`, `max-age`), and where the _meaning_ differs by direction — a request's `no-cache` means "revalidate before serving me anything," a response's `no-cache` means "store this but never serve without revalidating" — that distinction is handled at the call site, not inside the parser. `ServeHTTP` reads `reqDirectives.noCache` to force revalidation; `freshnessWindow` reads a response's `noCache` to collapse the freshness window to zero. Same field, two call sites, two meanings — the parser's job stops at "what did the header say," not "what does it mean given which direction it came from."

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

Trace the precedence order once, explicitly, because it's the entire function's logic compressed into four lines and worth unpacking: `sMaxAge` overrides `maxAge` when present (shared-cache-specific TTL wins, per the Question 2 discussion above), `noCache` then overrides whatever was just computed down to zero (a response can be stored — useful for ETag-based revalidation — while still demanding revalidation on literally every serve), and a missing directive defaults to zero rather than some assumed default TTL. That last one is a real decision: a response with no freshness information at all is treated as immediately stale, not as "cacheable for some reasonable guessed duration." Heuristic freshness — guessing a TTL from a `Last-Modified` header when no explicit directive exists — is a real technique specified in RFC 9111, and it's deliberately not implemented here. Guessing wrong in the direction of "cached too long" produces exactly the silent-staleness failure mode this whole post has been arguing against; requiring origins to be explicit is a stricter, safer default for a cache that would rather under-cache than misjudge someone else's freshness intent.

`mustRevalidate` collapsing `staleUntil` to equal `freshUntil` is the one-line implementation of "no stale-while-revalidate for this resource, period" — an origin opting a specific response class (account balances, inventory, anything where "close enough" costs real money) out of the grace window entirely.

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

This one is worth flagging as a bug I actually introduced in the first version of this post and only caught while going back over it for this rewrite — which is itself a useful data point about this class of problem: query-order sensitivity doesn't fail loudly. It doesn't panic, doesn't error, doesn't show up in a quick manual test where you naturally type the same URL the same way twice. It shows up as an unexplained low hit rate weeks later, on exactly the endpoints where a client happens to construct query strings from an unordered structure. The fix is nine lines of sorting. Finding the need for it is the actual work — which is why walking through _why_ a design choice matters, not just what it is, is worth the extra length in a post like this.

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

Two things about this function that are each independently necessary, not decorative:

Hashing instead of concatenating raw values into the map key directly. Header values are attacker-controlled — a client sets its own `Accept-Encoding`, `Cookie`, whatever `Vary` names — and unbounded in length. If a `Vary` header named something a client could stuff with kilobytes of garbage, using the raw value as (or as part of) a map key means a client controls the memory footprint of your key space directly. Hashing to a fixed 16 bytes closes that off entirely, regardless of what headers an origin decides to vary on.

The `\x00` separator between header name and value, and between entries, isn't arbitrary — it's specifically there to prevent a header-value injection collision. Without an unambiguous separator, `secondaryKey` for `Vary: X` with header value `"a=b"` could theoretically produce the same intermediate string as a different header combination that happens to concatenate to the same bytes. A NUL byte can't appear in a valid HTTP header value, so using it as the separator guarantees the encoding is unambiguous — there's exactly one way to have produced any given intermediate string. This is the same category of bug as SQL injection via string concatenation, just in a hash input instead of a query — the fix is the same idea: use a separator the untrusted input structurally cannot contain.

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

`container/list` is Go's standard-library doubly linked list, and it's worth being explicit about why an LRU needs one instead of, say, a slice. The two operations an LRU needs on every access are "move this element to the front" (on a hit, marking it most-recently-used) and "remove the element at the back" (on eviction, removing the least-recently-used). Both need to be O(1) for the cache to have predictable latency regardless of size — an eviction shouldn't get slower as the cache grows. A slice can't do either in O(1): moving an element to the front of a slice means shifting every element before it, which is O(n). A doubly linked list does both in O(1), _provided you already have a pointer to the node being moved_ — which is exactly what `items map[string]*list.Element` gives you. The map's job is purely "given a key, find the list node in O(1)"; the list's job is purely "given a node, reorder it in O(1)." Neither structure alone solves the problem; the combination does.

This is also why LRU specifically, rather than LFU (least-frequently-used) or something more elaborate. LFU requires tracking an access count per entry and, on eviction, finding the minimum — which either means a linear scan (bad) or a second data structure like a min-heap keyed on frequency (workable, but real added complexity: every access now updates two structures instead of one, and ranking by frequency alone has its own well-known failure mode where an entry that was extremely popular yesterday and completely dead today stays resident far longer than it should, crowding out genuinely current data). LRU's core bet — recently used is a reasonable proxy for likely-to-be-used-again — holds well for HTTP cache workloads specifically, because request patterns tend to have real temporal locality: a resource getting hit right now is a good predictor of it getting hit again in the near future, which is a weaker but cheaper signal than frequency, purchased at a much simpler implementation.

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

**Why a single `Mutex`, argued properly this time, not just asserted.** The obvious objection: this is read-heavy — most calls are `Get`, not `Set` — and `RWMutex` exists precisely for read-heavy workloads, letting many readers proceed concurrently while writers get exclusive access. So why not use it?

Because `Get`, on a hit, is not actually a pure read. `s.ll.MoveToFront(el)` mutates the list's internal pointers — it's a write to the list's structure, even though conceptually the caller is "just reading" a cached value. If `Store` used a `RWMutex` and `Get` took a read lock, you'd have multiple goroutines concurrently calling `MoveToFront` on the same `*list.List` under a lock that permits concurrent access — which is a data race on the list's internal `prev`/`next` pointers, the kind that corrupts the list structure itself (not just returns a wrong value — actually breaks the list's invariants, potentially forming a cycle or losing elements) and that Go's race detector will catch, but only if you actually run your tests with `-race`, which is exactly why every test in this project's suite should be run that way.

The correct fix isn't "use `RWMutex` for the map and a separate lock for the list" — that reintroduces a two-lock ordering problem (which lock do you take first? what happens if a goroutine holds one and blocks trying to acquire the other while a second goroutine does the reverse?) for a marginal concurrency gain on a code path that's already just three map/list operations, not something doing real work under the lock. A single `Mutex` around all three data structures keeps the invariant "the map, the list, and the vary index are always consistent with each other" trivially true, because nothing can observe them mid-update. If profiling under real load later shows contention on this specific lock is an actual bottleneck, the standard, well-understood fix is sharding — N independent `Store` instances, each with its own lock, selected by hashing the key — not switching lock types on the existing single store.

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

Eviction runs synchronously, inline, on every `Set` that pushes the store over capacity — not on a timer, not on a separate background goroutine sweeping periodically. This is a real tradeoff and worth naming both sides of it honestly. The benefit: the store's byte usage never exceeds `maxBytes` by more than the size of one entry, at any moment any other goroutine could possibly observe — there is no window where memory usage has ballooned past the configured limit because a background sweep hasn't run yet. For a cache running inside a process with a fixed memory budget (a container with a memory limit, for instance), that guarantee is worth having exactly because "the background sweep hasn't caught up" is precisely the kind of transient condition that turns into an OOM kill under real load, at the worst possible moment. The cost: a `Set` call that needs to evict many entries pays for all of them inline, making that particular call slower than a `Set` that doesn't trigger eviction. That's an acceptable trade specifically because `Set` is already off the hot path — the hot path is `Get`, which never evicts — and because "occasionally slower writes" is a far more tolerable failure mode than "occasionally unbounded memory."

**The `variants` map, and why it's not redundant with `items`.** `secondaryKey` is a one-way SHA-256 hash. Given a stored key, there is no computation that recovers which primary key produced it — that's what "one-way" means. So when a purge needs to find and remove every Vary variant of a URL (the gzip'd version, the identity version, and any other combination `Vary` might produce), scanning `items` and trying to reverse-match secondary keys against a primary key isn't slow, it's _impossible_ — the information needed to make that match simply isn't recoverable from the hash. `variants` exists to keep that relationship around explicitly, maintained incrementally as entries are stored, specifically so that relationship doesn't need to be reconstructed later from data that no longer contains it.

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

A `PURGE /some/path` request from an operator names a URL, not a URL-plus-encoding-combination — the person issuing the purge doesn't know or care how many Vary variants happen to exist underneath that path, and shouldn't have to. `DeleteAllVariants` walks exactly the set `variants[primary]` gives it — O(number of variants for this one URL), not O(total entries in the store) — which is the difference between "purge is instant regardless of cache size" and "purge gets slower as the cache grows," a distinction that's invisible at 500 entries in a test and very much not invisible at 5 million entries in production.

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

It's worth walking through why this specific shape, by looking at two more obvious-seeming designs and where each one breaks.

**Obvious attempt #1: a mutex per key, held for the duration of the fetch.**

```go
// DOES NOT actually coalesce — shown to explain why, not as usable code.
func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	lock := f.lockFor(key) // some per-key mutex
	lock.Lock()
	defer lock.Unlock()
	return fn()
}
```

This looks like it should work — only one goroutine holds `lock` at a time, so `fn` only runs once at a time per key. But "once at a time" is not the same claim as "once, with everyone else getting that result." Every goroutine here, once it acquires the lock, _still calls `fn` itself_ — they just take turns doing so, sequentially, rather than concurrently. Two hundred concurrent requests for the same expired key still produce two hundred origin fetches; they just happen one after another instead of all at once. That's arguably worse for latency (the 200th request now waits for 199 sequential fetches instead of one concurrent one) while providing zero reduction in origin load. This design solves a different problem — preventing concurrent _writes_ to a shared resource — not the problem at hand, which is preventing redundant _work_.

**Obvious attempt #2: check-then-fetch without a registration step.**

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

The bug here is a classic check-then-act race, the same family of bug as an unlocked `if !exists { create() }`. Between the `f.mu.Unlock()` after checking `inFlight` and whatever "wait somehow" ends up meaning, another goroutine can run the exact same check, also find nothing in flight, and also proceed to call `fn()`. The registration of "a call for this key is now in flight" has to happen atomically with the check for whether one already is — which is exactly what the real `Do` does by holding `f.mu` across both the lookup _and_ the `c := new(call); f.calls[key] = c` registration, only releasing the lock once the invariant "if there's a call in flight, it's in the map" is fully established for this key. Splitting the check and the registration into two separately-locked sections, even briefly, opens a window where two goroutines both believe they're the first.

The actual `Do` closes that window by holding the lock across check-and-register as a single atomic step, then explicitly releasing it _before_ calling `fn` — so the potentially-slow origin call never happens while the lock is held, which would otherwise serialize unrelated keys through this one lock for no reason.

The other detail worth being precise about: the map entry is deleted _after_ `wg.Done()`, not before, and specifically after — not concurrently with, not just before in wall-clock terms coincidentally, but as a strictly later step in program order:

```go
c.val, c.err = fn()
c.wg.Done()          // <-- unblocks every waiter

f.mu.Lock()
delete(f.calls, key)  // <-- only now does the map forget this call happened
f.mu.Unlock()
```

If deletion happened first — `delete(f.calls, key)` before `c.wg.Done()` — there's a window where the call is no longer registered as in-flight, but hasn't finished either. A new request arriving in exactly that window would find nothing in `f.calls`, correctly conclude no call is in flight (from its point of view, that's true — the map says so), and start a second, entirely redundant fetch, precisely the outcome this mechanism exists to prevent. Ordering `Done()` before the delete closes that window completely: by the time a key is removed from the map, every goroutine that was ever waiting on it has already been released with its result.

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

The first version of this post's `ServeHTTP` only looked at the _response's_ `Cache-Control`. That's half the specification. A request can carry `Cache-Control: no-cache` too — this is literally what a browser's hard-refresh (Ctrl+Shift+R / Cmd+Shift+R) sends — and it means something specific: _even if you think you have a fresh copy, don't trust it, ask origin first._ It's a client overriding the cache's own freshness assessment for this one request, not a statement about how the response should be cached afterward. Missing this means a user's hard-refresh silently does nothing different from a normal refresh, which is a real, user-visible correctness gap, not a nice-to-have.

`writeEntry` now takes `now` as an explicit parameter rather than calling `time.Now()` internally:

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

This is a small function doing something that's easy to skip and genuinely shouldn't be skipped: `Age` is a required response header for a shared cache under the HTTP caching specification, and it's not bureaucratic box-ticking — it's how the rest of the world stays correct about _this_ cache's behavior. If a browser sits behind Ring and Ring serves a response with `max-age=60` but no `Age` header, the browser has no way to know that response is already 45 seconds old from Ring's perspective; it'll (correctly, given what it can see) treat it as freshly minted and cache it for another full 60 seconds on top, producing an effective 105-second staleness window when the origin only ever authorized 60. `Age` closes that gap — the browser factors it in and correctly shortens its own local freshness window by however old the response already was. Passing `now` in explicitly, rather than each function calling `time.Now()` independently, also guarantees the freshness decision in `ServeHTTP` and the `Age` value written to the client are computed from the _same instant_ — using two separate `time.Now()` calls a few microseconds apart would be a genuine, if tiny, inconsistency between "why we decided to serve this" and "what we told the client about how old it is."

## Concurrency Correctness, Argued Directly

I want to state the actual claim about `Store` precisely, then argue it, rather than leaving "it's thread-safe" as an assertion to take on faith.

**Claim:** for any sequence of concurrent `Get`, `Set`, `Delete`, and `DeleteAllVariants` calls on a single `Store`, the observable behavior is equivalent to _some_ sequential ordering of those same calls — no call ever observes a state that couldn't have resulted from any valid interleaving executed one at a time.

**Argument:** every method that touches `s.ll`, `s.items`, `s.varyIndex`, or `s.variants` acquires `s.mu` before touching any of them and holds it for the method's entire critical section, releasing only via `defer s.mu.Unlock()` after all four structures have been brought back into mutual consistency. Because Go's `sync.Mutex` provides mutual exclusion — the language memory model guarantees that a goroutine's `Unlock` happens-before the next goroutine's successful `Lock` on the same mutex — no two critical sections can execute with any temporal overlap. Every method, therefore, executes as if it were the only thing running, observing exactly the state left by whichever critical section most recently completed, in the total order the mutex imposes on lock acquisitions. That's the definition of linearizability with respect to this mutex's critical sections, and it's why the store as a whole behaves correctly under concurrent access despite having no per-field synchronization.

The one place this argument requires care rather than being automatic: every field the four data structures touch has to actually be _inside_ a critical section, with nothing read or written outside one. Read back through `Get`, `Set`, `Delete`, `DeleteAllVariants`, `deleteKeyLocked`, and `evictLocked` — the two `*Locked`-suffixed methods are named that way specifically as a documented precondition (caller must already hold `s.mu`), not enforced by the type system, which is a real limitation worth being honest about: Go doesn't have a way to statically require a lock be held when a function is called, unlike languages with capability-based lock typing. The naming convention here is a substitute for that guarantee, and it only works as long as every call site is actually audited to respect it — which is exactly why the entire structure is confined to one file, `store.go`, rather than spread across the package where a distant caller might reasonably not know the convention exists.

## Benchmarks: Making the Coalescing Claim Measurable

Claims about performance without numbers are opinions. Here's the actual benchmark, and how to read it:

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

Run it with:

```
go test ./cache/ -bench OriginCallCount -run ^$ -benchtime 1x
```

The metric this reports is the actual claim, made concrete: 100 concurrent requests for the same key, one origin call. Not "fast" — one call, a number you can put in a design doc and defend, instead of "it should coalesce" as an unverified assertion about code you wrote and therefore have every incentive to believe works.

The wall-clock benchmarks (`BenchmarkThunderingHerd_WithoutCoalescing` versus `WithCoalescing`, also in the same file) are worth running too, but read them carefully — I called this out directly in the benchmark's own comment because it's a genuine gotcha: because all 100 simulated origin calls in the _uncoalesced_ version run concurrently as goroutines sleeping in parallel, the wall-clock time for that benchmark iteration is still only around 10ms, roughly the same as the coalesced version. The damage from missing coalescing doesn't show up as _this specific benchmark's_ wall time — it shows up as 100 real network calls hitting a real origin instead of 1, which is invisible to a benchmark that fakes the origin with `time.Sleep` and has no actual origin to overload. This is exactly why `OriginCallCount` exists as a separate benchmark measuring a different thing: a latency benchmark and a load-reduction benchmark are answering two different questions, and conflating them would produce a benchmark suite that looks reassuring while missing the actual point.

## What Production Adds Beyond This

This is a complete, correct single-node cache core — not a sketch missing pieces labeled "TODO," but there are real gaps between this and something you'd point a large amount of production traffic at unmodified, worth naming honestly rather than glossing over:

**Host header trust.** This proxy trusts whatever the incoming request's routing already resolved to — it doesn't independently validate that a request claiming to be for one origin is actually meant for it. A cache sitting behind a load balancer that doesn't strictly validate `Host` before routing can, in principle, be tricked into caching a response under one key that was actually generated by a different backend than intended — a real, documented class of cache-poisoning attack. Closing this fully means the deployment topology in front of this cache has to guarantee `Host` (and any header this cache's key scheme trusts) can't be spoofed past the load balancer, which is an infrastructure-level guarantee, not something `cache/` alone can enforce.

**Negative caching.** This version deliberately never caches non-2xx responses (see `cacheable` in freshness.go). That's the safer default, but it means a resource that legitimately 404s under real load gets the full uncached origin round trip on every single request for it — which is itself a mechanism an attacker could lean on to generate origin load by requesting known-missing resources repeatedly. A production version would likely want a short, deliberately-bounded negative cache for 404/410 specifically, with its own explicit TTL separate from the positive-cache path, not reusing `freshnessWindow` as-is.

**Per-key metrics.** Right now there's no visibility into which keys are hot, which are cold, what the actual hit rate looks like broken down by URL pattern. That's an observability gap, not a correctness one, but it's the kind of gap that makes a real production incident much harder to diagnose than it needs to be — "the cache seems slow" is a much worse starting point than "the hit rate on `/api/search` specifically dropped at 14:02."

None of these are required to make Part 1 what it claims to be: a correct, tested, single-node cache core. They're the honest list of what "correct on one node" doesn't yet cover, which is the right list to have written down before Part 2 adds a second node into the picture and multiplies every one of these considerations by however many nodes end up in the cluster.

## What's Next

This node still has no idea any other node exists. `HandlePurge` clears exactly the node it hits — real and complete as written, but strictly local. Two Ring nodes running today, in front of the same origin, would each build up a fully independent cache with no way to invalidate each other, which is a genuine correctness gap for anything actually claiming to be distributed.

That gap is deliberate, not deferred out of laziness. Everything built in this post — the two-level Vary-aware keys, the byte-bounded LRU with its documented single-lock correctness argument, the singleflight coalescer with its own set of documented near-miss designs — needed to be correct and independently testable before a second node enters the picture at all. Debugging a gossip protocol and a caching bug at the same time, on the same running system, with no way to isolate which one is misbehaving, is a genuinely bad way to find either one.

Part 2 builds the piece that makes a second node aware the first one exists: SWIM, the failure-detection protocol behind Consul's and Cassandra's membership layers, which answers "which nodes are alive right now" without a coordinator and without every node pinging every other node on every round.

## Repository

Full source, including the tests and benchmarks referenced throughout this post, is in the `ring/` module: `cache/entry.go`, `cache/freshness.go`, `cache/key.go`, `cache/store.go`, `cache/singleflight.go`, `cache/proxy.go`, test files alongside each, and a runnable reverse proxy in `cmd/ring/main.go`. Run the suite with `go test ./... -race` before reading further — `-race` specifically, given how much of this post's correctness argument rests on concurrent access being handled the way it claims to be.
