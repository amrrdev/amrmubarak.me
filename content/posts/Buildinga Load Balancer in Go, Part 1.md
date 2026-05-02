---
title: "Building a Load Balancer in Go, Part 1: Reverse Proxy and Round Robin"
date: "2026-5-2"
readTime: "15 min read"
category: "System Design"
---

## Introduction

You have three backend servers. Each one can handle 1,000 requests per second. Together they can handle 3,000 — but only if requests are spread evenly across all three.

Something has to sit in front of them and distribute the traffic. That something is a load balancer.

This is the first post in a series where we build a production-grade load balancer in Go from scratch. By the end of this series it will have health checks, multiple balancing algorithms, connection draining, and per-backend observability. Each post delivers a working, runnable increment.

This post covers the foundation: what a reverse proxy actually is at the network level, how HTTP proxying works in Go, and how to implement round robin distribution across multiple backends.

---

## What a Load Balancer Actually Is

A load balancer is a **reverse proxy** — a server that sits between clients and backends, forwarding requests on their behalf.

```
Client → Load Balancer → Backend A
                       → Backend B
                       → Backend C
```

The client talks to one address. The load balancer receives the request, picks a backend, forwards the request to it, waits for the response, and sends it back to the client. From the client's perspective, it is talking to a single server. The distribution is invisible.

This is different from a **forward proxy**, which sits in front of the client and acts on its behalf — a VPN or a corporate HTTP proxy are forward proxies. The load balancer is a reverse proxy because it acts on behalf of the servers, not the clients.

Two things happen at the network level when a request is proxied:

1. The load balancer opens a new TCP connection to the backend
2. It copies the original request over that connection, adjusting headers where needed

The key header to adjust is `X-Forwarded-For`. When the backend receives the proxied request, the source IP it sees is the load balancer's IP — not the original client's. `X-Forwarded-For` carries the original client IP so the backend can use it for logging, rate limiting, or geolocation.

Go's standard library has a type that does all of this: `httputil.ReverseProxy`.

---

## `httputil.ReverseProxy`: What It Does and What It Doesn't

`httputil.ReverseProxy` is a struct that implements `http.Handler`. You give it a `Director` function — a callback that receives the outgoing request and modifies it before it is sent to the backend. The proxy handles the actual forwarding, response copying, and header management.

```go
proxy := &httputil.ReverseProxy{
    Director: func(req *http.Request) {
        req.URL.Scheme = "http"
        req.URL.Host = "backend-a:8080"
    },
}
```

When `proxy.ServeHTTP(w, r)` is called, it:

1. Calls `Director(r)` to set the target URL
2. Opens a connection to `req.URL.Host`
3. Sends the modified request
4. Streams the response back to the original client

What it does **not** do: pick the backend. That is our job. `Director` is called once per request, and by the time it is called, we need to have already decided which backend this request goes to. The selection logic — round robin, least connections, weighted — lives outside the proxy, and we inject the result into `Director`.

This separation is clean: `httputil.ReverseProxy` handles the mechanics of HTTP proxying, and we handle the policy of which backend to use.

---

## Defining the Backend

A backend is an upstream server the load balancer can forward requests to. For now it needs two things: its address, and a pre-built reverse proxy pointed at it.

```go
// load-balancer/balancer/backend.go

package balancer

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// Backend represents a single upstream server.
type Backend struct {
	URL   *url.URL
	Proxy *httputil.ReverseProxy
}

// NewBackend creates a Backend from a raw URL string.
// It panics on an invalid URL — backends are configured at startup,
// and a bad URL is a programming error, not a runtime condition.
func NewBackend(rawURL string) *Backend {
	u, err := url.Parse(rawURL)
	if err != nil {
		panic("invalid backend URL: " + rawURL)
	}

	proxy := httputil.NewSingleHostReverseProxy(u)

	return &Backend{
		URL:   u,
		Proxy: proxy,
	}
}
```

`httputil.NewSingleHostReverseProxy` is a convenience constructor that builds a `ReverseProxy` with a `Director` that rewrites the request URL to point at the given host. It handles scheme, host, and path rewriting correctly.

One subtlety: it does not set `X-Forwarded-For` by default in older Go versions. From Go 1.20 onwards, the default `Director` sets it. If you are on an older version, add it manually in a custom `Director`:

