---
title: "Edge Computing, Hono, and Building an API Gateway on Cloudflare Workers"
date: "2026-7-15"
readTime: "35 min read"
category: "System Design"
---

## A Note Before We Start

This guide assumes you know what a backend framework is (routing, middleware, request handling) but nothing about edge computing, Cloudflare Workers, V8 isolates, or Hono. Every concept will be explained from the ground up. By the end, you'll have deployed a real API gateway to 300+ locations worldwide.

Let's start with the question that everything else depends on: what actually happens when you run code on the edge?

---

## Part 1: The Edge Model

### What "The Edge" Actually Is

When you deploy a traditional backend, you rent a server in one geographic region. All traffic — from users in New York, Tokyo, London, and Sydney — must travel to that one location. If your server is in `us-east-1`, a user in Tokyo experiences at least 100ms of round-trip latency just from the speed of light, before your application does any work.

The edge flips this model. Instead of one server in one region, there are thousands of servers distributed across the world — inside the networks of ISPs, at the edge of cloud providers, in every major city. When a user makes a request, it's handled by the server physically closest to them.

```
Traditional:
  User in Tokyo ──────────────────────────────► Server in us-east-1
  Round trip: ~150ms before any code runs

Edge:
  User in Tokyo ──► Edge node in Tokyo ──► Origin in us-east-1 (if needed)
  Round trip to edge: ~1ms
  Code runs in Tokyo. Only cache misses go to origin.
```

This is not a theoretical architecture. Cloudflare has 330+ data centers in 120+ countries. AWS has 100+ edge locations through CloudFront. Fastly has 60+. Akamai has 4,000+. When you deploy to Cloudflare Workers, your code is deployed to every one of their 330+ locations simultaneously.

### What "No Server" Actually Means (The Most Important Section)

When people say edge computing has "no server," they don't mean the code runs on nothing. They mean there is **no long-running process that you manage**.

Here's what a traditional Node.js server does, step by step:

```
1. You write: app.listen(3000)
2. Node.js starts a process on your machine (or a VM in the cloud)
3. That process binds to a port (3000) and starts listening for TCP connections
4. The process stays alive indefinitely, waiting for HTTP requests
5. When a request arrives, the same process handles it
6. Variables in memory persist between requests — you can cache data in a global variable
7. If the process crashes, all in-flight requests are lost
8. If traffic increases, you manually or automatically start more processes
```

The process is a long-lived entity. It has state. It has a lifecycle. **You pay for it whether it's handling requests or sitting idle.**

Now here's what happens on Cloudflare Workers:

```
1. You write: export default { async fetch(request) { ... } }
2. There is no app.listen(). You do not bind to a port. You do not start a process.
3. Instead, you export a "fetch handler" — a function that Cloudflare calls when an HTTP request arrives at their network
4. There is no long-running process. There is no process at all in the traditional sense.
5. When a request arrives at a Cloudflare edge location, that location looks at your Worker code
6. It creates a V8 isolate (explained in detail in the next section) just for this request
7. Your fetch() function runs inside that isolate
8. When your function returns a Response, the isolate is destroyed
9. The next request creates a completely new isolate
10. Nothing persists between requests unless you explicitly use a storage service (KV, Durable Objects, R2)
```

The key difference: there is no `app.listen()` because **you are not starting anything**. You are writing a function that the platform calls when it needs to. The platform manages the lifecycle, the scaling, the infrastructure.

This is the same model as serverless functions (AWS Lambda, Google Cloud Functions), but deployed at 330+ locations instead of one region.

### The Critical Misconception

A common thought: "If the isolate is destroyed after each request, doesn't that mean every request is a cold start?"

No. Cloudflare Workers has a **warm start** optimization. When a Worker handles a request, V8 keeps the compiled code in memory for a short time (typically seconds to minutes). If another request for the same Worker arrives quickly, the same isolate is reused. The compiled code is already in memory — the request handler runs immediately.

The difference from Node.js: in Node.js, the *process* is always running. In Workers, the *compiled code* is cached in memory, but the *isolate* may or may not be reused. The platform decides.

```
Cold start:
  Request arrives → no isolate available → V8 creates isolate → loads code → executes handler
  ~5ms on Cloudflare Workers

Warm start:
  Request arrives → isolate available in memory → executes handler directly
  ~0.5ms

Compare to Node.js cold start (for comparison, not relevant to Workers):
  ~50-100ms just for Node.js runtime init
```

---

## Part 2: V8 Isolates

### What V8 Is Actually Doing

V8 is the JavaScript engine that Chrome uses. It compiles JavaScript to machine code, manages memory, runs garbage collection. It's a C++ program that takes JavaScript source code and executes it.

