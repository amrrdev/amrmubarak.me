---
title: "Building a Load Balancer in Go, Part 2: Health Checks"
date: "2026-5-2"
readTime: "15 min read"
category: "System Design"
---

## Where We Left Off

In Part 1 we built a reverse proxy that distributes requests across three backends using round robin. It works — but it is blind. Kill one of the backends and the load balancer keeps sending traffic to it, returning 502 to every third client until the backend comes back.

A production load balancer needs to know which backends are alive and route around the ones that are not. That is what this post builds: **active health checking**.

The HTTP ping itself is trivial. The interesting problem is the concurrency it introduces — a background goroutine writing backend state while request handler goroutines read it simultaneously. Getting that wrong is a data race. Getting it right requires understanding exactly what Go's memory model guarantees and when atomics are sufficient.

---

## What Active Health Checking Means

There are two approaches to knowing whether a backend is healthy.

**Passive health checking** infers health from real traffic. If a backend returns errors on three consecutive requests, mark it down. The problem: real users absorb the failures before you react. The first N requests to a dead backend all fail before the load balancer notices.

**Active health checking** probes backends independently of real traffic. A background goroutine sends a synthetic request — typically `GET /health` — to each backend on a fixed interval. If the backend responds with 200, it is up. If it times out or errors, it is down. Real traffic never hits a backend the health checker has marked down.

We are building active health checking. The tradeoff: you pay for it with background network traffic — N backends × checks per second. For most workloads this is negligible.

```
Every 10 seconds:
  Health checker → GET /health → Backend A → 200 OK    → mark UP
  Health checker → GET /health → Backend B → timeout   → mark DOWN
  Health checker → GET /health → Backend C → 200 OK    → mark UP

Incoming request:
  Round robin picks Backend B → it is DOWN → skip → pick Backend C
```

---

## The Concurrency Problem

In Part 1, `Backend` had two fields: `URL` and `Proxy`. Both are written once at startup and never changed. No concurrency issue.

Now we need a third field: whether the backend is currently alive. This field is:

- **Written** by the health checker goroutine, periodically
- **Read** by every request handler goroutine, on every request

Multiple goroutines accessing the same memory location, at least one writing — this is the definition of a **data race** in Go. The Go memory model does not guarantee that a write in one goroutine is visible to reads in another goroutine unless there is an explicit synchronization point between them.

Without synchronization, a request handler goroutine could read a stale value — it might see `alive = true` for a backend the health checker marked down a millisecond ago. Worse, in theory, without synchronization the compiler and CPU are free to reorder operations, and what you get is undefined behavior.

Two tools can fix this: a **mutex** or an **atomic**.

A mutex wraps the read and write in a critical section — only one goroutine can be inside at a time. It is flexible: it can protect arbitrarily complex operations. The cost is overhead from lock acquisition and the risk of holding the lock too long.

An **atomic** is a single CPU instruction that reads or writes a value with guaranteed visibility across all cores. No lock, no overhead. The constraint: it only works for simple types — integers, booleans, pointers. You cannot atomically update a struct.

For a single boolean — alive or not — an atomic is exactly the right tool. `sync/atomic` provides `atomic.Bool` since Go 1.19: a boolean with `Load()` and `Store()` methods that are both goroutine-safe and guaranteed to be immediately visible across goroutines.

```go
var alive atomic.Bool

// Health checker goroutine:
alive.Store(false)  // guaranteed visible to all goroutines immediately

// Request handler goroutine:
if alive.Load() {   // always sees the latest value
    // forward request
}
```

No mutex. No channel. One atomic boolean per backend.

---

## Updating the Backend

Add `alive atomic.Bool` to the `Backend` struct and methods to read and set it.

```go
// load-balancer/balancer/backend.go

package balancer

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
)

// Backend represents a single upstream server.
type Backend struct {
	URL   *url.URL
	Proxy *httputil.ReverseProxy
	alive atomic.Bool // written by health checker, read by request handlers
}

// IsAlive returns whether this backend is currently healthy.
// Safe to call from multiple goroutines concurrently.
func (b *Backend) IsAlive() bool {
	return b.alive.Load()
}

// SetAlive marks this backend as up or down.
// Called exclusively by the health checker.
func (b *Backend) SetAlive(alive bool) {
	b.alive.Store(alive)
}

// NewBackend creates a Backend from a raw URL string.
// Backends start as alive — the health checker will mark them down
// if the first check fails.
func NewBackend(rawURL string) *Backend {
	u, err := url.Parse(rawURL)
	if err != nil {
		panic("invalid backend URL: " + rawURL)
	}

	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.ErrorHandler = errorHandler

	b := &Backend{URL: u, Proxy: proxy}
	b.alive.Store(true) // optimistic default
	return b
}

func errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("backend error: host=%s path=%s err=%v", r.URL.Host, r.URL.Path, err)
	http.Error(w, "Bad Gateway", http.StatusBadGateway)
}
```

