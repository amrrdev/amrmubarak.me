---
title: "Building Ring: A Distributed Edge Cache, Part 1 — The Cache Core"
date: "2026-7-4"
readTime: "20 min read"
category: "Distributed Systems"
---

## What We're Building

Ring is a cache cluster. Multiple nodes sit in front of an origin server. They soak up repeated requests for the same stuff, so the origin doesn't have to keep answering the same question over and over. Nodes can join, leave, or die, and the cluster has to keep working anyway. There's no coordinator process. No etcd. No external database. Every node figures out what's going on by talking to the other nodes directly.

That's the end goal. This post is about something smaller: what does _one_ node do when it gets _one_ HTTP request? Before you build a cluster, you need a cache that's actually correct on its own. A distributed system that gets caching wrong doesn't get better by adding more nodes — it just gets the same bug in more places, with worse debugging.

Same approach as klog: pin down the problem precisely first. Once you actually understand what "correct" means here, the code stops being a judgment call and starts being the only reasonable answer.

## Why This Exists At All

Skip this if it's obvious to you already. But it's worth being precise, because every decision later in this post comes back to this.

An origin server does real work for every request — a database query, rendering a page, some calculation. That cost doesn't go away just because the answer happens to be the same as it was ten seconds ago. Say a resource gets hit a thousand times a second, and the data behind it only changes once a minute. That means about 59,999 out of every 60,000 requests are asking a question the system already answered. A cache exists to answer those 59,999 without doing the work again.

There are two ways to get this wrong, and they are not equally bad.

**Cache too little**, and you just waste the opportunity. Origin load stays high, latency stays high, and the cache basically isn't doing anything. That's a performance problem. Annoying, but easy to notice and easy to fix.

**Cache too much, or cache the wrong thing**, and you serve stale prices, stale inventory counts, or — worst case — one person's private data to a different person. That's a correctness bug. And it's worse than the performance problem, because it doesn't announce itself. A cache that's too conservative shows up immediately in your latency graphs. A cache that occasionally leaks the wrong response to the wrong person shows up as a support ticket, weeks later, and by then you have no idea how long it's been happening.

That's why the first half of this post is about HTTP's actual caching rules, not about data structures. The data structures are the easy part. Doing the _correct_ thing — the thing the origin is actually relying on — is where a cache either earns your trust or becomes something nobody wants to turn on.

## The Four Questions, In Full

Every request that hits a cache has to answer four questions, in this order. I went through these quickly last time. Here's the real depth each one deserves.

### 1. Is there a stored response for this exact request?

The obvious answer is: hash the URL, look it up. That's wrong. And it's wrong in a sneaky way — it'll pass every test you write, unless you specifically think to test for this.

Here's the problem. HTTP has a response header called `Vary`. Say a client asks for `GET /api/users`. The origin can answer with `Vary: Accept-Encoding` in its response. That header is a promise. It's the origin telling any cache: "my answer depends on the client's `Accept-Encoding` header. Don't give this exact response to a client that sent a different one."

Why would the answer depend on that header? Compression. A client that says `Accept-Encoding: gzip` gets compressed bytes back. A client that says `Accept-Encoding: identity` (or says nothing) gets raw, uncompressed bytes.

So think about what "hash the URL" actually gets you. Same URL. Same method. But two genuinely different response bodies, depending on who's asking. A cache that only keys on the URL grabs whichever one got stored first and hands it to everyone, compressed or not.

Two ways that breaks things:

- A client that can't handle gzip gets gzip'd bytes anyway. Its browser tries to decompress plain text and the response comes out corrupted.
- A client that _can_ handle gzip gets uncompressed bytes instead. Nothing crashes, but you just wasted bandwidth for no reason.

`Accept-Encoding` is the textbook example. It's not the only one, and this next one is sharper: `Vary: Cookie` is real, and it means what it sounds like — the response depends on session state carried in a cookie. If a cache ignores `Vary: Cookie` and treats a URL as one single entry, it will, sooner or later, serve one logged-in user's personal response to a completely different logged-in user who happened to hit the same URL a few seconds later. That's not a rare edge case. It's one of the more common real-world cache-poisoning bugs, and it happens exactly because someone built the naive "just hash the URL" cache.