A **V8 isolate** is one instance of the V8 engine. It's a self-contained execution environment with its own heap, its own garbage collector, its own set of compiled functions. An isolate shares nothing with other isolates.

```
One V8 process can contain MULTIPLE isolates:

┌─────────────────────────────────────────┐
│           V8 Process                     │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate A (User request)       │      │
│  │  - Heap: 10MB                  │      │
│  │  - Running: fetch() handler    │      │
│  │  - GC: independent             │      │
│  └────────────────────────────────┘      │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate B (User request)       │      │
│  │  - Heap: 8MB                   │      │
│  │  - Running: fetch() handler    │      │
│  │  - GC: independent             │      │
│  └────────────────────────────────┘      │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate C (Idle, warm)         │      │
│  │  - Heap: 12MB                  │      │
│  │  - Loaded: compiled code       │      │
│  │  - Last used: 2s ago           │      │
│  └────────────────────────────────┘      │
└─────────────────────────────────────────┘
```

Each isolate is sandboxed — it cannot access the memory of other isolates. It cannot access the file system. It cannot open network sockets directly. It can only interact with the outside world through **bindings** that the platform provides (fetch, KV, R2, etc.).

This is fundamentally different from Node.js:

```
Node.js:
  One process per application.
  That process has access to everything: fs, net, process.env, require(), threads.
  Multiple requests share the same process and memory space.

V8 Isolate:
  One isolate per request (or per few requests, if warm).
  That isolate has no access to fs, no net (except fetch), no require() at runtime.
  The isolate is created, your code runs, the isolate is destroyed.
  The platform (Cloudflare) decides when to create and destroy isolates.
```

### The Constraints This Creates

Because isolates are short-lived and sandboxed, certain things are impossible:

1. **No file system.** You cannot read or write files. There is no disk. There is no `/tmp`. If you need persistent storage, you use Cloudflare KV (key-value store), R2 (object storage), or D1 (SQLite database).

2. **No open connections.** You cannot open a raw TCP/UDP socket. You cannot create a WebSocket server. You can only make outbound HTTP calls via `fetch()`.

3. **No process-level state.** You cannot store data in a global variable and expect it to be there on the next request. The isolate might be reused (in which case global variables survive), or it might not. You must assume state is reset on every request, or use explicit storage.

4. **No long-running computations.** Workers have a CPU time limit (30 seconds on the paid plan, 10 seconds on the free plan). If your function uses more CPU than that, the platform terminates it.

5. **Limited memory.** Each Worker gets 128MB. This is the heap size of the isolate. If you allocate more, the isolate is terminated.

### Why This Design Exists

The constraints are not limitations you have to work around — they're the entire point of the architecture. By making isolates stateless, short-lived, and sandboxed, Cloudflare can:

- Run hundreds of Workers from different customers on the same physical machine without them interfering with each other
- Spin up a new isolate in ~5ms because there's no OS to boot, no dependencies to install, no process to fork
- Scale to zero when there's no traffic, because creating an isolate costs nothing until a request arrives
- Move a Worker from one edge location to another without downtime, because there's no persistent state to migrate

This is the "no server" model. Not that there isn't hardware. But there is no process that you manage, no server you SSH into, no daemon you keep alive. You write a function. The platform calls it. The platform handles the rest.

---

## Part 3: What Is Hono and Why Does It Exist?

### The Framework Gap at the Edge