```go
proxy := &httputil.ReverseProxy{
    Director: func(req *http.Request) {
        req.URL.Scheme = u.Scheme
        req.URL.Host = u.Host
        req.Header.Set("X-Forwarded-For", req.RemoteAddr)
    },
}
```

---

## Round Robin: The Algorithm

Round robin is the simplest distribution strategy: cycle through the list of backends in order, sending each successive request to the next backend.

```
Request 1 → Backend A
Request 2 → Backend B
Request 3 → Backend C
Request 4 → Backend A  ← wraps around
Request 5 → Backend B
...
```

The implementation is a counter. Each time we need a backend, we increment the counter and take it modulo the number of backends:

```
index = counter % len(backends)
```

The counter grows forever — that is fine, integer overflow wraps around harmlessly for our purposes, and `uint64` at one increment per request would take centuries to overflow.

The problem is concurrency. Multiple goroutines handle requests simultaneously — Go's HTTP server uses one goroutine per connection. If two goroutines read the counter, both increment it, and both write it back, they can write the same value twice. This is a **race condition**, and it means two requests end up on the same backend while another backend is skipped.

```
Goroutine 1 reads counter = 5
Goroutine 2 reads counter = 5   ← both read before either writes
Goroutine 1 writes counter = 6
Goroutine 2 writes counter = 6  ← same value, backend 6%3=0 is picked twice
```

The fix is an **atomic increment**: a single CPU instruction that reads, increments, and writes the counter without any other goroutine being able to interleave. Go exposes this via `sync/atomic`.

```go
import "sync/atomic"

var counter atomic.Uint64

// This is a single atomic operation — no race condition possible
index := counter.Add(1) % uint64(len(backends))
```

`atomic.Uint64.Add` returns the new value after incrementing. We use the returned value, not a separate read — if we read after adding, another goroutine could increment again between the add and the read.

---

## The Load Balancer

Now we have the pieces. The load balancer holds the list of backends and the atomic counter. It implements `http.Handler` so it can be plugged directly into Go's HTTP server.

```go
// load-balancer/balancer/balancer.go

package balancer

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

// LoadBalancer distributes incoming requests across a pool of backends
// using round robin selection.
type LoadBalancer struct {
	backends []*Backend
	counter  atomic.Uint64
}

// New creates a LoadBalancer with the given backends.
// At least one backend is required.
func New(backends []*Backend) (*LoadBalancer, error) {
	if len(backends) == 0 {
		return nil, fmt.Errorf("at least one backend is required")
	}
	return &LoadBalancer{backends: backends}, nil
}

// next picks the next backend using round robin.
// It is safe to call from multiple goroutines concurrently.
func (lb *LoadBalancer) next() *Backend {
	idx := lb.counter.Add(1) % uint64(len(lb.backends))
	return lb.backends[idx]
}

// ServeHTTP implements http.Handler.
// It picks a backend and forwards the request to it.
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	backend := lb.next()
	backend.Proxy.ServeHTTP(w, r)
}
```

That is the entire load balancer: 30 lines. The HTTP server calls `ServeHTTP` for each incoming request. `ServeHTTP` picks a backend atomically and delegates to its proxy. The proxy forwards the request and streams the response back.

The `ServeHTTP` method does not need a mutex, a channel, or any other coordination primitive beyond the atomic counter. This is the right level of synchronization for this problem — we only need to protect the counter, and atomics are cheaper than mutexes for a single integer.

---

## Error Handling: What Happens When a Backend Fails

Right now, if a backend is down, `httputil.ReverseProxy` returns a 502 Bad Gateway to the client. The default error handler logs the error to stderr and writes the status code.

We should customize this. A production proxy needs to control the error response format and log structured errors it can actually act on.

```go
// load-balancer/balancer/backend.go

package balancer

import (
	"log"
	"net/http"
)

// errorHandler is called by the reverse proxy when the backend
// request fails — connection refused, timeout, etc.
// It logs the error and returns a clean 502 to the client.
func errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("backend error: host=%s path=%s err=%v",
		r.URL.Host, r.URL.Path, err)
	http.Error(w, "Bad Gateway", http.StatusBadGateway)
}
```