Here's the part that makes this a real engineering problem, not just "add more fields to the key." `Vary` is part of the _response_. You don't know which headers matter for a URL until you've already gotten a response for that URL. So there's no way around this: the very first request for any URL has to be a cache miss, no matter what. There's no clever trick that skips that. What you _can_ control is everything after that first response — remembering exactly which headers `Vary` named, and using only those headers (never guessing, never adding extra ones) to tell later requests apart.

### 2. If there's a stored response, is it still usable?

`Cache-Control: max-age=60` looks simple. "Cache this for 60 seconds." As a starting mental model, fine. But the real spec has more pieces than that, and they matter.

`s-maxage` is one of them. It exists so an origin can give a _shared_ cache (like this one, or a CDN) a different lifetime than it gives a browser. This isn't some redundant alternate spelling — it's the origin making a real distinction. A browser cache only ever serves one person. A shared cache like Ring serves everyone. So an origin might say: "browsers, cache this for 10 seconds. Shared caches, you can hold onto it for 5 minutes." Ignore `s-maxage` and you'll get it wrong in one direction or the other — either serving fresher data than the origin planned for, straining infrastructure sized for a longer cache window, or serving staler data to way more people than the origin intended.

`no-store` means exactly what it says: never write this anywhere, ever, not even temporarily to help with revalidation later. `private` is a bit softer — it's fine to cache, just not in a _shared_ cache. A browser can hold onto it. Ring can't. If a shared cache treats `private` as cacheable anyway, it will eventually serve one person's private data to someone else.

`must-revalidate` is about what happens the moment freshness runs out. Normally, once something goes stale, this cache can still serve it for a little while (more on that next) while quietly checking in with the origin in the background. `must-revalidate` turns that off for a specific response. Once it expires, ask the origin _first_, before serving anything — no benefit of the doubt, even if the origin is briefly unreachable. This is what an origin sets on things where "close enough" actually costs money: account balances, inventory counts, that kind of thing.

None of this is exotic or over-engineered. Different kinds of responses genuinely need different rules. A cache that flattens all of this down to "check one timestamp" will, sooner or later, do something the origin explicitly told it not to do.

### 3. Can it be served stale while a fresh copy is fetched?

Here's the case for stale-while-revalidate. Without it, every single request that lands right as something goes stale has to wait on a full round trip to the origin before getting anything back. That throws away most of the point of having a cache. Say something has `max-age=60` and it's being hit continuously. The person whose request happens to land at second 61 shouldn't have to eat a full origin round trip just because of bad timing. The response from second 59 is still basically fine. Serve it immediately. Quietly go fetch a fresh copy in the background, so the _next_ person gets something current.

The word that matters most in that description is "bounded." If you don't put a hard limit on how long something can be served stale, this stops being a smart latency trick and starts being a way to accidentally turn off freshness checking entirely. Say the origin goes down for six hours. With no bound, the cache just keeps confidently handing out six-hour-old data with zero indication anything is wrong. Maybe that's actually what you want sometimes — stale beats a 500 page, depending on what you're serving — but that should be a decision someone makes on purpose, not something that happens by accident because nobody put a ceiling on it. That's why this project uses a fixed, cache-side stale window. The origin doesn't get to extend it. More on why in the design-decisions part below.

### 4. If two hundred requests for the same expired resource arrive in the same ten milliseconds, does the origin get hit two hundred times, or once?

This is the question that decides whether your cache helps under normal load and actively hurts under the load pattern that matters most.

Walk through the mechanics slowly. A resource is popular — lots of concurrent requests want it. Its freshness window closes. Every one of those requests checks the cache at almost the same instant, and every one of them sees "expired," because from each request's own point of view, nothing new has been fetched yet. With no coordination between them, every single one decides, independently, "I need to go get this from origin." And they all do it. At once.