One decision worth explaining: backends start as `alive = true`. The alternative is starting them as `alive = false` and waiting for the first health check before they receive traffic. That would delay startup by one check interval — 10 seconds if you check every 10 seconds. Optimistic startup is the standard choice; if a backend is actually dead, the first check will mark it down within one interval.

---

## The Health Checker

The health checker is a struct that owns the check logic and the goroutine that drives it.

```go
// load-balancer/balancer/healthcheck.go

package balancer

import (
	"context"
	"log"
	"net/http"
	"time"
)

// HealthChecker runs periodic health checks against all backends.
type HealthChecker struct {
	backends []*Backend
	interval time.Duration
	timeout  time.Duration
}

// NewHealthChecker creates a HealthChecker.
//
// interval: how often to check each backend. 10s is a reasonable default.
// timeout:  how long to wait for a backend to respond. Keep this well below
//           interval — if timeout >= interval, checks pile up.
func NewHealthChecker(backends []*Backend, interval, timeout time.Duration) *HealthChecker {
	return &HealthChecker{
		backends: backends,
		interval: interval,
		timeout:  timeout,
	}
}

// Start launches the health check loop in a background goroutine.
// It runs until ctx is cancelled — pass the load balancer's root context
// so health checks stop when the load balancer shuts down.
func (hc *HealthChecker) Start(ctx context.Context) {
	go hc.run(ctx)
}

// run is the background goroutine. It checks all backends immediately on
// startup, then waits for the ticker before checking again.
func (hc *HealthChecker) run(ctx context.Context) {
	// Check immediately so we do not wait a full interval before the first
	// health status is known.
	hc.checkAll()

	ticker := time.NewTicker(hc.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			hc.checkAll()
		case <-ctx.Done():
			log.Println("health checker stopped")
			return
		}
	}
}

// checkAll runs a health check against every backend concurrently.
// Checking them sequentially would mean a slow or dead backend delays
// checks for all subsequent backends.
func (hc *HealthChecker) checkAll() {
	for _, b := range hc.backends {
		go hc.checkOne(b)
	}
}

// checkOne sends a single health check request to a backend and updates
// its alive status based on the response.
func (hc *HealthChecker) checkOne(b *Backend) {
	ctx, cancel := context.WithTimeout(context.Background(), hc.timeout)
	defer cancel()

	url := b.URL.String() + "/health"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		b.SetAlive(false)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Connection refused, timeout, DNS failure — backend is down.
		if b.IsAlive() {
			log.Printf("backend DOWN: %s (%v)", b.URL, err)
		}
		b.SetAlive(false)
		return
	}
	resp.Body.Close()

	// Any 2xx response means the backend is healthy.
	// Some teams use 200 only — we accept the full 2xx range.
	alive := resp.StatusCode >= 200 && resp.StatusCode < 300
	if !alive && b.IsAlive() {
		log.Printf("backend DOWN: %s (status %d)", b.URL, resp.StatusCode)
	}
	if alive && !b.IsAlive() {
		log.Printf("backend UP: %s", b.URL)
	}
	b.SetAlive(alive)
}
```

Three design decisions here worth understanding.

**`time.Ticker` not `time.Sleep`.**
The naive approach to a periodic task is `time.Sleep(interval)` in a loop. The problem: `Sleep` measures wall time from when the previous check _finished_. If a check takes 3 seconds and your interval is 10 seconds, checks run every 13 seconds. `time.Ticker` fires on a fixed wall-clock schedule regardless of how long the previous check took — checks run every 10 seconds as configured. Always use `Ticker` for periodic tasks.

**Concurrent checks with `go hc.checkOne(b)`.**
`checkAll` spawns a goroutine per backend instead of checking them sequentially. Why? If you have 10 backends and check them one at a time, a backend with a 5-second timeout blocks checks for the remaining 9 backends. Concurrent checks mean all backends are checked within one timeout window, not one timeout window per backend. The goroutines are short-lived and bounded by backend count — spawning them here is fine.