When you write a Cloudflare Worker without a framework, your code looks like this:

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/users" && request.method === "GET") {
      return new Response(JSON.stringify(users), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      return fetch(`https://backend.example.com${url.pathname}`);
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

This works. But as your application grows — 20 routes, 10 middleware functions, error handling, CORS, authentication — this file becomes unmanageable. Every route is a nested if-statement. Every middleware is manually composed.

You could use Express. But Express was designed for Node.js — it assumes a long-running process, it assumes `req` and `res` are Node.js objects, it assumes `app.listen()`. Express does not run on Cloudflare Workers without a compatibility layer that simulates Node.js, which adds overhead and breaks at edge cases.

Hono exists to fill this gap. It provides Express-like routing and middleware in a package that:

1. **Does not require Node.js.** Hono runs on any JavaScript runtime that supports the Web API standard (Request, Response, fetch). This includes Cloudflare Workers, Deno, Bun, and Node.js.

2. **Compiles routes into an efficient trie.** Hono builds a route tree that maps a URL directly to its handler, without iterating through registered routes.

3. **Produces a 15KB bundle.** Hono's tree-shaken bundle is 15KB. Express is ~600KB. On the edge, bundle size matters because it affects cold start time — the platform must load your code over the network before running it.

4. **Uses platform-native objects.** Hono wraps the Web API Request and Response objects directly. Express creates its own `req` and `res` objects with additional methods. On the edge, there's no need for this abstraction — the platform already provides Request and Response.

### Hono's Architecture

**The Router**

When you write this in Express:

```js
app.get("/api/users/:id", handler);
app.post("/api/users", handler);
app.get("/api/users", handler);
```

Express stores these as an array. When a request arrives, Express loops through each entry until it finds a matching route. At N routes, a request takes O(N) time to find its handler.

When you write the same in Hono:

```js
app.get("/api/users/:id", handler);
app.post("/api/users", handler);
app.get("/api/users", handler);
```

Hono compiles these into a **trie** (a prefix tree). Each segment of the path is a node in the tree. When a request arrives, Hono walks the tree segment by segment — `/` → `api` → `users` → `:id`. This takes O(path-length) time, regardless of how many routes are registered.

For 100 routes:
- Express: up to 100 comparisons before finding the right handler
- Hono: exactly the number of path segments (e.g., 4 comparisons for `/api/users/:id`)

For 1000 routes, the difference becomes significant — especially on the edge, where every millisecond of CPU time counts.

**The Context Object**

Express creates `req` and `res` objects with additional methods (`req.params`, `req.query`, `res.json()`). These are created by extending the native Node.js objects, adding methods via prototype chains.

Hono creates a single `Context` object (typically named `c`). This object provides read-only access to the request and methods for constructing the response:

```js
app.get("/api/users/:id", (c) => {
  const id = c.req.param("id");     // path parameter
  const query = c.req.query("page"); // query parameter
  const body = c.req.header("Authorization"); // header
  return c.json({ id });             // JSON response
});
```

The `c.req` is a thin wrapper around the platform's native `Request` object. It doesn't create new objects until you ask for them. If you never call `c.req.param()`, the path isn't parsed.

**Middleware**

Hono middleware is a function that receives the context and a `next` function:

```js
app.use("/api/*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.url} ${c.res.status} ${ms}ms`);
});
```

The middleware calls `await next()` to pass control to the next middleware or route handler. After `next()` returns, the response is available as `c.res`. This is the same pattern as Express, but:

- In Express, middleware often modifies `req` and `res`. In Hono, middleware reads from `c.req` and `c.res`. The context is passed explicitly.
- In Express, middleware that doesn't call `next()` hangs the request. In Hono, the middleware stack has a timeout safety net, but the same principle applies.

**Adapters**

Hono provides adapters for different runtimes:

```js
// Cloudflare Worker
import { Hono } from "hono";
const app = new Hono();
export default app;

// Node.js
import { Hono } from "hono";
import { serve } from "@hono/node-server";
const app = new Hono();
serve(app);

// Bun
import { Hono } from "hono";
const app = new Hono();
export default app;

// Deno
import { Hono } from "hono";
const app = new Hono();
Deno.serve(app.fetch);
```

The same application code runs on all of them. The adapter handles the runtime-specific details (how to start listening, how to receive requests, how to send responses).

### Hono vs Express: The Real Differences

The differences are not about features — Hono supports routing, middleware, error handling, validation, and everything else Express does. The differences are architectural:

```
Startup:
  Express: Requires Node.js runtime initialization (~50ms), creates process,
           binds port, starts event loop. All this happens before any request.
  Hono: No runtime init. No port binding. Code is loaded when the first
        request arrives. The first request pays the compilation cost (~5ms).

Request Lifecycle:
  Express: The same process handles all requests. req and res are created per
           request but share the process heap. Middleware chains are built once.
  Hono: A new isolate may handle each request. Context is created per request.
        Middleware chain is evaluated per request using the compiled trie.

State:
  Express: Global variables persist across requests. In-memory caching works.
  Hono: Global variables may or may not persist (isolate reuse is not guaranteed).
        In-memory caching requires Durable Objects or explicit storage.

Bundle Size:
  Express: ~600KB (includes Node.js-specific code, connect middleware layer,
           route matching utilities, error handling infrastructure)
  Hono: ~15KB (tree-shaken, only includes what you use)

HTTP Objects:
  Express: Uses Node.js IncomingMessage and ServerResponse. Adds methods like
           res.json(), res.send(), res.status() by extending prototypes.
  Hono: Wraps the Web API Request and Response objects. No prototype extension.
        c.json() creates a new Response with JSON body.

Routing:
  Express: Linear search through registered routes. O(n) where n = route count.
           Router and application share the same route array.
  Hono: Trie-based routing. O(path-length). Route groups compile into subtrees.
        Router and application are separate concepts.

Middleware:
  Express: Middleware modifies req/res in-place. Order matters significantly.
           Error middleware must have 4 parameters (err, req, res, next).
  Hono: Middleware receives context and returns Response. Error middleware is
         registered with app.onError(). No signature tricks.