Think about what that means. The exact moment your cache should be working hardest to protect the origin — a sudden spike in demand for one thing — is the exact moment an uncoordinated cache turns that spike into two hundred simultaneous hits on the origin. One event (a resource going stale) turned into two hundred origin requests, because nothing was talking to anything else.

This is called a thundering herd, or a cache stampede. The fix is conceptually simple: the first request that notices the miss goes and fetches it. Everyone else just waits for that same fetch to finish and gets the same result. Simple to describe. There are real, sharp correctness issues in actually building it — I'll walk through two ways to get it wrong further down, because getting the handoff wrong brings the exact race condition back.

## Walking Through an Actual Request

Before any code, here's one request, followed all the way through, with real timestamps. It's easier to hold this as a sequence of events than as four abstract rules.

Say `GET /api/products/42`. Origin answers with `Cache-Control: max-age=60`. This project's fixed stale window is 30 seconds.

| Time                                       | Event                                           | What happens                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t=0s                                       | First request comes in                          | Cache checks, finds nothing for this URL yet. Miss. Goes to fetch from origin — nobody else is fetching this, so it just does it. Response comes back. Freshness gets calculated: fresh until t=60s, stale-but-usable until t=90s. Entry gets stored. Client gets the response, with `Age: 0`.                                                                                   |
| t=5s                                       | Second request, different client, same URL      | Cache checks, finds it, and it's still fresh (5 < 60). Served right away. No origin contact. `Age: 5`.                                                                                                                                                                                                                                                                           |
| t=59.999s, t=60.000s, t=60.001s            | Three requests land right at the boundary       | All three check at nearly the same instant. Some might see fresh, some might see expired — that's fine, it's expected, nothing requires this to be perfectly atomic across three separate observers. Say all three land just past t=60: all three see "stale." Each one gets served the still-cached body immediately — no waiting — and each one triggers a background refresh. |
| t=60.001s                                  | Three background refreshes kick off             | All three go through the same coalescing mechanism, keyed on the same URL. Exactly one of them actually talks to the origin. The other two just wait for that one to finish and use its result. Origin sees one request, not three.                                                                                                                                              |
| t=60.050s                                  | Refresh finishes                                | Origin replies "304, nothing changed," with an updated `max-age=60`. The cache reuses the old body — no need to re-send it — and calculates a new freshness window from now.                                                                                                                                                                                                     |
| t=61s                                      | A fourth request comes in                       | Hits the new entry from the refresh at t=60.050s. Fresh again. Served directly.                                                                                                                                                                                                                                                                                                  |
| t=200s (origin has been down since t=150s) | A request comes in for a now hard-expired entry | The cache checks — this entry is well past even the stale window. Not eligible to be served at all. Falls through to fetching from origin. Origin fails, because it's down. Client gets a `502 Bad Gateway`. The cache does _not_ quietly keep serving day-old data past its own limit. This is the bounded-staleness decision from Question 3, actually happening.              |

That table is the whole system, mechanically. Everything from here on is either the code that makes each row true, or the reasoning for why it's built this way instead of one of the other reasonable-looking ways.

## Design

Four pieces, one job each:

- **`Entry`** — a snapshot of one cached response. Knows its own freshness and staleness boundaries.
- **`Store`** — a size-limited LRU cache, keyed with the two-level Vary-aware scheme, with query parameters normalized.
- **`Flight`** — the piece that coalesces concurrent fetches into one.
- **`Proxy`** — the actual `http.Handler` that wires the three above into the request path from the table.

No external dependencies. Standard library only. This matters because this piece has to be correct before anything else gets built on top of it. Every dependency is one more thing that could have its own bug, or change behavior under you, that you didn't fully check.

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

The one decision this whole type is built around is that it never changes once created. Worth defending, not just stating.