**Log only on state transitions.**
`checkOne` only logs when a backend changes state — UP→DOWN or DOWN→UP. Logging on every check would produce a line every 10 seconds per backend, filling your logs with noise. State transition logging tells you exactly when something broke and when it recovered, which is the information you actually need.

---

## Updating Round Robin to Skip Dead Backends

The current `next()` in the load balancer blindly cycles through all backends. Now it needs to skip backends where `IsAlive()` returns false.

The naive fix is to keep incrementing until we find a live backend:

```go
// naive — do not use this
func (lb *LoadBalancer) next() *Backend {
    for {
        idx := lb.counter.Add(1) % uint64(len(lb.backends))
        if lb.backends[idx].IsAlive() {
            return lb.backends[idx]
        }
    }
}
```

This has a critical bug: if **all backends are down**, it loops forever, pinning a goroutine indefinitely for every incoming request. The server appears to hang.

The fix is to bound the search. We check each backend at most once. If we complete a full rotation without finding a live backend, we return `nil` and let the caller handle it.

```go
// load-balancer/balancer/balancer.go

package balancer

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// LoadBalancer distributes incoming requests across a pool of backends
// using round robin, skipping backends marked as down.
type LoadBalancer struct {
	backends      []*Backend
	counter       atomic.Uint64
	healthChecker *HealthChecker
}

// New creates a LoadBalancer and wires up health checking.
func New(backends []*Backend, checkInterval, checkTimeout time.Duration) (*LoadBalancer, error) {
	if len(backends) == 0 {
		return nil, fmt.Errorf("at least one backend is required")
	}
	return &LoadBalancer{
		backends:      backends,
		healthChecker: NewHealthChecker(backends, checkInterval, checkTimeout),
	}, nil
}

// Start launches the health checker. Call this before serving requests.
func (lb *LoadBalancer) Start(ctx context.Context) {
	lb.healthChecker.Start(ctx)
}

// next returns the next alive backend using round robin.
// It searches at most len(backends) candidates before giving up.
// Returns nil if no backends are currently alive.
func (lb *LoadBalancer) next() *Backend {
	total := uint64(len(lb.backends))

	for range lb.backends {
		idx := lb.counter.Add(1) % total
		b := lb.backends[idx]
		if b.IsAlive() {
			return b
		}
	}

	return nil // all backends are down
}

// ServeHTTP implements http.Handler.
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	backend := lb.next()
	if backend == nil {
		http.Error(w, "Service Unavailable — no healthy backends", http.StatusServiceUnavailable)
		return
	}
	backend.Proxy.ServeHTTP(w, r)
}
```

The `for range lb.backends` loop iterates exactly `len(backends)` times — one full rotation. If no alive backend is found in that rotation, we return `nil`. `ServeHTTP` translates `nil` into a clean 503 Service Unavailable, which is the correct HTTP status when a server is up but cannot fulfil the request due to upstream unavailability.

503 vs 502: 502 Bad Gateway means we tried a backend and it failed. 503 Service Unavailable means we did not even try — we knew ahead of time there was nobody to forward to. The distinction matters for clients that handle these differently.

---

## Wiring It Up

Update `main.go` to pass health check configuration and start the checker.

```go
// load-balancer/main.go

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/amrrdev/load-balancer/balancer"
)

func main() {
	backends := []*balancer.Backend{
		balancer.NewBackend("http://localhost:8081"),
		balancer.NewBackend("http://localhost:8082"),
		balancer.NewBackend("http://localhost:8083"),
	}

	lb, err := balancer.New(backends, 10*time.Second, 3*time.Second)
	if err != nil {
		log.Fatal(err)
	}

	// Root context — cancelling this stops the health checker.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	lb.Start(ctx)

	server := &http.Server{
		Addr:    ":8080",
		Handler: lb,
	}

	// Shut down cleanly on SIGTERM or SIGINT (Ctrl+C).
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		log.Println("shutting down...")
		cancel() // stop health checker
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		server.Shutdown(shutdownCtx)
	}()

	log.Println("load balancer listening on :8080")
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
```