```

### When You Would Still Use Express

Hono is not a replacement for Express in every scenario. Use Express when:

- You are running a long-lived Node.js server that maintains in-memory state (WebSocket connections, server-sent events, in-process caches)
- You depend on npm packages that use Node.js-specific APIs (fs, net, crypto with native bindings)
- Your application spends most of its time in CPU-bound computation and would hit edge CPU time limits

Use Hono when:

- You want to deploy on Cloudflare Workers, Deno, or Bun
- You need low cold-start times
- You want the same codebase to run on edge and Node.js
- You are building an API gateway, proxy, or middleware-heavy application
- You want TypeScript-first development with strong inference

---

## Part 4: Setting Up the Environment

Before building EdgeGate, you need the Cloudflare CLI and a Cloudflare account.

### Installing wrangler

Wrangler is the CLI for deploying Cloudflare Workers.

```bash
npm install -g wrangler
```

Verify the installation:

```bash
wrangler --version
```

### Authenticating with Cloudflare

```bash
wrangler login
```

This opens a browser window asking you to authorize wrangler with your Cloudflare account. You need a Cloudflare account (free tier is sufficient for this project).

### Creating the Project

```bash
mkdir edgegate
cd edgegate
npm init -y
npm install hono
```

### Wrangler Configuration

Create `wrangler.toml` in the project root:

```toml
name = "edgegate"
main = "src/index.ts"
compatibility_date = "2024-12-01"

# KV namespace for rate limiting
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = ""   # You'll create this in a moment

# KV namespace for response caching
[[kv_namespaces]]
binding = "CACHE"
id = ""  # You'll create this in a moment

# Analytics Engine for logging
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "edgegate_logs"
```

Create the KV namespaces:

```bash
wrangler kv:namespace create RATE_LIMIT
# Output: SUCCESS  SUCCESS  Created KV namespace with id: abc123

wrangler kv:namespace create CACHE
# Output: SUCCESS  SUCCESS  Created KV namespace with id: def456
```

Copy the IDs from the output into your `wrangler.toml`.

### Project Structure

```
edgegate/
├── wrangler.toml          # Cloudflare Worker configuration
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Entry point — creates the Hono app
│   ├── middleware/
│   │   ├── rate-limiter.ts # Per-IP rate limiting using KV
│   │   ├── cache.ts        # Response caching at the edge
│   │   └── logger.ts       # Analytics logging
│   ├── routes/
│   │   ├── proxy.ts        # Backend proxy routes
│   │   └── health.ts       # Health check endpoint
│   └── config.ts           # Configuration constants
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

Install the Workers types:

```bash
npm install -D @cloudflare/workers-types
```

---

## Part 5: Building EdgeGate

### Step 1: The Entry Point

The entry point creates the Hono application, registers middleware and routes, and exports the fetch handler that Cloudflare Workers calls.

```typescript
// src/index.ts
import { Hono } from "hono";
import { rateLimiter } from "./middleware/rate-limiter";
import { edgeCache } from "./middleware/cache";
import { requestLogger } from "./middleware/logger";
import { proxyRoutes } from "./routes/proxy";
import { healthRoutes } from "./routes/health";

// Bindings injected by Cloudflare Workers
type Bindings = {
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global middleware (applied to all routes)
app.use("*", requestLogger);
app.use("*", rateLimiter);

// Route groups
app.route("/health", healthRoutes);
app.route("/api", proxyRoutes);

// Error handling
app.onError((err, c) => {
  console.error(`Unhandled error: ${err.message}`);
  return c.json({ error: "Internal Server Error" }, 500);
});

// 404 handling
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

export default app;
```

Key things to understand:

- **`app.use("*", middleware)`** applies middleware to all routes. You can also scope it: `app.use("/api/*", middleware)` applies only to `/api/*` paths.
- **`app.route("/health", healthRoutes)`** mounts the routes from `healthRoutes` under the `/health` prefix. This is how you organize routes into groups.
- **`app.onError()`** catches any error thrown in middleware or route handlers. Without this, an uncaught error returns a generic 500 with no body.
- **`app.notFound()`** catches requests that don't match any registered route.

### Step 2: Configuration

```typescript
// src/config.ts
export const CONFIG = {
  // Rate limiting: maximum requests per IP per window
  rateLimit: {
    maxRequests: 10,
    windowSeconds: 10,
  },

  // Cache: TTL for cached responses
  cache: {
    defaultTTLSeconds: 60,
    // Cache only GET requests to these paths
    cacheablePaths: ["/api/v1", "/api/v2"],
  },

  // Backend origin servers (where proxied requests go)
  origins: {
    v1: "https://jsonplaceholder.typicode.com",
    v2: "https://httpbin.org",
  },
};
```