Picture the alternative. `Entry` fields are mutable, and there's a `sync.RWMutex` sitting on the struct. When a revalidation finishes, it takes the write lock and updates `Body`, `FreshUntil`, and everything else, in place.

Here's what goes wrong with that. `writeEntry` — writing the response body out to a client — is not instant. `w.Write(e.Body)` can take real time if the body is large or the client's connection is slow, because it's waiting on that specific client's network. If `Entry` were mutable-with-a-lock, that write would need to hold a read lock the whole time it's writing. The alternative — reading `Body` with no lock while a revalidation might be changing it underneath you — is a straight-up data race. Go's race detector will catch it, correctly, if you run your tests with `-race`. And a read lock held by one slow client blocks the write lock a revalidation needs. One slow client can stall a refresh for everyone else hitting that same key.

With immutable entries, that problem just doesn't exist. A revalidation never touches the `Entry` a slow client is currently reading. It builds a brand new `Entry`, and the `Store` swaps in a pointer to it. The slow client keeps reading from the old one, for as long as it needs. Nothing is shared between "serve this to a client" and "refresh this in the background" — they're two different values, one after the other, never the same memory at the same time.

There's a real cost here, worth naming honestly: one extra allocation every time something gets revalidated. For a cache that's refreshing popular keys every so often — not on every single request — that's a handful of allocations a minute per key. Cheap, compared to readers never having to wait on writers.

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

Notice what happens to a directive this parser doesn't recognize: nothing. It's just skipped. That's deliberate. `Cache-Control` was designed to grow over time — real origins send things like `immutable` or `stale-if-error` that this parser has no case for. If unknown directives caused an error, this cache would break the first time an origin's team shipped a header this code hadn't been updated for. Ignoring what you don't understand is the right move here, specifically because this header was built to be safely ignorable. That's not a general rule for parsing — most of the time an unrecognized input should be an error — it's specific to this header.

One more thing worth pointing out: `parseCacheControl` doesn't care if the header came from a request or a response. Same function, either direction. That's on purpose — the two sides genuinely share vocabulary (`no-cache`, `no-store`, `max-age` show up on both). Where the _meaning_ changes depending on direction — a request's `no-cache` means "double check with origin before giving me anything," a response's `no-cache` means "store this, but never hand it out without checking first" — that difference gets handled by whoever calls this function, not inside it. `ServeHTTP` reads a request's `noCache` one way. `freshnessWindow` reads a response's `noCache` a different way. Same field. Two meanings, depending on who's asking.

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

Walk through the order of these checks once, because that order is basically the whole function. `sMaxAge` wins over `maxAge` when it's set — the shared-cache-specific number takes priority, exactly like Question 2 above. Then `noCache` overrides whatever we just landed on and forces it to zero — meaning the response still gets stored (useful for the ETag trick later), but it's never handed out without checking with the origin first. And if nothing was specified at all, we default to zero, not to some guessed "reasonable" TTL.

That last part is a real choice. A response with no freshness info gets treated as immediately stale, not as "cache it for a while and hope for the best." There's a real technique called heuristic freshness — guessing a TTL from a `Last-Modified` date when nothing explicit is given — and it's spec'd, and this project doesn't do it, on purpose. Guessing wrong in the "cached too long" direction is exactly the silent-staleness problem this whole post keeps coming back to. Making origins be explicit is the safer default. If they didn't say, we don't cache — that way we never guess wrong.

`mustRevalidate` collapsing `staleUntil` down to equal `freshUntil` is the entire implementation of "no stale-serving for this thing, ever." One line. That's the origin opting something specific — account balances, inventory, anything where "close enough" costs real money — out of the grace period completely.

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

This one's a good story, honestly. I got this wrong in the first version of this post and only noticed it going back over things for this rewrite. And that's actually the interesting part: this exact kind of bug doesn't announce itself. It doesn't panic. It doesn't throw an error. It doesn't show up if you manually test by typing the same URL twice — you'll naturally type the query params in the same order both times.