The context flows from `main` into the health checker. When the OS sends SIGTERM (standard shutdown signal from Docker, Kubernetes, systemd), `cancel()` fires, `ctx.Done()` closes in the health checker's `run` goroutine, and it exits cleanly. Then `server.Shutdown` waits for in-flight requests to finish before the process exits.

This is the right shutdown sequence for any Go HTTP server. We will expand on it significantly in Post 4 (connection draining).

---

## Update the Test Backend to Expose `/health`

The health checker calls `GET /health`. The test backends need to handle it.

```go
// load-balancer/cmd/backend/main.go

package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Args[1]

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "response from backend :%s\n", port)
	})

	// Health check endpoint — the load balancer pings this.
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	log.Printf("backend listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

---

## Seeing It Work

Start everything:

```bash
go run cmd/backend/main.go 8081
go run cmd/backend/main.go 8082
go run cmd/backend/main.go 8083
go run main.go
```

You will see the initial health checks fire immediately:

```
2024/03/10 12:00:00 load balancer listening on :8080
2024/03/10 12:00:00 health checker: all backends UP
```

Now kill one of the backends (Ctrl+C on the 8082 terminal). Within the check interval you will see:

```
2024/03/10 12:00:10 backend DOWN: http://localhost:8082 (connection refused)
```

Send requests — they all go to 8081 and 8083, never 8082:

```bash
curl http://localhost:8080  # response from backend :8081
curl http://localhost:8080  # response from backend :8083
curl http://localhost:8080  # response from backend :8081
curl http://localhost:8080  # response from backend :8083
```

Restart the 8082 backend. Within one check interval:

```
2024/03/10 12:00:20 backend UP: http://localhost:8082
```

Traffic resumes flowing to all three backends. No restart required, no manual intervention.

Kill all three backends and send a request:

```bash
curl -i http://localhost:8080
# HTTP/1.1 503 Service Unavailable
# Service Unavailable — no healthy backends
```

Clean 503, not a hang.

---

## The Tradeoffs We Made

**`/health` endpoint convention.** We call `GET /health` on each backend. This is convention, not protocol. Some teams use `/healthz`, `/ping`, or `/ready`. The path should be configurable — hardcoding it here is fine for a series but something to fix before production use.

**`http.DefaultClient` for health checks.** We use the default HTTP client rather than a custom one. The default client has no timeout by default — which is why we pass a context with timeout to each request. A more complete implementation would configure a custom `http.Transport` with `DialContext` timeout, `TLSHandshakeTimeout`, and `ResponseHeaderTimeout` set explicitly. For now, the context timeout is sufficient.

**Optimistic startup vs pessimistic.** Backends start as alive and get marked down on the first failed check. The alternative — starting as dead and waiting for a passing check — adds a startup delay equal to one check interval. Optimistic startup is the standard approach in production load balancers (Nginx, HAProxy, Envoy all do this). If a backend is misconfigured and actually dead, it gets marked down within one interval anyway.

**No consecutive failure threshold.** We mark a backend down on the first failed check. Production health checkers typically require N consecutive failures before marking a backend down, to avoid flapping — a backend that fails one check due to a momentary blip getting yanked from rotation and then restored on the next check, causing oscillation. Adding a failure counter is a straightforward extension: add `consecutiveFails atomic.Int32` to `Backend`, increment on failure, reset on success, and only call `SetAlive(false)` when it crosses a threshold.

---

## What's Next

We now have a load balancer that routes around dead backends automatically. But round robin has a fundamental flaw: it assumes all requests are equal. A request that returns in 5ms and a request that takes 2 seconds both consume one slot in the rotation. If Backend A is slow, round robin keeps sending it a third of the traffic even as it falls behind.

**Post 3** replaces round robin with **least connections** — always send the next request to the backend with the fewest active connections. This requires tracking in-flight request counts per backend (another atomic), and the algorithm becomes slightly more complex. The payoff: significantly better latency distribution under variable backend response times.

---

## Conclusion

Health checking is a concurrency problem dressed up as a networking problem. The HTTP ping is three lines. The interesting work is making sure the health checker's writes are visible to the request handlers' reads — and `atomic.Bool` is exactly the right primitive for that.

The pattern here — a background goroutine writing shared state, request handlers reading it, atomics as the synchronization layer — shows up constantly in backend systems. Connection pool health, circuit breakers, feature flags, rate limit counters. Learn this pattern once and you will recognize it everywhere.

The full code is on [GitHub](https://github.com/amrrdev/load-balancer).