Wire it into the backend constructor:

```go
func NewBackend(rawURL string) *Backend {
	u, err := url.Parse(rawURL)
	if err != nil {
		panic("invalid backend URL: " + rawURL)
	}

	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.ErrorHandler = errorHandler  // ← plug in our handler

	return &Backend{
		URL:   u,
		Proxy: proxy,
	}
}
```

Now backend failures produce structured log output instead of the default stderr dump, and the client gets a consistent error format.

---

## Putting It All Together

```go
// load-balancer/main.go

package main

import (
	"log"
	"net/http"

	"github.com/amrrdev/load-balancer/balancer"
)

func main() {
	backends := []*balancer.Backend{
		balancer.NewBackend("http://localhost:8081"),
		balancer.NewBackend("http://localhost:8082"),
		balancer.NewBackend("http://localhost:8083"),
	}

	lb, err := balancer.New(backends)
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:    ":8080",
		Handler: lb,
	}

	log.Println("load balancer listening on :8080")
	log.Fatal(server.ListenAndServe())
}
```

To test it locally, spin up three simple echo servers — each one returns its own port so you can see which backend is serving:

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
	log.Printf("backend listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Run all four in separate terminals:

```bash
go run cmd/backend/main.go 8081
go run cmd/backend/main.go 8082
go run cmd/backend/main.go 8083
go run main.go
```

Then send a few requests:

```bash
curl http://localhost:8080  # response from backend :8081
curl http://localhost:8080  # response from backend :8082
curl http://localhost:8080  # response from backend :8083
curl http://localhost:8080  # response from backend :8081 ← wraps around
```

Round robin working correctly.

---

## The Tradeoffs We Made

**`httputil.ReverseProxy` vs raw TCP proxying.** We proxy at the HTTP layer, not the TCP layer. This means we speak HTTP to both the client and the backend — we can read and modify headers, log request paths, and make routing decisions based on HTTP semantics. The cost: we cannot proxy non-HTTP protocols, and there is overhead from HTTP parsing on both sides. An L4 (TCP) load balancer like HAProxy in TCP mode skips this overhead but gives up HTTP visibility. For application-layer load balancing, HTTP proxying is the right choice.

**Atomic counter vs mutex.** We use an atomic increment instead of a mutex around the counter. An atomic operation is a single CPU instruction — it is cheaper than acquiring a mutex, which involves kernel-level coordination if there is contention. For a single integer counter that is incremented on every request, atomics are the correct primitive. If we were protecting a more complex data structure — say, a map of backend weights — a mutex would be appropriate.

**Panic on invalid URL.** `NewBackend` panics rather than returning an error. This is a deliberate choice: backend URLs are configuration, set at startup. A bad URL means the program is misconfigured, and a misconfigured program should not start at all. Panicking at startup is clearer than returning an error that might be swallowed somewhere up the call stack.

**No retry on backend failure.** If the selected backend returns an error, we return 502 to the client immediately. We do not retry on a different backend. Retrying has a real cost: it can cause double-execution of non-idempotent requests (a POST that creates a record being sent twice). The right answer is health checks — remove dead backends from rotation before requests hit them, rather than retrying after they fail. That is Post 2.

---

## What's Missing (And What's Next)

This load balancer has one critical gap: it does not know if a backend is alive. Kill one of the test backends and requests to it will return 502 until the backend comes back. The load balancer keeps sending traffic to it because it has no way to know it is down.

**Post 2** fixes this with active health checking: a background goroutine pings each backend on a configurable interval, marks it up or down, and the round robin algorithm skips backends that are marked down. That is where the interesting concurrency problems start — the health checker and the request handler run concurrently and share backend state, which means we need to think carefully about visibility and atomicity.

---

## Conclusion

A load balancer is a reverse proxy with a selection policy. The proxy mechanics — HTTP forwarding, header rewriting, response streaming — are handled by `httputil.ReverseProxy`. The selection policy — round robin, least connections, weighted — is our code.

The atomic counter is the only concurrency primitive we needed in this post. One integer, one atomic instruction per request, zero mutexes. That is the right level of complexity for the problem.

The full code is on [GitHub](https://github.com/amrrdev/load-balancer).