Where it shows up: weeks later, as an unexplained low hit rate, and only on the specific endpoints where some client library happens to build its query string from something unordered, like a map. The fix is nine lines of sorting. Noticing you needed it is the actual work.

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

Two choices in this small function, and both are load-bearing, not decoration.

First: hashing, instead of just gluing the raw header values together for the key. Header values come from the client — they're not something we control. A client can set `Accept-Encoding` or `Cookie` to basically anything, any length. If we used those values directly as part of a key, a client could stuff huge garbage into a header and directly control how much memory our key space eats. Hashing everything down to a fixed 16 bytes closes that off completely, no matter what headers an origin decides to vary on.

Second: that `\x00` byte between each header name and value. Not random — it's there to stop a specific kind of collision. Without some clear separator, two totally different header combinations could, in theory, glue together into the exact same string before hashing. A NUL byte can't legally appear in an HTTP header value, so using it as the separator makes the encoding unambiguous — there's exactly one way to have produced any given string. Same basic idea as why you don't build SQL queries by gluing strings together: pick a separator the untrusted input literally cannot contain.

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

Three maps, one list. `items` is the actual LRU — a map from key to list element, list is ordered by how recently things were used. `varyIndex` is what makes the two-level key thing from earlier actually work: URL to the vary header names we learned about it. `variants` is what makes purging correct: URL to the _set_ of every key that URL has ever produced.

Quick note on why a linked list, not a slice. An LRU needs two things to be fast: "move this to the front" (on every hit) and "remove whatever's at the back" (on eviction). Both need to be instant, no matter how big the cache is — otherwise the cache gets slower the more you use it, which defeats the point. A slice can't move something to the front without shifting everything before it — slow, and gets slower as the slice grows. A doubly linked list can do both instantly, as long as you already have a pointer to the thing you're moving. That's exactly what the `items` map gives you: a fast way to go from "key" to "the actual node in the list." The map finds things. The list keeps them ordered. Neither one alone solves the problem.

And why LRU specifically, not something fancier like LFU (least-frequently-used)? LFU means tracking a count per entry, and finding the smallest count when you need to evict — either by scanning everything (slow) or keeping a second structure just for that (real added complexity, updated on every single access). LFU also has its own known problem: something that was extremely popular yesterday and completely dead today can stick around way longer than it should, just because its count is still high. LRU's bet is simpler: something used recently is probably going to be used again soon. That holds up well for the kind of traffic an HTTP cache actually sees, and it's much cheaper to implement correctly.

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

You'd think `RWMutex` is the obvious choice here. This is a read-heavy structure — most calls are `Get`, not `Set` — and `RWMutex` exists exactly for that: many reads at once, writers get exclusive access. So why not use it?

Because `Get` isn't really "just reading," even on a hit. Every time it finds something, it calls `MoveToFront`, which physically moves that node in the linked list. That's a write to the list's internal structure — even though from the caller's point of view, they're just fetching a cached value.

If `Store` used `RWMutex` and `Get` took a read lock, then two different goroutines could both call `Get` at the same time (allowed, under a read lock) and both try to rearrange the same list at the same moment. That's a genuine data race on the list's internal pointers. Not "returns the wrong answer" — actually corrupts the list. Could form a loop, could silently lose entries. Go's race detector will catch this, but only if you actually run your tests with `-race`, which is exactly why you should, always, for anything like this.

The fix isn't "give the map a `RWMutex` and give the list its own separate lock." That just creates a new problem: now you have two locks, and you need to think carefully about which order to take them in, and what happens if two goroutines grab them in opposite order. That's real added complexity for barely any benefit, on a code path that's already just a few map and list operations. One plain `Mutex`, covering everything, keeps the whole thing simple and obviously correct: nothing can ever observe the map, the list, and the vary index in an inconsistent state relative to each other, because only one goroutine is ever touching any of them at a time. If this lock ever actually becomes a bottleneck under real load, the standard fix is splitting into several independent stores, each with its own lock, and routing keys to one of them by hash. Not switching lock types.

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