### Step 3: Rate Limiter Middleware

This is the most important middleware to understand. It tracks how many requests each IP has made within a time window and blocks requests that exceed the limit.

The algorithm is a **sliding window** stored in KV. For each request, we:

1. Extract the client IP from the request headers (Cloudflare sends `CF-Connecting-IP`)
2. Create a KV key for this IP's request count in the current window
3. Read the current count from KV
4. If the count exceeds the limit, return 429
5. Otherwise, increment the count and set a TTL on the KV entry

```typescript
// src/middleware/rate-limiter.ts
import { Context, Next } from "hono";
import { CONFIG } from "../config";

export async function rateLimiter(c: Context, next: Next) {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const now = Math.floor(Date.now() / 1000);
  const windowKey = Math.floor(now / CONFIG.rateLimit.windowSeconds);

  // KV key: ratelimit:{ip}:{window}
  const key = `ratelimit:${ip}:${windowKey}`;

  const kv = c.env.RATE_LIMIT as KVNamespace;
  const currentCount = await kv.get(key);

  if (currentCount) {
    const count = parseInt(currentCount, 10);
    if (count >= CONFIG.rateLimit.maxRequests) {
      return c.json(
        {
          error: "Too Many Requests",
          retryAfter: CONFIG.rateLimit.windowSeconds,
        },
        429,
        {
          "Retry-After": String(CONFIG.rateLimit.windowSeconds),
        }
      );
    }
  }

  // Increment count (atomic operation)
  await kv.put(key, String((parseInt(currentCount || "0", 10) || 0) + 1), {
    expirationTtl: CONFIG.rateLimit.windowSeconds,
  });

  await next();
}
```

Understanding the sliding window:

```
Window size: 10 seconds

Request 1 at T=0s:
  windowKey = floor(0 / 10) = 0
  KV key: ratelimit:1.2.3.4:0
  Count: 1
  TTL: 10s

Request 2 at T=5s:
  windowKey = floor(5 / 10) = 0
  KV key: ratelimit:1.2.3.4:0
  Count: 2

Request 3 at T=11s:
  windowKey = floor(11 / 10) = 1
  KV key: ratelimit:1.2.3.4:1
  Count: 1 (new window, counter reset)
```

The TTL on each KV entry ensures automatic cleanup — old windows expire without manual deletion.

Why KV for rate limiting? KV is globally replicated and fast for small reads. It's not as fast as an in-memory counter, but it works across all edge locations. A purely in-memory counter would work only within a single isolate — different requests to different edge locations would have independent counters.

### Step 4: Response Caching Middleware

The cache middleware intercepts GET requests, checks KV for a cached response, and on a hit returns the cached version instead of proxying to the origin.

```typescript
// src/middleware/cache.ts
import { Context, Next } from "hono";
import { CONFIG } from "../config";

function isCacheable(c: Context): boolean {
  if (c.req.method !== "GET") return false;

  const url = new URL(c.req.url);
  return CONFIG.cache.cacheablePaths.some((path) =>
    url.pathname.startsWith(path)
  );
}

function cacheKey(c: Context): string {
  const url = new URL(c.req.url);
  return `cache:${c.req.method}:${url.pathname}${url.search}`;
}

export async function edgeCache(c: Context, next: Next) {
  if (!isCacheable(c)) {
    await next();
    return;
  }

  const kv = c.env.CACHE as KVNamespace;
  const key = cacheKey(c);

  // Check cache
  const cached = await kv.get(key, { type: "text" });
  if (cached) {
    const { status, headers, body } = JSON.parse(cached);
    headers["X-Cache"] = "HIT";
    return c.newResponse(body, status, headers);
  }

  // Not cached — let the request through
  await next();

  // After the request is handled, cache the response
  if (c.res && c.res.ok) {
    const headers: Record<string, string> = {};
    c.res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const cachedValue = JSON.stringify({
      status: c.res.status,
      headers,
      body: await c.res.clone().text(),
    });

    await kv.put(key, cachedValue, {
      expirationTtl: CONFIG.cache.defaultTTLSeconds,
    });
  }
}
```

The stale-while-revalidate pattern (production addition):

```typescript
// In the "check cache" section:
const cached = await kv.getWithMetadata<{ cachedAt: number }>(key);
if (cached.value) {
  const { status, headers, body } = JSON.parse(cached.value);
  const age = Date.now() - (cached.metadata?.cachedAt || 0);

  // If the cache is expired but still useful, serve it and refresh
  if (age > CONFIG.cache.defaultTTLSeconds * 1000) {
    headers["X-Cache"] = "STALE";
    // Fire-and-forget: refresh cache in background
    ctx.waitUntil(refreshCache(c, kv, key));
  } else {
    headers["X-Cache"] = "HIT";
  }

  return c.newResponse(body, status, headers);
}
```