Eviction happens right there, inline, every single time `Set` pushes the store over its size limit. Not on a timer. Not in some background goroutine sweeping through periodically. Worth being honest about both sides of that choice.

The upside: at any moment, from any goroutine's point of view, the store's memory usage never exceeds the limit by more than one entry's worth. There's no window where things have gone over budget because a background cleanup job hasn't gotten around to it yet. If this is running in a container with a hard memory limit, that guarantee actually matters — "the cleanup job is running a bit behind" is exactly the kind of thing that turns into an out-of-memory kill at the worst possible time.

The cost: if a `Set` call needs to evict a bunch of entries at once, it pays for all of that right there, making that one call slower. That's an acceptable trade, because `Set` was never the hot path to begin with — `Get` is, and `Get` never evicts anything. "Occasionally slower writes" is a much better problem to have than "memory usage that quietly creeps past the limit."

Quick word on `variants`, and why it's not just duplicate bookkeeping. `secondaryKey` is a one-way hash. Given a stored key, there's no way to compute which URL it came from — that's what "one-way" means. So when you need to purge every version of a URL (the gzip'd copy, the plain copy, whatever else `Vary` might have produced), you can't figure that out by looking at the hashed keys. It's not slow to do that — it's actually impossible, the information just isn't there anymore. `variants` exists specifically to remember that relationship on the side, updated every time something gets stored, so you never need to reconstruct something that the hash already threw away.

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

Think about what a `PURGE /some/path` request actually means. Someone names one URL. They don't know, and shouldn't have to know, how many different Vary-based versions of that URL exist underneath it. `DeleteAllVariants` only has to walk through `variants[primary]` — the exact set of keys for this one URL, nothing more. That means a purge is just as fast whether your cache has 500 entries or 5 million. Without `variants`, you'd have no choice but to scan every single entry in the whole store to find the ones that match — fine at 500, genuinely a problem at 5 million.

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

Best way to understand why this looks the way it does is to look at two more obvious designs, and see exactly where each one breaks.

**Attempt one: a lock per key, held the whole time you're fetching.**

```go
// DOES NOT actually coalesce — shown to explain why, not as usable code.
func (f *Flight) Do(key string, fn func() (*Entry, error)) (*Entry, error) {
	lock := f.lockFor(key) // some per-key mutex
	lock.Lock()
	defer lock.Unlock()
	return fn()
}
```

Looks reasonable at first glance. Only one goroutine can hold `lock` at a time, so `fn` only ever runs one at a time, per key. But "one at a time" and "runs once, and everyone shares that result" are two completely different claims. Here, every single goroutine still calls `fn` for itself — they just take turns doing it, one after another, instead of all doing it simultaneously. Two hundred requests for the same key still means two hundred fetches from origin. They're just sequential now instead of concurrent, which is actually worse for the two-hundredth request — it now waits behind 199 other fetches finishing first — while doing absolutely nothing to reduce load on the origin. This isn't solving the problem at hand. It's solving a different problem (don't let two things write to the same resource at once), which isn't what we needed here.

**Attempt two: check if something's in flight, then fetch, with nothing tying those two steps together.**

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

This is a classic check-then-act bug — same family as an unlocked "if it doesn't exist, create it." Look at the gap between `f.mu.Unlock()` right after the check, and whatever "wait somehow" ends up being. In that gap, a second goroutine can run the exact same check, also find nothing registered, and also go ahead and call `fn()`. The problem is that checking "is something in flight" and registering "something is now in flight" need to happen as one atomic step. If they're split into two separately-locked pieces, even for a moment, two goroutines can both believe they're the first one there.

The real `Do` avoids this by holding the lock across both the check _and_ the registration together, as one step, and only releasing the lock after that's fully done. Then it explicitly lets go of the lock _before_ calling `fn` — because the actual fetch might be slow, and there's no reason for a slow fetch on one key to block every unrelated key from making progress.

One more detail worth being exact about: the entry gets removed from the map _after_ `wg.Done()`, never before.

```go
c.val, c.err = fn()
c.wg.Done()          // <-- unblocks every waiter

f.mu.Lock()
delete(f.calls, key)  // <-- only now does the map forget this call happened
f.mu.Unlock()
```

Say you flipped that order — deleted from the map first, then called `Done()`. There'd be a small window where the call isn't marked as "in flight" anymore, but it also hasn't actually finished. If a new request showed up in exactly that window, it would correctly see nothing in the map, correctly conclude nothing's in flight — and go start a completely redundant second fetch. Exactly what this whole thing was supposed to prevent. Doing `Done()` first closes that window entirely. By the time a key disappears from the map, everyone who was ever waiting on it has already gotten their answer.

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

The first version of this post only looked at the _response's_ `Cache-Control` header. That's only half the picture. A request can carry `Cache-Control: no-cache` too — this is literally what happens when you hard-refresh a browser (Ctrl+Shift+R). It means something specific: "even if you think you have something fresh, don't trust it, go check with the origin first." The client is overriding the cache's own judgment, just for this one request. Miss this, and a user's hard-refresh does nothing different from a regular refresh, which is a real bug someone will actually notice.

`writeEntry` now takes `now` as a parameter, instead of grabbing the current time itself:

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

Small function, but it's doing something easy to skip and genuinely worth not skipping. `Age` is a required header for a shared cache under the HTTP spec, and it's not just a formality. It's how everything downstream of this cache stays correct about what this cache is doing. Say a browser sits behind Ring, and Ring sends back a response with `max-age=60` but no `Age` header. The browser has no way of knowing that response might already be 45 seconds old from Ring's point of view. It'll reasonably assume it's brand new, and cache it for another full 60 seconds on top of that — so what the origin meant as a 60-second window quietly turns into 105 seconds. `Age` fixes that: the browser sees it, and shortens its own freshness window accordingly.

And passing `now` in explicitly, instead of each function grabbing the time on its own, means the decision "is this fresh" and the number we write into `Age` both come from the exact same instant. Two separate calls to get the current time, a few microseconds apart, would be a tiny but real inconsistency between what we decided and what we told the client.

## Concurrency Correctness, Argued Directly

I want to actually state the claim about `Store`, and argue it, instead of just saying "it's thread-safe, trust me."

**The claim:** no matter how many `Get`, `Set`, `Delete`, and `DeleteAllVariants` calls happen at the same time, from as many goroutines as you want, the end result is always the same as if they'd happened one at a time, in _some_ order. Nobody ever sees a half-finished state.

**Why that's true:** every single method that touches the list, the items map, the vary index, or the variants map grabs `s.mu` first, and holds it for the entire operation — nothing gets released until everything's back in a consistent state. Go's `Mutex` guarantees mutual exclusion: when one goroutine unlocks it, that unlock happens-before the next goroutine's lock succeeds. That means two of these operations can never actually overlap in time. Every call runs as if it's the only thing happening, seeing exactly whatever the previous call left behind. That's the whole argument. Nothing fancy — just, everything that touches shared state does so one at a time, always, no exceptions.

The one place this needs actual care, not just a shrug: every single line that touches those four structures has to be inside a locked section. No exceptions, not even one field. Look through `Get`, `Set`, `Delete`, `DeleteAllVariants`, and the two helper functions ending in "Locked" — those names are a deliberate signal that says "the caller must already be holding the lock." Go doesn't have a way to enforce that at compile time. It's just a naming convention, and it only works if every single call site actually respects it. That's exactly why all of this logic lives in one file, `store.go`, instead of being spread out where someone three files away might not know the convention exists.

## Benchmarks: Making the Coalescing Claim Measurable

Saying something is fast without numbers is just an opinion. Here's the actual benchmark, and how to read it correctly.

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

What this actually measures is the real claim, made concrete: 100 concurrent requests, same key, one origin call. Not "should be fast" — an actual number, one you could put in front of someone and defend, instead of just trusting your own code because you're the one who wrote it.