**Important:** We clone the response before reading its body (`c.res.clone().text()`). A Response body can only be consumed once. If we read it to cache it, the original response body is consumed and can't be sent to the client. Cloning creates a copy.

### Step 5: Analytics Logger Middleware

Cloudflare Workers has Analytics Engine — a service for logging structured events that you can query with SQL.

```typescript
// src/middleware/logger.ts
import { Context, Next } from "hono";

export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const url = c.req.url;
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const userAgent = c.req.header("user-agent") || "unknown";

  await next();

  const status = c.res.status;
  const latency = Date.now() - start;

  // Write to Analytics Engine
  c.env.ANALYTICS.writeDataPoint({
    blobs: [method, url, ip, userAgent],
    doubles: [latency, status],
    indexes: [],
  });
}
```

Analytics Engine is append-only and designed for high throughput. You can query it later:

```sql
SELECT
  blob1 AS method,
  blob2 AS url,
  double1 AS latency
FROM edgegate_logs
WHERE timestamp > NOW() - INTERVAL '1' DAY
ORDER BY double1 DESC
LIMIT 10
```

This query finds the slowest requests in the last 24 hours.

### Step 6: Proxy Routes

The proxy routes forward requests to backend services and return the response.

```typescript
// src/routes/proxy.ts
import { Hono } from "hono";
import { CONFIG } from "../config";

const proxy = new Hono();

// GET /api/v1/users — proxies to JSONPlaceholder
proxy.get("/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v1", "");
  const targetUrl = `${CONFIG.origins.v1}${targetPath}${url.search}`;

  const response = await fetch(targetUrl, {
    headers: c.req.raw.headers,
  });

  // Forward the response with added headers
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  headers.set("X-Upstream", CONFIG.origins.v1);

  return new Response(response.body, {
    status: response.status,
    headers,
  });
});

// GET /api/v2/anything — proxies to httpbin
proxy.get("/v2/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v2", "");
  const targetUrl = `${CONFIG.origins.v2}${targetPath}${url.search}`;

  const response = await fetch(targetUrl, {
    headers: c.req.raw.headers,
  });

  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  headers.set("X-Upstream", CONFIG.origins.v2);

  return new Response(response.body, {
    status: response.status,
    headers,
  });
});

export { proxy as proxyRoutes };
```

The `c.req.raw` gives us the original `Request` object. We forward its headers to the upstream service so the backend receives the original request headers (including authentication, content type, etc.).

The `X-EdgeGate` and `X-Upstream` headers let us verify in the response that it went through our gateway.

### Step 7: Health Check Route

```typescript
// src/routes/health.ts
import { Hono } from "hono";

const health = new Hono();

health.get("/", async (c) => {
  // Check KV connectivity by listing namespaces
  const kvStatus = await checkKV(c);
  // Check upstream reachability
  const upstreamStatus = await checkUpstreams(c);

  const allHealthy = kvStatus && upstreamStatus;

  return c.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      location: c.req.header("cf-ray")?.split("-")[1] || "unknown",
      checks: {
        kv: kvStatus ? "healthy" : "unhealthy",
        upstreams: upstreamStatus ? "healthy" : "unhealthy",
      },
    },
    allHealthy ? 200 : 503
  );
});

async function checkKV(c: any): Promise<boolean> {
  try {
    await c.env.RATE_LIMIT.get("health-check");
    return true;
  } catch {
    return false;
  }
}

async function checkUpstreams(c: any): Promise<boolean> {
  try {
    const resp = await fetch("https://jsonplaceholder.typicode.com/posts/1", {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export { health as healthRoutes };
```