There's also a pair of wall-clock benchmarks in the same file (`WithoutCoalescing` vs `WithCoalescing`), and they're worth running, but read them carefully — I flagged this directly in the benchmark's own comment because it's a real gotcha. Since all 100 fake origin calls in the uncoalesced version are just goroutines sleeping at the same time, the _wall-clock time_ for that benchmark ends up being roughly the same either way, around 10ms. The actual damage from missing coalescing doesn't show up as slower wall-clock time in this benchmark — it shows up as 100 real network calls hitting a real origin, instead of 1. A fake origin that's just `time.Sleep` can't show you that. That's exactly why `OriginCallCount` exists as its own separate benchmark: wall-clock speed and origin load are two different questions, and mixing them up would give you a benchmark suite that looks reassuring while completely missing the point.

## What Production Adds Beyond This

This is a complete, correct, single-node cache. Not a sketch with pieces missing. But there's real distance between this and something you'd point a huge amount of production traffic at without touching it further, and it's worth being honest about that gap instead of glossing over it.

**Trusting the Host header.** This proxy trusts whatever the request's routing already decided. It doesn't independently double-check that a request claiming to be for one origin is actually meant for it. If the load balancer in front of this cache doesn't strictly validate the `Host` header before routing, someone could, in theory, trick this cache into storing a response under the wrong key entirely. That's a real, documented category of attack. Fully closing this off is really an infrastructure-level guarantee — something the deployment has to get right — not something `cache/` alone can fix.

**Caching error responses.** Right now, this deliberately never caches anything other than a 2xx. That's the safer default. But it means a URL that legitimately, correctly 404s gets hit with the full uncached origin round trip, every single time, forever. Someone could lean on that on purpose, hammering known-missing URLs just to generate load. A production version would probably want a short, deliberately capped negative cache specifically for 404s, with its own separate TTL — not reusing the same freshness logic as everything else.

**Visibility into what's actually happening.** There's no way right now to see which keys are hot, which are cold, or what the real hit rate looks like broken down by endpoint. That's not a correctness problem, but it's the kind of gap that turns a small production issue into a long, confusing one. "The cache seems slow" is a much worse starting point for debugging than "the hit rate on `/api/search` specifically dropped at 14:02."

None of these are needed for what Part 1 is claiming to be: a correct, tested, single-node cache. This is just the honest list of what "correct on one node" doesn't cover yet — and it's the right list to have written down before Part 2 adds a second node, and every one of these considerations gets multiplied by however many nodes end up in the cluster.

## What's Next

Right now, this node has no idea any other node exists. `HandlePurge` clears exactly the node it hits, and only that node — real, complete as written, but strictly local. If you ran two Ring nodes today, in front of the same origin, they'd each quietly build up their own separate cache, with zero way to tell each other "hey, this changed." That's a real gap for anything that's supposed to be distributed.

That gap is on purpose, not something I forgot. Everything in this post — the two-level Vary-aware keys, the LRU with an actual correctness argument behind it, the singleflight coalescer with two documented near-misses — needed to be solid and testable on its own, before a second node enters the picture at all. Trying to debug a gossip protocol and a caching bug at the same time, on the same running system, with no way to tell which one is actually misbehaving, is a genuinely bad time.

Part 2 is what makes a second node aware the first one even exists: SWIM, the failure-detection protocol behind how Consul and Cassandra track membership. It answers "who's alive right now," with no central coordinator, and without every node having to ping every other node on every round.

## Repository

Full source, including every test and benchmark mentioned in this post, is in the `ring/` module: `cache/entry.go`, `cache/freshness.go`, `cache/key.go`, `cache/store.go`, `cache/singleflight.go`, `cache/proxy.go`, tests alongside each one, and a runnable reverse proxy in `cmd/ring/main.go`. Run the whole suite with `go test ./... -race` before going further — `-race` specifically, since a good chunk of this post's correctness argument rests on concurrent access actually working the way it's described.