The health check:
- Verifies KV connectivity (if KV is down, rate limiting and caching won't work)
- Verifies upstream service reachability
- Returns the Cloudflare edge location that handled the request (from `cf-ray` header)
- Returns 200 if everything is healthy, 503 if something is degraded

---

## Part 6: Full Code Assembly

Here is the complete `src/index.ts` that ties everything together:

```typescript
import { Hono } from "hono";
import { rateLimiter } from "./middleware/rate-limiter";
import { edgeCache } from "./middleware/cache";
import { requestLogger } from "./middleware/logger";
import { proxyRoutes } from "./routes/proxy";
import { healthRoutes } from "./routes/health";

type Bindings = {
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global middleware (order matters — runs in the order registered)
app.use("*", requestLogger);    // 1. Log every request
app.use("*", rateLimiter);      // 2. Check rate limit
app.use("/api/*", edgeCache);    // 3. Check cache only for API routes

// Route groups
app.route("/health", healthRoutes);
app.route("/api", proxyRoutes);

// Error handler — catches anything thrown in middleware or routes
app.onError((err, c) => {
  console.error(`Unhandled error: ${err.message}`);
  return c.json({ error: "Internal Server Error" }, 500);
});

// 404 handler — catches anything not matched by any route
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

export default app;
```

Middleware runs in the order they're registered with `app.use()`. The logger runs first (so we capture all requests), then the rate limiter (block early), then the cache (serve cached responses before proxying).

---

## Part 7: Running Locally

Before deploying to Cloudflare, you can run the Worker locally using wrangler's dev server.

```bash
wrangler dev
```

This starts a local HTTP server (default: `http://localhost:8787`) that simulates the Cloudflare Workers environment. KV is simulated in local storage. Analytics Engine is a no-op in local mode.

Test each feature:

```bash
# Health check
curl http://localhost:8787/health

# Proxy to JSONPlaceholder (cached after first request)
curl http://localhost:8787/api/v1/posts/1

# Proxy to httpbin
curl http://localhost:8787/api/v2/anything

# 404
curl http://localhost:8787/nonexistent

# Rate limiting (run this 11 times)
for i in $(seq 1 11); do
  curl -s -w "Request $i: HTTP %{http_code}\n" -o /dev/null http://localhost:8787/health
done
```

---

## Part 8: Deploying to Cloudflare

```bash
wrangler deploy
```

Wrangler uploads your compiled code to Cloudflare's network. Within seconds, your Worker is running at all 330+ edge locations.

```bash
# Output example
Successfully published your script to
 https://edgegate.your-subdomain.workers.dev
```

### Custom Domain

To use your own domain:

```bash
wrangler routes add --domain yourdomain.com *.yourdomain.com/api/*
```

Or in `wrangler.toml`:

```toml
routes = [
  { pattern = "yourdomain.com/api/*", zone_name = "yourdomain.com" }
]
```

### Environment Separation

Create separate environments for production and staging:

```toml
[env.staging]
name = "edgegate-staging"
[[env.staging.kv_namespaces]]
binding = "RATE_LIMIT"
id = "staging-kv-id"

[env.production]
name = "edgegate"
[[env.production.kv_namespaces]]
binding = "RATE_LIMIT"
id = "prod-kv-id"
```

Deploy to staging first, verify, then deploy to production:

```bash
wrangler deploy --env staging
wrangler deploy --env production
```

---

## Part 9: Benchmarking

Here's how to verify that the edge deployment actually improves performance.

### Measure Cold vs Warm Start

```bash
# Cold start (first request after a period of inactivity)
curl -w "\nTime: %{time_total}s\n" -o /dev/null -s https://edgegate.workers.dev/health

# Warm start (immediately after)
curl -w "\nTime: %{time_total}s\n" -o /dev/null -s https://edgegate.workers.dev/health
```

On the first request, the Worker might pay a cold start penalty (~5ms). Subsequent requests should be faster (~1ms regional latency).

### Measure Cache Performance

```bash
# First request — cache miss
curl -w "Time: %{time_total}s\n" -o /dev/null -s \
  https://edgegate.workers.dev/api/v1/posts/1

# Second request — cache hit
curl -w "Time: %{time_total}s\n" -o /dev/null -s \
  https://edgegate.workers.dev/api/v1/posts/1
```

The second request should be noticeably faster because the response is served from KV instead of proxied to the upstream.

### Measure Rate Limiting

```bash
# Run 11 requests — the 11th should be blocked
for i in $(seq 1 11); do
  curl -s -w "%{http_code}\n" -o /dev/null \
    https://edgegate.workers.dev/health
done
# Output:
# 200 (x10)
# 429
```

### Global Latency Testing

Use a tool like `webpagetest.org` or `catchpoint.com` to test from multiple regions. Or use `curl` from different cloud providers:

```bash
# From a US East VM
curl -w "US East: %{time_total}s\n" -o /dev/null -s \
  https://edgegate.workers.dev/health

# From a Europe West VM (simulate with a VPN or different cloud region)
curl -w "Europe: %{time_total}s\n" -o /dev/null -s \
  https://edgegate.workers.dev/health
```

With Cloudflare Workers, the response time from Europe and US East should be within a few milliseconds of each other — the code runs at the edge nearest to the user, not at a central server.

---

## Part 10: Production Considerations

### What EdgeGate Is Missing

EdgeGate is a working API gateway, but for production use, you would add:

1. **Authentication middleware** — Validate JWT tokens, API keys, or OAuth before forwarding requests.
2. **Request validation** — Validate request bodies against schemas (Zod, JSON Schema) before proxying.
3. **Circuit breaker** — If an upstream service is failing, stop routing traffic to it and return a cached or degraded response.
4. **Metrics dashboard** — Cloudflare's Analytics Engine data can be visualized with Grafana or a custom dashboard.
5. **Graceful degradation** — When KV is slow or failing, skip caching instead of failing the request.

### KV Limitations for Production

KV is not ideal for high-frequency rate limiting in production:

- KV has eventual consistency (up to 60 seconds for strong consistency)
- KV throughput is limited per namespace (1000 reads/second per namespace on the free plan)
- For production rate limiting, consider Durable Objects (strongly consistent, single-node coordination) or a dedicated rate limiting service

EdgeGate's KV-based rate limiter works for demonstration and low-traffic use cases. For production, replace it with Durable Objects:

```typescript
// DO-based rate limiter (sketch)
export class RateLimiter extends DurableObject {
  state: Map<string, number[]>;

  async request(ip: string): Promise<boolean> {
    const now = Date.now();
    const window = 10_000; // 10 seconds

    let timestamps = this.state.get(ip) || [];
    timestamps = timestamps.filter(t => now - t < window);

    if (timestamps.length >= 10) {
      return false; // blocked
    }

    timestamps.push(now);
    this.state.set(ip, timestamps);
    return true; // allowed
  }
}
```

### Caching Strategy: What to Cache and What Not To

EdgeGate caches every GET response to `/api/v1/*` and `/api/v2/*`. In production:

- **Cache public responses** (public data that doesn't change per user)
- **Never cache private data** (user-specific responses, authentication errors)
- **Use short TTLs** for dynamic data (seconds to minutes)
- **Use long TTLs** for static data (hours to days)
- **Skip caching for large bodies** (KV has a 25MB limit per value)

---

## Part 11: Understanding What You Built

You now have an API gateway running on 330+ servers worldwide. Let's trace what happens on every request:

```
1. User sends HTTP request to edgegate.workers.dev

2. DNS resolves to the nearest Cloudflare edge location
   (Tokyo if the user is in Japan, London if in the UK, etc.)

3. The edge location receives the request and looks up:
   "Is there a Worker deployed at this route?"
   → Yes, edgegate.workers.dev has a Worker

4. The edge location checks for a warm V8 isolate:
   → Warm: uses the cached isolate (code already compiled)
   → Cold: creates a new isolate, compiles the code (~5ms)

5. The Worker's fetch handler receives the request:
   Hono's routing trie matches the path to a handler

6. Middleware runs in order:
   6a. Logger: records start time, method, URL, IP
   6b. Rate Limiter: reads KV entry for this IP's window
       → If count exceeds limit, returns 429 immediately
       → Otherwise, increments counter and continues
   6c. Cache: checks KV for a cached response
       → If cache HIT, returns cached response immediately
       → If cache MISS, continues to the route handler

7. Route handler runs:
   → Proxy: fetches from upstream (JSONPlaceholder or httpbin)
   → Health: returns health status

8. Response flows back through middleware:
   Cache middleware: if the response was cacheable, stores it in KV
   Logger: records status code, latency, writes to Analytics Engine

9. The Response is returned to the edge location

10. The edge location sends the response to the user
```

Total time from user request to user response: typically 10-50ms, depending on cache hit status and upstream latency.

---

## Key Takeaways

**The edge model** is not about "no servers." It's about code that runs at 330+ locations worldwide, in stateless V8 isolates that are created per request and destroyed when the request ends. There is no `app.listen()` because you aren't starting a process — you're exporting a function for the platform to call.

**V8 isolates** are sandboxed JavaScript execution environments within a single V8 process. Each isolate has its own heap, its own garbage collector, and cannot access other isolates' memory. They're stateless, short-lived, and constrained — no file system, no network sockets, limited CPU time. These constraints enable the platform to scale to zero, start in milliseconds, and run code from multiple customers on the same machine safely.

**Hono** is a framework designed for this environment. It provides Express-like routing and middleware but compiles routes into a trie (O(path-length) matching instead of O(n)), uses the platform's native Request/Response objects, bundles to 15KB instead of 600KB, and runs on any runtime that supports the Web API standard.

**EdgeGate** is a real API gateway that uses Hono's routing, middleware, and context to proxy requests, rate-limit per IP, cache responses, and log analytics — all running at the edge. The KV-based rate limiter and cache demonstrate the tradeoffs of edge storage: globally replicated but eventually consistent.

### Resources

- [Hono Documentation](https://hono.dev/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [WinterCG Specification](https://wintercg.org/) — the web-interoperable runtime standard that Hono targets
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)
- [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
